/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent} from '@google/adk';

import {
  AGENT_DESCRIPTION,
  AGENT_NAME,
  BASE_INSTRUCTION,
  FINAL_TEXT,
  FIRST_TURN_USAGE,
  makePartResponse,
  ScriptedModel,
  type ScriptedTurn,
  SECOND_TURN_USAGE,
} from '../telemetry_test_utils.js';

export const SPECIALIST_AGENT_NAME = 'some_specialist_agent';
export const SPECIALIST_AGENT_DESCRIPTION = 'A sample specialist agent.';

/**
 * Builds the root agent transferring to `some_specialist_agent`.
 */
export function createMultiAgent(): LlmAgent {
  const turns: ScriptedTurn[] = [
    makePartResponse({
      part: {
        functionCall: {
          name: 'transfer_to_agent',
          args: {agent_name: SPECIALIST_AGENT_NAME},
        },
      },
      usageMetadata: FIRST_TURN_USAGE,
    }),
    makePartResponse({
      part: {text: FINAL_TEXT},
      usageMetadata: SECOND_TURN_USAGE,
    }),
  ];
  const model = new ScriptedModel(turns);
  const specialist = new LlmAgent({
    name: SPECIALIST_AGENT_NAME,
    description: SPECIALIST_AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
  });
  return new LlmAgent({
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
    subAgents: [specialist],
  });
}
