/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Attributes, Histogram} from '@opentelemetry/api';

import type {Totals} from '../common/accumulators.js';
import {AdkAttr, ERROR_TYPE_ATTR, GenAiAttr} from '../common/attributes.js';
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

const PER_WORKFLOW =
  'one workflow invocation, across every agent that ran in it';

interface WorkflowInstruments {
  readonly duration: Histogram;
  readonly inferenceCalls: Histogram;
  readonly toolCalls: Histogram;
  readonly skillLoads: Histogram;
  readonly compactions: Histogram;
  readonly tokens: TokenHistograms;
}

const getWorkflowInstruments = cachedInstruments(
  (meter): WorkflowInstruments => ({
    duration: createHistogram({
      meter,
      name: 'gen_ai.invoke_workflow.duration',
      unit: 's',
      description: 'Duration of workflow invocations.',
    }),
    inferenceCalls: createHistogram({
      meter,
      name: 'adk.experimental.invoke_workflow.inference_calls',
      unit: '1',
      description: `Number of inference (model) calls over ${PER_WORKFLOW}.`,
      buckets: CALL_COUNT_BUCKETS,
    }),
    toolCalls: createHistogram({
      meter,
      name: 'adk.experimental.invoke_workflow.tool_calls',
      unit: '1',
      description:
        `Number of tool calls over ${PER_WORKFLOW}. Includes the` +
        ' `transfer_to_agent` calls that route between them.',
      buckets: CALL_COUNT_BUCKETS,
    }),
    skillLoads: createHistogram({
      meter,
      name: 'adk.experimental.invoke_workflow.skill.loads',
      unit: '1',
      description: `Number of skill loads over ${PER_WORKFLOW}.`,
      buckets: CALL_COUNT_BUCKETS,
    }),
    compactions: createHistogram({
      meter,
      name: 'adk.experimental.invoke_workflow.compactions',
      unit: '1',
      description:
        `Number of conversation compactions over ${PER_WORKFLOW}. Counts` +
        ' every summary produced, including one the runner then discards' +
        ' because a newer turn changed the session meanwhile. Recorded whether' +
        ' or not the workflow compacted, so the share of turns that do is' +
        ' readable off the unnested datapoints.',
      buckets: CALL_COUNT_BUCKETS,
    }),
    tokens: createTokenHistograms(
      meter,
      'adk.experimental.invoke_workflow',
      PER_WORKFLOW,
    ),
  }),
);

/** Parameters for {@link recordWorkflowDuration}. */
export interface RecordWorkflowDurationParams {
  readonly workflowName: string;
  readonly durationSeconds: number;
  readonly nested: boolean;
  readonly errorType?: string;
}

/**
 * Records `gen_ai.invoke_workflow.duration` at the end of a workflow
 * invocation.
 */
export function recordWorkflowDuration({
  workflowName,
  durationSeconds,
  nested,
  errorType,
}: RecordWorkflowDurationParams): void {
  const attributes: Attributes = {
    [GenAiAttr.OPERATION_NAME]: 'invoke_workflow',
    ...(nested ? {[GenAiAttr.WORKFLOW_NESTED]: true} : {}),
    ...(errorType === undefined ? {} : {[ERROR_TYPE_ATTR]: errorType}),
    ...(workflowName ? {[GenAiAttr.WORKFLOW_NAME]: workflowName} : {}),
  };
  getWorkflowInstruments().duration.record(durationSeconds, attributes);
}

/** Parameters for {@link recordWorkflowTotals}. */
export interface RecordWorkflowTotalsParams {
  readonly rootAgentName: string;
  readonly workflowName: string;
  readonly nested: boolean;
  readonly totals: Totals;
  readonly config: ResolvedTelemetryConfig;
}

/**
 * Records the inclusive call, skill-load, compaction, and token totals for one
 * workflow invocation when the `workflow` experimental feature is enabled.
 */
export function recordWorkflowTotals({
  rootAgentName,
  workflowName,
  nested,
  totals,
  config,
}: RecordWorkflowTotalsParams): void {
  if (!isExperimentalFeatureEnabled(config, 'workflow')) {
    return;
  }
  const instruments = getWorkflowInstruments();
  const attributes: Attributes = {
    [AdkAttr.EXPERIMENTAL_ROOT_AGENT_NAME]: rootAgentName,
    ...(workflowName ? {[GenAiAttr.WORKFLOW_NAME]: workflowName} : {}),
    ...(nested ? {[GenAiAttr.WORKFLOW_NESTED]: true} : {}),
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
  if (isExperimentalFeatureEnabled(config, 'compaction')) {
    instruments.compactions.record(totals.compactions, attributes);
  }
}
