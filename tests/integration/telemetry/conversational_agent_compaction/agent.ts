/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  type Event,
  LlmAgent,
  LlmSummarizer,
  TokenBasedContextCompactor,
} from '@google/adk';

import {
  AGENT_DESCRIPTION,
  AGENT_NAME,
  BASE_INSTRUCTION,
  buildSampleTool,
  buildToolCallingTurns,
  makePartResponse,
  ScriptedModel,
  type TelemetryTestCase,
} from '../telemetry_test_utils.js';

export type CompactionSetup = 'token_threshold' | 'untriggered';

export const COMPACTION_APP_NAME = 'compaction_app';
export const COMPACTION_USER_ID = 'compaction_user';
export const COMPACTION_SUMMARY = 'a summary of the earlier turns';
export const COMPACTION_SEEDED_INVOCATION_COUNT = 3;
export const COMPACTION_TOKEN_THRESHOLD = 300;
export const COMPACTION_SEEDED_PROMPT_TOKEN_COUNT = 500;
export const COMPACTION_UNREACHABLE_TOKEN_THRESHOLD = 1_000_000;

/**
 * Extended test case for context compaction scenarios.
 */
export interface CompactionTelemetryTestCase extends TelemetryTestCase {
  readonly compactionSetup: CompactionSetup;
}

export const COMPACTION_TEST_CASES: readonly CompactionTelemetryTestCase[] = [
  {
    testId: 'token-threshold',
    captureContent: 'false',
    experimentalTelemetry: true,
    compactionSetup: 'token_threshold',
  },
  {
    testId: 'untriggered',
    captureContent: 'false',
    experimentalTelemetry: true,
    compactionSetup: 'untriggered',
  },
  {
    testId: 'no-experimental-telemetry',
    captureContent: 'false',
    experimentalTelemetry: false,
    compactionSetup: 'token_threshold',
  },
];

/**
 * Builds the seeded session history for compaction scenarios.
 */
export function buildSeededCompactionHistory(): Event[] {
  const events: Event[] = [];
  for (let index = 0; index < COMPACTION_SEEDED_INVOCATION_COUNT; index += 1) {
    const invocationId = `seeded-invocation-${index}`;
    events.push(
      createEvent({
        timestamp: index * 2 + 1,
        invocationId,
        author: 'user',
        content: {
          role: 'user',
          parts: [{text: `question ${index}`}],
        },
      }),
    );
    events.push(
      createEvent({
        timestamp: index * 2 + 2,
        invocationId,
        author: AGENT_NAME,
        content: {
          role: 'model',
          parts: [{text: `answer ${index}`}],
        },
        usageMetadata: {
          promptTokenCount: COMPACTION_SEEDED_PROMPT_TOKEN_COUNT,
        },
      }),
    );
  }
  return events;
}

function buildTokenCompactor(
  setup: CompactionSetup,
): TokenBasedContextCompactor {
  const summarizerModel = new ScriptedModel([
    makePartResponse({
      part: {text: COMPACTION_SUMMARY},
      usageMetadata: {},
    }),
  ]);
  const summarizer = new LlmSummarizer({llm: summarizerModel});
  const tokenThreshold =
    setup === 'token_threshold'
      ? COMPACTION_TOKEN_THRESHOLD
      : COMPACTION_UNREACHABLE_TOKEN_THRESHOLD;
  return new TokenBasedContextCompactor({
    tokenThreshold,
    eventRetentionSize: 1,
    summarizer,
  });
}

/**
 * Builds the `some_root_agent` configured with a {@link TokenBasedContextCompactor}.
 */
export function createCompactionAgent(
  tc: CompactionTelemetryTestCase,
): LlmAgent {
  const model = new ScriptedModel(buildToolCallingTurns());
  const compactor = buildTokenCompactor(tc.compactionSetup);
  return new LlmAgent({
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
    tools: [buildSampleTool()],
    contextCompactors: [compactor],
  });
}
