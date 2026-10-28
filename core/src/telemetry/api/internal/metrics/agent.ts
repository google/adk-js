/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Attributes} from '@opentelemetry/api';

import type {Totals} from '../common/accumulators.js';
import {ERROR_TYPE_ATTR, GenAiAttr} from '../common/attributes.js';
import {
  isExperimentalFeatureEnabled,
  type ResolvedTelemetryConfig,
} from '../common/config.js';
import {
  CALL_COUNT_BUCKETS,
  cachedInstruments,
  createHistogram,
  createTokenHistograms,
  recordTokenHistograms,
} from './meters.js';

const PER_INVOCATION = 'one agent invocation';

const getInstruments = cachedInstruments((meter) => ({
  duration: createHistogram(meter, {
    name: 'gen_ai.invoke_agent.duration',
    unit: 's',
    description: 'Duration of agent invocations.',
    buckets: [
      0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2, 102.4, 204.8, 409.6,
    ],
  }),
  inferenceCalls: createHistogram(meter, {
    name: 'gen_ai.invoke_agent.inference_calls',
    unit: '1',
    description: 'Number of inference (model) calls per agent invocation.',
    buckets: CALL_COUNT_BUCKETS,
  }),
  toolCalls: createHistogram(meter, {
    name: 'gen_ai.invoke_agent.tool_calls',
    unit: '1',
    description: 'Number of tool calls per agent invocation.',
    buckets: CALL_COUNT_BUCKETS,
  }),
  skillLoads: createHistogram(meter, {
    name: 'adk.experimental.invoke_agent.skill.loads',
    unit: '1',
    description: `Number of skill loads over ${PER_INVOCATION}.`,
    buckets: CALL_COUNT_BUCKETS,
  }),
  tokens: createTokenHistograms(
    meter,
    'adk.experimental.invoke_agent',
    PER_INVOCATION,
  ),
}));

/** Parameters for {@link recordAgentMetrics}. */
export interface AgentMetricsParams {
  readonly agentName: string;
  readonly elapsedSeconds: number;
  /** The type of the error the invocation failed with, if it failed. */
  readonly errorType?: string;
  /** What the invocation's own model and tool calls added up to. */
  readonly totals: Totals;
  readonly config: ResolvedTelemetryConfig;
}

/**
 * Records one agent invocation: its duration, its call counts, and, when
 * enabled, its skill loads and token totals.
 *
 * Call counts are recorded even when zero, which is a real measurement. Token
 * totals are skipped when no call reported usage, which is not.
 */
export function recordAgentMetrics({
  agentName,
  elapsedSeconds,
  errorType,
  totals,
  config,
}: AgentMetricsParams): void {
  const instruments = getInstruments();
  const attributes: Attributes = {[GenAiAttr.AGENT_NAME]: agentName};
  instruments.duration.record(elapsedSeconds, {
    ...attributes,
    ...(errorType === undefined ? {} : {[ERROR_TYPE_ATTR]: errorType}),
  });
  if (
    totals.tokens !== undefined &&
    isExperimentalFeatureEnabled(config, 'token_usage')
  ) {
    recordTokenHistograms(instruments.tokens, totals.tokens, attributes);
  }
  instruments.inferenceCalls.record(totals.inferenceCalls, attributes);
  instruments.toolCalls.record(totals.toolCalls, attributes);
  if (isExperimentalFeatureEnabled(config, 'skills')) {
    instruments.skillLoads.record(totals.skillLoads, attributes);
  }
}
