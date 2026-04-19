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
      userPrompt: 'What skills do you have?',
      expectedEvents: turn1ExpectedEvents as Event[],
    },
    {
      userPrompt: 'Load the gws-calendar skill.',
      expectedEvents: turn2ExpectedEvents as Event[],
    },
    {
      userPrompt: 'Show me the 3p updates guideline from internal-comms.',
      expectedEvents: turn3ExpectedEvents as Event[],
    },
    {
      userPrompt:
        'Show me the company newsletter guideline from internal-comms.',
      expectedEvents: turn4ExpectedEvents as Event[],
    },
  ],
  modelResponses: modelResponses as RawGenerateContentResponse[],
};

describe('Agent with file-loaded skills', () => {
  it('should process model response and produce events', async () => {
    await runTestCase(testCase);
  });
});
