/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type Context, createContextKey} from '@opentelemetry/api';

import type {TelemetryConfig} from './config.js';
import {TokenUsage} from './token_usage.js';

const AGENT_FRAME_KEY = createContextKey('adk_agent_frame');
const WORKFLOW_FRAME_KEY = createContextKey('adk_workflow_frame');

/** What the calls counted against one agent invocation or workflow add up to. */
export interface Totals {
  readonly inferenceCalls: number;
  readonly toolCalls: number;
  readonly skillLoads: number;
  /** Compactions; counted against workflows only. */
  readonly compactions: number;
  /** Token spend; `undefined` until a model call reports usage. */
  readonly tokens?: TokenUsage;
}

const EMPTY_TOTALS: Totals = Object.freeze({
  inferenceCalls: 0,
  toolCalls: 0,
  skillLoads: 0,
  compactions: 0,
});

/** Totals that calls running under a scope add to while it is open. */
export interface Accumulator {
  totals: Totals;
}

/** One agent invocation, published on the context it runs under. */
type AgentFrame = Accumulator;

/**
 * One workflow, root or nested, published on the context it runs under. Its
 * presence is what makes a workflow started below it nested.
 */
export interface WorkflowFrame extends Accumulator {
  /** The enclosing workflow; `undefined` on the root. */
  readonly parent: WorkflowFrame | undefined;
  /** What the runner was entered at; nested workflows inherit it. */
  readonly rootAgentName: string;
  /** The config of the root workflow; nested workflows inherit it. */
  readonly config: TelemetryConfig;
  /**
   * The runner's workflow entrypoint, which runs inside this frame instead of
   * opening its own. Cleared once that workflow has claimed it.
   */
  entrypoint: object | undefined;
}

function isAccumulator(value: unknown): value is Accumulator {
  return typeof value === 'object' && value !== null && 'totals' in value;
}

function isWorkflowFrame(value: unknown): value is WorkflowFrame {
  return isAccumulator(value) && 'rootAgentName' in value;
}

function getWorkflowFrame(ctx: Context): WorkflowFrame | undefined {
  const value = ctx.getValue(WORKFLOW_FRAME_KEY);
  return isWorkflowFrame(value) ? value : undefined;
}

/** An agent frame and the context that carries it. */
export interface OpenedAgentFrame {
  readonly frame: Accumulator;
  readonly context: Context;
}

/**
 * Opens the frame of one agent invocation on `ctx`. Calls under it count
 * against this frame only, not against an enclosing agent's.
 */
export function openAgentFrame(ctx: Context): OpenedAgentFrame {
  const frame: AgentFrame = {totals: EMPTY_TOTALS};
  return {frame, context: ctx.setValue(AGENT_FRAME_KEY, frame)};
}

/** Parameters for {@link openWorkflowFrame}. */
export interface OpenWorkflowFrameParams {
  readonly workflowName: string;
  /** The config to use if this is the root workflow. */
  readonly config: TelemetryConfig;
  /** The runner's entrypoint, when this frame is opened for it. */
  readonly entrypoint?: object;
}

/** A workflow frame and the context that carries it. */
export interface OpenedWorkflowFrame {
  readonly frame: WorkflowFrame;
  readonly context: Context;
}

/**
 * Opens the frame of one workflow on `ctx`, nested in the workflow frame
 * already on `ctx` if there is one.
 *
 * A root workflow is keyed by its own name and uses `config`; a nested one
 * inherits both from the workflow enclosing it.
 */
export function openWorkflowFrame(
  ctx: Context,
  {workflowName, config, entrypoint}: OpenWorkflowFrameParams,
): OpenedWorkflowFrame {
  const parent = getWorkflowFrame(ctx);
  const frame: WorkflowFrame = {
    totals: EMPTY_TOTALS,
    parent,
    rootAgentName: parent?.rootAgentName ?? workflowName,
    config: parent?.config ?? config,
    entrypoint,
  };
  return {frame, context: ctx.setValue(WORKFLOW_FRAME_KEY, frame)};
}

/**
 * Hands the active workflow frame to the workflow it was opened for, once.
 *
 * @returns `true` when `workflow` was the unclaimed entrypoint of the active
 *     frame, and so runs in that frame instead of opening its own.
 */
export function claimEntrypointWorkflowFrame(
  ctx: Context,
  workflow: object,
): boolean {
  const frame = getWorkflowFrame(ctx);
  if (frame === undefined || frame.entrypoint !== workflow) {
    return false;
  }
  frame.entrypoint = undefined;
  return true;
}

/**
 * Every accumulator one call counts against, captured when the call starts.
 */
export interface Accumulators {
  addInferenceCall(): void;
  addToolCall(): void;
  addSkillLoad(): void;
  addTokens(usage: TokenUsage): void;
  /** Counts a compaction against the enclosing workflows only. */
  addCompaction(): void;
}

/**
 * Captures the accumulators a call running under `ctx` counts against: the
 * innermost agent frame, whose totals are exclusive to that agent, and every
 * enclosing workflow frame, whose totals are inclusive of everything that ran
 * inside it.
 *
 * Captured when the call starts, so a call that finishes after its agent or
 * workflow ended cannot count against a later one.
 */
export function captureAccumulators(ctx: Context): Accumulators {
  const agentFrame = ctx.getValue(AGENT_FRAME_KEY);
  const workflows: Accumulator[] = [];
  for (
    let frame = getWorkflowFrame(ctx);
    frame !== undefined;
    frame = frame.parent
  ) {
    workflows.push(frame);
  }
  const all = isAccumulator(agentFrame)
    ? [agentFrame, ...workflows]
    : workflows;
  const update = (
    accumulators: readonly Accumulator[],
    change: (totals: Totals) => Totals,
  ): void => {
    for (const accumulator of accumulators) {
      accumulator.totals = change(accumulator.totals);
    }
  };
  return {
    addInferenceCall: () =>
      update(all, (t) => ({...t, inferenceCalls: t.inferenceCalls + 1})),
    addToolCall: () => update(all, (t) => ({...t, toolCalls: t.toolCalls + 1})),
    addSkillLoad: () =>
      update(all, (t) => ({...t, skillLoads: t.skillLoads + 1})),
    addTokens: (usage) =>
      update(all, (t) => {
        const tokens = t.tokens ?? new TokenUsage();
        tokens.add(usage);
        return {...t, tokens};
      }),
    addCompaction: () =>
      update(workflows, (t) => ({...t, compactions: t.compactions + 1})),
  };
}
