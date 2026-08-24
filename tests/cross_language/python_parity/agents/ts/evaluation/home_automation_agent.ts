/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/evaluation/home_automation_agent.
 *
 * A small home-automation agent shared by the evaluation samples.
 *
 * All tools are deterministic (backed by in-memory dicts) so that eval
 * trajectories are reproducible. `resetData()` is the counterpart of the
 * Python sample's `reset_data()`, which `adk eval` calls to reset state
 * between eval cases — adk-js has no `adk eval`, so nothing calls it here,
 * but it is kept so the module has the same shape.
 *
 * Ported as literally as the two APIs allow: same tool names, same parameter
 * names, same instruction and description, same seed data and same message
 * strings.
 */
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

interface DeviceInfo {
  status: string;
  location: string;
}

let devices: Record<string, DeviceInfo> = {};
let temperatures: Record<string, number> = {};

/** Resets in-memory state. Called by adk eval between eval cases. */
export function resetData(): void {
  devices = {
    device_1: {status: 'ON', location: 'Living Room'},
    device_2: {status: 'OFF', location: 'Bedroom'},
    device_3: {status: 'OFF', location: 'Kitchen'},
  };
  temperatures = {'Living Room': 22, Bedroom: 20, Kitchen: 24};
}

// Initialize module-level state at import time.
resetData();

const getDeviceInfo = new FunctionTool({
  name: 'get_device_info',
  description:
    'Returns the status and location of a device, or an error string.',
  parameters: z.object({
    device_id: z.string(),
  }),
  execute: ({device_id: deviceId}) =>
    devices[deviceId] ?? {error: 'Device not found'},
});

const setDeviceInfo = new FunctionTool({
  name: 'set_device_info',
  description: "Sets a device status to 'ON' or 'OFF'.",
  parameters: z.object({
    device_id: z.string(),
    status: z.string(),
  }),
  execute: ({device_id: deviceId, status}) => {
    if (!(deviceId in devices)) {
      return 'Device not found';
    }
    devices[deviceId].status = status;
    return `Device ${deviceId} is now ${status}.`;
  },
});

const getTemperature = new FunctionTool({
  name: 'get_temperature',
  description: 'Returns the current temperature (Celsius) of a location.',
  parameters: z.object({
    location: z.string(),
  }),
  execute: ({location}) => {
    if (!(location in temperatures)) {
      return 'Location not found';
    }
    return `${temperatures[location]}`;
  },
});

const setTemperature = new FunctionTool({
  name: 'set_temperature',
  description: `Sets the target temperature (Celsius) for a location.

Acceptable range is 18-30 Celsius. Do not call this tool with a value
outside that range.`,
  parameters: z.object({
    location: z.string(),
    temperature: z.number(),
  }),
  execute: ({location, temperature}) => {
    if (!(location in temperatures)) {
      return 'Location not found';
    }
    temperatures[location] = temperature;
    return `Temperature in ${location} set to ${temperature}C.`;
  },
});

const listDevices = new FunctionTool({
  name: 'list_devices',
  description: 'Lists devices, optionally filtered by status and/or location.',
  parameters: z.object({
    status: z.string().default(''),
    location: z.string().default(''),
  }),
  execute: ({status, location}) => {
    const result: Array<{device_id: string} & DeviceInfo> = [];
    for (const [deviceId, info] of Object.entries(devices)) {
      if (
        (!status || info.status === status) &&
        (!location || info.location === location)
      ) {
        result.push({device_id: deviceId, ...info});
      }
    }
    return result;
  },
});

export const rootAgent = new LlmAgent({
  name: 'home_automation_agent',
  model: PARITY_MODEL,
  description: 'Controls smart-home devices and temperature.',
  instruction:
    'You are a home-automation assistant. Use the available tools to' +
    ' inspect and control devices and temperatures. When the user asks to' +
    ' change something, call the matching tool, then confirm the result in' +
    ' one short sentence. If the user asks to set a temperature outside the' +
    ' safe range of 18-30 Celsius, refuse and do not call the tool.',
  tools: [
    getDeviceInfo,
    setDeviceInfo,
    getTemperature,
    setTemperature,
    listDevices,
  ],
});
