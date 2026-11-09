/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type LlmAgent} from '@google/adk';
import {ApiError, type GroundingMetadata} from '@google/genai';

import {
  buildTestAgent,
  buildToolCallingTurns,
  EXPERIMENTAL_OPT_IN,
  ScriptedModel,
  SEMCONV_TEST_CASES,
  type TelemetryTestCase,
  TOOL_ERROR,
} from '../telemetry_test_utils.js';

export const GROUNDING_METADATA: GroundingMetadata = {
  webSearchQueries: ['adk release', 'google-adk pypi'],
  groundingChunks: [
    {web: {uri: 'https://a.test/1', title: 'A'}},
    {web: {uri: 'https://b.test/2', title: 'B'}},
  ],
};

export const RESOURCE_EXHAUSTED_ERROR = new ApiError({
  message: 'RESOURCE_EXHAUSTED',
  status: 429,
});

export const MODEL_VALUE_ERROR = new Error('boom');

/**
 * Extended test case for the single-agent scenario.
 */
export interface AgentTelemetryTestCase extends TelemetryTestCase {
  readonly grounding?: boolean;
  readonly modelException?: Error;
  readonly toolException?: Error;
}

export const AGENT_TEST_CASES: readonly AgentTelemetryTestCase[] = [
  ...SEMCONV_TEST_CASES,
  {
    testId: 'experimental-telemetry-no-capture',
    captureContent: 'false',
    experimentalTelemetry: true,
  },
  {
    testId: 'grounding',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'span_and_event',
    experimentalTelemetry: true,
    grounding: true,
  },
  {
    testId: 'inference-error-resource-exhausted',
    captureContent: 'false',
    modelException: RESOURCE_EXHAUSTED_ERROR,
    expectError: true,
  },
  {
    testId: 'inference-error-valueerror',
    captureContent: 'false',
    modelException: MODEL_VALUE_ERROR,
    expectError: true,
  },
  {
    testId: 'inference-error-valueerror-span-and-event',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'span_and_event',
    modelException: MODEL_VALUE_ERROR,
    expectError: true,
  },
  {
    testId: 'tool-error-valueerror',
    captureContent: 'false',
    toolException: TOOL_ERROR,
    expectError: true,
  },
  {
    testId: 'tool-error-valueerror-span-only',
    captureContent: 'span_only',
    toolException: TOOL_ERROR,
    expectError: true,
  },
];

/**
 * Builds the `some_root_agent` instance configured for `tc`.
 */
export function createAgent(tc: AgentTelemetryTestCase): LlmAgent {
  const model = new ScriptedModel(
    buildToolCallingTurns({
      groundingMetadata: tc.grounding ? GROUNDING_METADATA : undefined,
      modelException: tc.modelException,
    }),
  );
  return buildTestAgent(model, tc.toolException);
}
