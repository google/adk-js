/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {createEventActions, EventActions} from '../events/event_actions.js';
import {State} from '../sessions/state.js';
import {AsyncQueue} from '../utils/async_queue.js';
import type {BaseNode} from './base_node.js';
import type {RouteValue} from './graph.js';
import {executeChildNode, RunNodeOptions} from './node_runner.js';
import type {ScheduleDynamicNode} from './schedule_dynamic_node.js';

/**
 * The result of running a node: the fields a caller (and the engine's
 * completion handling) reads off a finished run — its `output`, emitted
 * `route`, the `branch` it ran on, and any raised interrupt ids.
 *
 * A node that actually executes returns its full {@link NodeContext} (which
 * satisfies this shape). A node that is *fast-forwarded* on resume (its output
 * was cached in a prior turn, so its body is not re-run) returns a bare
 * `NodeResult` with no live context behaviour — so callers of `ctx.runNode()`
 * should treat the result as a `NodeResult` and read only these fields.
 */
export interface NodeResult {
  /** The structured output the node produced (if any). */
  output: unknown;
  /** The route key(s) the node emitted, if any (array = multi-route). */
  route?: RouteValue | RouteValue[];
  /** The branch the node ran on. */
  branch?: string;
  /** Interrupt ids the node is blocked on (empty when it completed). */
  interruptIds: string[];
}

/**
 * Options for constructing a {@link NodeContext}.
 */
export interface NodeContextOptions {
  invocationContext: InvocationContext;
  channel: AsyncQueue<Event>;
  /** Dotted node path of the owning node (empty string for the root). */
  nodePath: string;
  /** Deterministic run id of the owning node. */
  runId: string;
  /** Responses for resuming interrupted child nodes, keyed by interrupt id. */
  resumeInputs?: Record<string, unknown>;
  /** Scope tag isolating this node's events from peer scopes. */
  isolationScope?: string;
  /** Accumulator for event actions (state delta, etc). */
  actions?: EventActions;
}

/**
 * The execution context for a workflow node — the TypeScript analogue of
 * `google/adk-python` `agents/context.py::Context` (the workflow flavour).
 *
 * It exposes `ctx.runNode(...)` for programmatic child execution, `ctx.state`
 * for delta-aware session state, `ctx.emit(...)` to stream an event, and the
 * mutable `output`/`route`/`interruptIds` a node sets while running.
 */
export class NodeContext {
  readonly invocationContext: InvocationContext;
  readonly channel: AsyncQueue<Event>;
  readonly nodePath: string;
  readonly runId: string;
  readonly actions: EventActions;
  resumeInputs: Record<string, unknown>;
  isolationScope?: string;

  /** The structured output produced by the node during its run. */
  output: unknown = undefined;

  /** The route key(s) emitted by the node, if any (array = multi-route). */
  route?: RouteValue | RouteValue[];

  /** Interrupt ids the node is currently blocked on (HITL). */
  interruptIds: string[] = [];

  /**
   * Abort signal for the current node run, set by the engine while the node is
   * executing under a deadline or an external cancellation signal — i.e. when
   * the node declares a `timeout`, when the invocation itself can be aborted, or
   * when it runs inside a Workflow (whose signal fires if a sibling fails).
   * Cooperative node bodies can observe `ctx.abortSignal` to wind down their own
   * in-flight work (e.g. pass it to a model/tool call); the engine also stops
   * consuming the node's events once it fires, so nothing is pushed past
   * cancellation. A fired `timeout` surfaces as a `NodeTimeoutError`; an external
   * abort stops the node without raising.
   */
  abortSignal?: AbortSignal;

  /**
   * The dynamic-node scheduler for this subtree. When set, `ctx.runNode()`
   * routes through it (dedup/resume/fresh); otherwise it runs the child
   * directly. Propagated to child contexts by the node runner; a nested
   * Workflow overrides it with its own scheduler.
   */
  scheduler?: ScheduleDynamicNode;

  /** The current attempt number (1-based) for the running node (see retry). */
  attemptCount = 1;

  private readonly _state: State;
  private readonly dynamicRunCounters = new Map<string, number>();

  constructor(opts: NodeContextOptions) {
    this.invocationContext = opts.invocationContext;
    this.channel = opts.channel;
    this.nodePath = opts.nodePath;
    this.runId = opts.runId;
    this.resumeInputs = opts.resumeInputs ?? {};
    this.isolationScope = opts.isolationScope;
    this.actions = opts.actions ?? createEventActions();
    // Writes via `ctx.state` accumulate into `actions.stateDelta`, mirroring
    // Python's `ctx.state` -> `ctx.actions.state_delta` behaviour.
    this._state = new State(
      opts.invocationContext.session.state,
      this.actions.stateDelta,
    );
  }

  /** Delta-aware session state; writes accumulate in `actions.stateDelta`. */
  get state(): State {
    return this._state;
  }

  /** The branch of the owning invocation context. */
  get branch(): string | undefined {
    return this.invocationContext.branch;
  }

  /** The current invocation id. */
  get invocationId(): string {
    return this.invocationContext.invocationId;
  }

  /** The current session. */
  get session() {
    return this.invocationContext.session;
  }

  /** Streams a single event out through the workflow's event channel. */
  emit(event: Event): void {
    this.channel.push(event);
  }

  /**
   * Runs a child node programmatically, streaming its events through the same
   * channel and resolving to the child's result — a full {@link NodeContext}
   * for a node that actually ran, or a bare {@link NodeResult} for one that was
   * fast-forwarded from cached output on resume. Either way the caller can read
   * `output`, `route`, `branch`, and `interruptIds`; only a `NodeContext`
   * offers live behaviour (`emit`, `state`, nested `runNode`).
   *
   * When a dynamic-node {@link scheduler} is set (inside a Workflow subtree),
   * the call routes through it for dedup/resume; otherwise the child runs
   * directly.
   */
  runNode(
    node: BaseNode,
    input?: unknown,
    options?: RunNodeOptions,
  ): Promise<NodeContext | NodeResult> {
    if (this.scheduler) {
      const nodeName = options?.nodeName ?? node.name;
      let runId = options?.runId;
      if (!runId) {
        const next = (this.dynamicRunCounters.get(nodeName) ?? 0) + 1;
        this.dynamicRunCounters.set(nodeName, next);
        runId = String(next);
      }
      return this.scheduler.schedule(this, node, input, {
        ...options,
        nodeName,
        runId,
      });
    }
    return executeChildNode({parent: this, node, input, options});
  }
}
