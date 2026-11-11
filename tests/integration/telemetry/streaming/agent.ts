/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type LlmAgent} from '@google/adk';

import {
  buildTestAgent,
  FIRST_TURN_USAGE,
  makePartResponse,
  ScriptedModel,
  type ScriptedTurn,
  SECOND_TURN_USAGE,
  TOOL_ARGS,
  TOOL_NAME,
} from '../telemetry_test_utils.js';

export const STREAMED_TEXT_CHUNKS = ['text ', 'response'] as const;

/**
 * Builds `some_root_agent` configured with chunked streaming responses.
 */
export function createStreamingAgent(): LlmAgent {
  const streamingTurns: ScriptedTurn[] = [
    [
      makePartResponse({
        part: {functionCall: {name: TOOL_NAME, args: {...TOOL_ARGS}}},
        usageMetadata: FIRST_TURN_USAGE,
        partial: false,
        turnComplete: true,
      }),
    ],
    STREAMED_TEXT_CHUNKS.map((chunk, index) =>
      makePartResponse({
        part: {text: chunk},
        usageMetadata: SECOND_TURN_USAGE,
        partial: index < STREAMED_TEXT_CHUNKS.length - 1,
        turnComplete: index === STREAMED_TEXT_CHUNKS.length - 1,
      }),
    ),
  ];
  return buildTestAgent(new ScriptedModel(streamingTurns));
}
