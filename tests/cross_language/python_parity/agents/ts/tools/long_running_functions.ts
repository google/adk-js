/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/tools/long_running_functions.
 *
 * The point of the sample is the tool being marked long-running: both
 * runtimes must surface the call id in the event's long-running tool ids so a
 * caller can post a later result for it.
 */
import {LlmAgent, LongRunningFunctionTool} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const exportData = new LongRunningFunctionTool({
  name: 'export_data',
  description: 'Exports user data.',
  parameters: z.object({
    export_type: z
      .string()
      .describe("The type of data to export (e.g., 'csv', 'json')."),
  }),
  // In a real application, this would kick off a background job.
  // Here we just return a status.
  execute: ({export_type}) => ({
    status: 'in-progress',
    progress: '0%',
    message: `Exporting ${export_type} data. This may take some time.`,
  }),
});

export const rootAgent = new LlmAgent({
  name: 'long_running_functions',
  model: PARITY_MODEL,
  instruction: `
    You are an assistant that can export user data.
    When the user asks to export data, call the \`export_data\` tool.
    `,
  tools: [exportData],
});
