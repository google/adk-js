/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Attributes} from '@opentelemetry/api';

import type {Totals} from '../common/accumulators.js';
import {AdkAttr, ERROR_TYPE_ATTR, GenAiAttr} from '../common/attributes.js';
import {
  isExperimentalFeatureEnabled,
  type TelemetryConfig,
} from '../common/config.js';
import {
  CALL_COUNT_BUCKETS,
  cachedInstruments,
  createHistogram,
  createTokenHistograms,
  recordTokenHistograms,
} from './meters.js';

const PER_WORKFLOW =
  'one workflow invocation, across every agent that ran in it';

const getInstruments = cachedInstruments((meter) => ({
  duration: createHistogram(meter, {
    name: 'gen_ai.invoke_workflow.duration',
    unit: 's',
    description: 'Duration of workflow invocations.',
  }),
  inferenceCalls: createHistogram(meter, {
    name: 'adk.experimental.invoke_workflow.inference_calls',
    unit: '1',
    description: `Number of inference (model) calls over ${PER_WORKFLOW}.`,
    buckets: CALL_COUNT_BUCKETS,
  }),
  toolCalls: createHistogram(meter, {
    name: 'adk.experimental.invoke_workflow.tool_calls',
    unit: '1',
    description:
      `Number of tool calls over ${PER_WORKFLOW}. Includes the` +
      ' `transfer_to_agent` calls that route between them.',
    buckets: CALL_COUNT_BUCKETS,
  }),
  skillLoads: createHistogram(meter, {
    name: 'adk.experimental.invoke_workflow.skill.loads',
    unit: '1',
    description: `Number of skill loads over ${PER_WORKFLOW}.`,
    buckets: CALL_COUNT_BUCKETS,
  }),
  compactions: createHistogram(meter, {
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
}));

/** Parameters for {@link recordWorkflowMetrics}. */
export interface WorkflowMetricsParams {
  /** The workflow's name; omitted from the attributes when empty. */
  readonly workflowName: string;
  /** What the runner was entered at, which keys the per-workflow totals. */
  readonly rootAgentName: string;
  /** Whether another workflow encloses this one. */
  readonly nested: boolean;
  readonly elapsedSeconds: number;
  /** The type of the error the workflow failed with, if it failed. */
  readonly errorType?: string;
  /** Everything counted inside the workflow, nested workflows included. */
  readonly totals: Totals;
  readonly config: TelemetryConfig;
}

/**
 * Records one workflow invocation: its duration and, when enabled, its
 * inclusive totals.
 *
 * Totals carry no agent dimension, which is meaningless on a value spanning a
 * whole workflow. Counts are recorded even when zero; token totals are skipped
 * when no call reported usage.
 */
export function recordWorkflowMetrics({
  workflowName,
  rootAgentName,
  nested,
  elapsedSeconds,
  errorType,
  totals,
  config,
}: WorkflowMetricsParams): void {
  const instruments = getInstruments();
  const nameAttributes: Attributes = {
    ...(workflowName ? {[GenAiAttr.WORKFLOW_NAME]: workflowName} : {}),
    ...(nested ? {[GenAiAttr.WORKFLOW_NESTED]: true} : {}),
  };
  instruments.duration.record(elapsedSeconds, {
    [GenAiAttr.OPERATION_NAME]: 'invoke_workflow',
    ...nameAttributes,
    ...(errorType === undefined ? {} : {[ERROR_TYPE_ATTR]: errorType}),
  });

  if (!isExperimentalFeatureEnabled(config, 'workflow')) {
    return;
  }
  const attributes: Attributes = {
    [AdkAttr.EXPERIMENTAL_ROOT_AGENT_NAME]: rootAgentName,
    ...nameAttributes,
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
