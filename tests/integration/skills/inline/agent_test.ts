/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '@google/adk';
import {describe, it} from 'vitest';
import {
  RawGenerateContentResponse,
  runTestCase,
} from '../../test_case_utils.js';
import {rootAgent} from './agent.js';
import turn1ExpectedEvents from './events_turn_1.json' with {type: 'json'};
import turn2ExpectedEvents from './events_turn_2.json' with {type: 'json'};
import turn3ExpectedEvents from './events_turn_3.json' with {type: 'json'};
import turn4ExpectedEvents from './events_turn_4.json' with {type: 'json'};
import modelResponses from './model_responses.json' with {type: 'json'};

const testCase = {
  agent: rootAgent,
  turns: [
    {
      userPrompt: 'Hello, what can you do?',
      expectedEvents: turn1ExpectedEvents as Event[],
    },
    {
      userPrompt: 'Please load the weather skill.',
      expectedEvents: turn2ExpectedEvents as Event[],
    },
    {
      userPrompt: 'What is the current weather like in San Francisco, CA?',
      expectedEvents: turn3ExpectedEvents as Event[],
    },
    {
      userPrompt:
        'What is weather now in Irvine, CA? I want to know some details as well, like wind speed and humidity.',
      expectedEvents: turn4ExpectedEvents as Event[],
    },
  ],
  modelResponses: modelResponses as RawGenerateContentResponse[],
};

describe('Agent with skills defined inline', () => {
  it('should process model response and produce events', async () => {
    await runTestCase(testCase);
  });
});
