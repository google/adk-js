/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Attributes, Histogram} from '@opentelemetry/api';

import type {Totals} from '../common/accumulators.js';
import {ERROR_TYPE_ATTR, GenAiAttr} from '../common/attributes.js';
import {
  isExperimentalFeatureEnabled,
  type ResolvedTelemetryConfig,
} from '../common/config.js';
import {
  cachedInstruments,
  CALL_COUNT_BUCKETS,
  createHistogram,
  createTokenHistograms,
  recordTokenHistograms,
  type TokenHistograms,
} from './meters.js';

const PER_INVOCATION = 'one agent invocation';

/** Advisory bucket boundaries for `gen_ai.invoke_agent.duration`. */
export const AGENT_DURATION_BUCKETS: readonly number[] = Object.freeze([
  0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2, 102.4, 204.8, 409.6,
]);

interface AgentInstruments {
  readonly duration: Histogram;
  readonly inferenceCalls: Histogram;
  readonly toolCalls: Histogram;
  readonly skillLoads: Histogram;
  readonly tokens: TokenHistograms;
}

const getAgentInstruments = cachedInstruments((meter): AgentInstruments => ({
  duration: createHistogram({
    meter,
    name: 'gen_ai.invoke_agent.duration',
    unit: 's',
    description: 'Duration of agent invocations.',
    buckets: AGENT_DURATION_BUCKETS,
  }),
  inferenceCalls: createHistogram({
    meter,
    name: 'gen_ai.invoke_agent.inference_calls',
    unit: '1',
    description: 'Number of inference (model) calls per agent invocation.',
    buckets: CALL_COUNT_BUCKETS,
  }),
  toolCalls: createHistogram({
    meter,
    name: 'gen_ai.invoke_agent.tool_calls',
    unit: '1',
    description: 'Number of tool calls per agent invocation.',
    buckets: CALL_COUNT_BUCKETS,
  }),
  skillLoads: createHistogram({
    meter,
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

/** Parameters for {@link recordAgentDuration}. */
export interface RecordAgentDurationParams {
  readonly agentName: string;
  readonly durationSeconds: number;
  readonly errorType?: string;
}

/** Records `gen_ai.invoke_agent.duration` at the end of an agent invocation. */
export function recordAgentDuration({
  agentName,
  durationSeconds,
  errorType,
}: RecordAgentDurationParams): void {
  const attributes: Attributes = {
    [GenAiAttr.AGENT_NAME]: agentName,
    ...(errorType === undefined ? {} : {[ERROR_TYPE_ATTR]: errorType}),
  };
  getAgentInstruments().duration.record(durationSeconds, attributes);
}

/** Parameters for {@link recordAgentTotals}. */
export interface RecordAgentTotalsParams {
  readonly agentName: string;
  readonly totals: Totals;
  readonly config: ResolvedTelemetryConfig;
}

/**
 * Records the per-agent call, skill-load, and token totals accumulated over
 * one agent invocation.
 */
export function recordAgentTotals({
  agentName,
  totals,
  config,
}: RecordAgentTotalsParams): void {
  const instruments = getAgentInstruments();
  const attributes: Attributes = {
    [GenAiAttr.AGENT_NAME]: agentName,
  };
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
