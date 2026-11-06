/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {context, type Context, createContextKey} from '@opentelemetry/api';

import {readTelemetryConfig, type TelemetryConfig} from './config.js';
import {TokenUsage} from './token_usage.js';

const AGENT_FRAME_KEY = createContextKey('adk_agent_frame');
const WORKFLOW_FRAME_KEY = createContextKey('adk_workflow_frame');

const AGENT_FRAME_SYMBOL = Symbol('adk.telemetry.agentFrame');
const WORKFLOW_FRAME_SYMBOL = Symbol('adk.telemetry.workflowFrame');

/** An accumulator's totals at flush time. */
export interface Totals {
  /** `undefined` until a model call reports usage (not the same as zero). */
  tokens?: TokenUsage;
  inferenceCalls: number;
  toolCalls: number;
  skillLoads: number;
  compactions: number;
}

/** State accumulated across one agent invocation or one workflow. */
export interface Accumulator {
  readonly totals: Totals;
}

interface AgentFrame extends Accumulator {
  readonly [AGENT_FRAME_SYMBOL]: true;
}

/**
 * State accumulated across one `invoke_workflow`, root or nested.
 *
 * The `parent` chain is walked when a call records against every enclosing
 * workflow; its presence is what `gen_ai.workflow.nested` reports.
 */
export interface WorkflowFrame extends Accumulator {
  readonly [WORKFLOW_FRAME_SYMBOL]: true;
  readonly parent: WorkflowFrame | undefined;
  /** The agent or workflow the turn entered at, inherited by nested workflows. */
  readonly rootAgentName: string;
  readonly workflowName: string;
  /** The config the turn was claimed under, inherited by nested workflows. */
  readonly config: TelemetryConfig;
  /**
   * The runner's workflow entrypoint, which runs inside this frame instead of
   * opening its own. Cleared once that workflow has claimed it.
   */
  entrypoint: object | undefined;
}

function isAgentFrame(value: unknown): value is AgentFrame {
  return (
    typeof value === 'object' && value !== null && AGENT_FRAME_SYMBOL in value
  );
}

function isWorkflowFrame(value: unknown): value is WorkflowFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    WORKFLOW_FRAME_SYMBOL in value
  );
}

function getAgentFrame(ctx: Context): AgentFrame | undefined {
  const value = ctx.getValue(AGENT_FRAME_KEY);
  return isAgentFrame(value) ? value : undefined;
}

function getWorkflowFrame(ctx: Context): WorkflowFrame | undefined {
  const value = ctx.getValue(WORKFLOW_FRAME_KEY);
  return isWorkflowFrame(value) ? value : undefined;
}

function createTotals(): Totals {
  return {
    tokens: undefined,
    inferenceCalls: 0,
    toolCalls: 0,
    skillLoads: 0,
    compactions: 0,
  };
}

/**
 * Opens an agent accumulator frame on `parentContext`, so model and tool calls
 * running inside count their exclusive totals against this agent invocation.
 */
export function openAgentFrame(parentContext: Context = context.active()): {
  readonly frame: Accumulator;
  readonly context: Context;
} {
  const frame: AgentFrame = {
    [AGENT_FRAME_SYMBOL]: true,
    totals: createTotals(),
  };
  return {
    frame,
    context: parentContext.setValue(AGENT_FRAME_KEY, frame),
  };
}

/** Parameters for {@link openWorkflowFrame}. */
export interface OpenWorkflowFrameParams {
  readonly workflowName: string;
  readonly entrypoint?: object;
  readonly parentContext?: Context;
}

/**
 * Opens a workflow accumulator frame on `parentContext`, linked to any
 * enclosing workflow frame and inheriting its root agent name and telemetry
 * config.
 */
export function openWorkflowFrame({
  workflowName,
  entrypoint,
  parentContext = context.active(),
}: OpenWorkflowFrameParams): {
  readonly frame: WorkflowFrame;
  readonly context: Context;
} {
  const enclosing = getWorkflowFrame(parentContext);
  const frame: WorkflowFrame = {
    [WORKFLOW_FRAME_SYMBOL]: true,
    totals: createTotals(),
    parent: enclosing,
    rootAgentName: enclosing?.rootAgentName ?? workflowName,
    workflowName,
    config: enclosing?.config ?? readTelemetryConfig(),
    entrypoint,
  };
  return {
    frame,
    context: parentContext.setValue(WORKFLOW_FRAME_KEY, frame),
  };
}

/**
 * Hands the runner's entrypoint frame to the workflow it was opened for, once.
 *
 * @returns The context to run the workflow under, or `undefined` when
 *     `workflow` is not the unclaimed entrypoint of the enclosing frame.
 */
export function claimEntrypointWorkflowFrame(
  workflow: object,
  ctx: Context = context.active(),
): Context | undefined {
  const frame = getWorkflowFrame(ctx);
  if (frame === undefined || frame.entrypoint !== workflow) {
    return undefined;
  }
  frame.entrypoint = undefined;
  return ctx;
}

/**
 * Every accumulator a call belongs to, captured from the context when the call
 * starts: the innermost agent (exclusive) and each enclosing workflow
 * (inclusive).
 */
export interface CapturedAccumulators {
  addInferenceCall(): void;
  addToolCall(): void;
  addSkillLoad(): void;
  addCompaction(): void;
  addTokens(usage: TokenUsage): void;
}

/**
 * Captures the active agent and workflow accumulators from `ctx`.
 */
export function captureAccumulators(
  ctx: Context = context.active(),
): CapturedAccumulators {
  const agent = getAgentFrame(ctx);
  const workflow = getWorkflowFrame(ctx);

  const each = (fn: (totals: Totals) => void): void => {
    if (agent) {
      fn(agent.totals);
    }
    let current = workflow;
    while (current) {
      fn(current.totals);
      current = current.parent;
    }
  };

  return {
    addInferenceCall(): void {
      each((t) => {
        t.inferenceCalls += 1;
      });
    },
    addToolCall(): void {
      each((t) => {
        t.toolCalls += 1;
      });
    },
    addSkillLoad(): void {
      each((t) => {
        t.skillLoads += 1;
      });
    },
    addCompaction(): void {
      let current = workflow;
      while (current) {
        current.totals.compactions += 1;
        current = current.parent;
      }
    },
    addTokens(usage: TokenUsage): void {
      each((t) => {
        if (t.tokens === undefined) {
          t.tokens = new TokenUsage();
        }
        t.tokens.add(usage);
      });
    },
  };
}
