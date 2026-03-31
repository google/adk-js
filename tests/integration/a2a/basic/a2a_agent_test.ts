/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event, RemoteA2AAgent} from '@google/adk';
import * as path from 'node:path';
import {afterAll, beforeAll, describe, it} from 'vitest';
import {AdkTsApiServer} from '../../test_api_server.js';
import {runTestCase} from '../../test_case_utils.js';
import turn1ExpectedEvents from './events_turn_1.json' with {type: 'json'};
import turn2ExpectedEvents from './events_turn_2.json' with {type: 'json'};

describe('A2A: Remote Agent Basic', () => {
  let server: AdkTsApiServer;

  beforeAll(async () => {
    server = new AdkTsApiServer({
      agentsDir: path.join(__dirname, 'remote_a2a/'),
      a2a: true,
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('Should connect to remote agent and execute 2 user prompts', async () => {
    const remoteA2AAgent = new RemoteA2AAgent({
      name: 'remote_a2a_agent',
      description:
        'Helpful assistant that can roll dice and check if numbers are prime.',
      agentCard: `${server.url}/a2a/weather_time_agent/`,
    });

    await runTestCase({
      agent: remoteA2AAgent,
      turns: [
        {
          userPrompt: 'What is the weather like in New York?',
          expectedEvents: turn1ExpectedEvents as Event[],
        },
        {
          userPrompt: 'What time is it in New York?',
          expectedEvents: turn2ExpectedEvents as Event[],
        },
      ],
    });
  });
});
