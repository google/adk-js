/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {context, type Span, SpanStatusCode, trace} from '@opentelemetry/api';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {traceNodeExecution, tracer} from '../telemetry/tracing.js';
import {formatError} from '../utils/error_utils.js';
import {BaseNode} from './base_node.js';
import {createSubBranch} from './branch_path.js';
import {
  InvocationAbortedError,
  isInvocationAbortedError,
  NodeTimeoutError,
} from './errors.js';
import {NodeContext} from './node_context.js';
import {createNodeState, NodeState} from './node_state.js';
import {NodeStatus} from './node_status.js';
import {getRetryDelaySeconds, shouldRetryNode} from './utils/retry_utils.js';

/**
 * Options controlling a single `ctx.runNode(...)` execution.
 */
export interface RunNodeOptions {
  /** Deterministic tracking name; defaults to `node.name`. */
  nodeName?: string;
  /**
   * Unique id for this specific run. Defaults to a per-node sequence — "1",
   * "2", "3" in call order — which is what a resume matches checkpoints on.
   *
   * Supply one only when position is not stable but identity is (a reorderable
   * collection: key it off the item's own id). It must contain a non-numeric
   * character so it cannot collide with the automatic sequence.
   */
  runId?: string;
  /** If true, the child's output replaces the caller's output. */
  useAsOutput?: boolean;
  /** If true, run the child in an isolated sub-branch. */
  useSubBranch?: boolean;
  /** Explicit branch, overriding the default/sub-branch computation. */
  overrideBranch?: string;
  /** Explicit isolation scope, overriding inheritance from the parent. */
  overrideIsolationScope?: string;
  /**
   * Explicit node path for the child (used by the dynamic scheduler to embed
   * the run id, e.g. `wf.node@1`, so distinct runs are distinguishable on
   * resume). Defaults to `${parent.nodePath}.${nodeName}`.
   */
  overrideNodePath?: string;
}

/** Parameters for {@link executeChildNode}. */
export interface ExecuteChildNodeParams {
  /** The context requesting the child run. */
  parent: NodeContext;
  /** The node to execute. */
  node: BaseNode;
  /** The input passed to the node. */
  input: unknown;
  /** Options controlling this run. */
  options?: RunNodeOptions;
  /**
   * Engine-supplied cancellation signal that overrides the parent invocation's
   * for this child (used by a Workflow to cancel in-flight siblings when a node
   * fails). Defaults to the parent invocation's abort signal.
   */
  abortSignal?: AbortSignal;
  nodeState?: NodeState;
}

/**
 * Executes a child node on behalf of `parent.runNode(...)`.
 *
 * Responsibilities (Phase 1 scope): create the child {@link NodeContext},
 * drive `node.run()`, enrich each emitted event (author, node path, branch,
 * isolation scope), track the child's `output`/`route`, apply the per-node
 * `timeout`, and retry on failure per `retryConfig`. Returns the child context.
 *
 * Retry semantics: each attempt starts with the child's per-attempt state
 * cleared (output, route, interrupt ids, and `actions.stateDelta`). Events are
 * the exception — they stream out through the shared channel as they are
 * produced and cannot be retracted, so a node that emits some events and then
 * fails will re-emit them when the attempt is retried. Nodes that must not
 * duplicate observable events across retries should emit only after their
 * fallible work has succeeded.
 */
export function executeChildNode(
  params: ExecuteChildNodeParams,
): Promise<NodeContext> {
  const {parent, node, options = {}} = params;
  const nodeName = options.nodeName ?? node.name;
  const nodePath =
    options.overrideNodePath ??
    (parent.nodePath ? `${parent.nodePath}.${nodeName}` : nodeName);

  // The span is started here, synchronously, rather than inside `runChildNode`:
  // its parent must be whatever span was active when the workflow SCHEDULED
  // this node. Nodes are raced concurrently in `Workflow.runLoop`, so a parent
  // captured any later would nest concurrent siblings inside whichever task
  // happened to resolve first.
  const span = tracer.startSpan(`execute_node ${nodeName}`);

  // Deliberately not `async`, and the callback is deliberately not `async`
  // either: `context.with` hands the inner promise straight back, so the child
  // settles on exactly the same microtask it did before tracing existed. Async
  // wrappers here would each add promise-adoption ticks, which is enough to
  // change how concurrently scheduled nodes interleave — an observability
  // change must not move execution around.
  return context.with(trace.setSpan(context.active(), span), () =>
    runChildNode({params, nodeName, nodePath, span}),
  );
}

interface RunChildNodeParams {
  params: ExecuteChildNodeParams;
  nodeName: string;
  nodePath: string;
  span: Span;
}

/** The body of {@link executeChildNode}, running under its `execute_node` span. */
async function runChildNode({
  params: {
    parent,
    node,
    input,
    options = {},
    abortSignal,
    nodeState: callerNodeState,
  },
  nodeName,
  nodePath,
  span,
}: RunChildNodeParams): Promise<NodeContext> {
  const runId = options.runId ?? nodeName;

  let branch = parent.branch;
  if (options.overrideBranch !== undefined) {
    branch = options.overrideBranch;
  } else if (options.useSubBranch) {
    branch = createSubBranch(parent.branch, {
      name: nodeName,
      runId: options.runId,
    });
  }

  const declaredScope =
    node.isolationScope === true ? `${nodePath}@${runId}` : node.isolationScope;
  const isolationScope =
    options.overrideIsolationScope ?? declaredScope ?? parent.isolationScope;

  // The child observes the engine-supplied abort signal when given (a Workflow
  // uses it to cancel siblings on failure), otherwise the parent invocation's.
  const effectiveAbortSignal =
    abortSignal ?? parent.invocationContext.abortSignal;

  const childIc =
    branch === parent.invocationContext.branch &&
    effectiveAbortSignal === parent.invocationContext.abortSignal &&
    isolationScope === parent.invocationContext.isolationScope
      ? parent.invocationContext
      : new InvocationContext({
          ...parent.invocationContext,
          branch,
          abortSignal: effectiveAbortSignal,
          isolationScope,
        });

  const child = new NodeContext({
    invocationContext: childIc,
    channel: parent.channel,
    nodePath,
    runId,
    resumeInputs: parent.resumeInputs,
    isolationScope,
  });
  // Propagate the dynamic scheduler down; a nested Workflow overrides it.
  child.scheduler = parent.scheduler;

  const nodeState =
    callerNodeState ??
    createNodeState({
      status: NodeStatus.RUNNING,
      input,
      runId,
    });

  const pluginManager = child.invocationContext.pluginManager;

  try {
    if (pluginManager?.hasPlugins) {
      const skipOutput = await pluginManager.runBeforeNodeCallback({
        node,
        nodeContext: child,
        input,
      });
      if (skipOutput !== undefined) {
        child.output = skipOutput;
        // A skipped node still fills its slot in the trace, so record it as
        // completed rather than leaving an attribute-less span behind.
        traceNodeExecution({
          nodePath,
          runId,
          attempt: nodeState.attemptCount,
          status: 'completed',
          interruptCount: child.interruptIds.length,
        });
        if (options.useAsOutput) {
          parent.output = child.output;
          parent.route = child.route;
        }
        return child;
      }
    }

    let succeeded = false;
    while (!succeeded) {
      resetState(child);
      child.attemptCount = nodeState.attemptCount;
      try {
        await runAttempt({
          node,
          child,
          input,
          nodeName,
          branch,
          isolationScope,
          nodePath,
          runId,
          attempt: nodeState.attemptCount,
        });
        succeeded = true;
      } catch (err) {
        // Cancellation is terminal: an aborted invocation (or a sibling
        // failure that cancelled this node) is never retried.
        if (isInvocationAbortedError(err)) {
          throw err;
        }
        // Check retry eligibility with the attempt that just failed, compute
        // its backoff delay, THEN advance the counter (matches Python
        // semantics).
        const retryConfig = node.preparedRetryConfig;
        if (
          !retryConfig ||
          !shouldRetryNode({error: err, retryConfig, nodeState})
        ) {
          throw err;
        }
        const delaySeconds = getRetryDelaySeconds({retryConfig, nodeState});
        nodeState.attemptCount += 1;
        await delay(delaySeconds * 1000, effectiveAbortSignal);
      }
    }

    traceNodeExecution({
      nodePath,
      runId,
      attempt: nodeState.attemptCount,
      status: child.interruptIds.length > 0 ? 'waiting' : 'completed',
      interruptCount: child.interruptIds.length,
    });

    if (pluginManager?.hasPlugins) {
      const replacedOutput = await pluginManager.runAfterNodeCallback({
        node,
        nodeContext: child,
        output: child.output,
      });
      if (replacedOutput !== undefined) {
        child.output = replacedOutput;
      }
    }

    if (options.useAsOutput) {
      parent.output = child.output;
      parent.route = child.route;
    }

    return child;
  } catch (err) {
    traceNodeExecution({
      nodePath,
      runId,
      attempt: nodeState.attemptCount,
      status: 'failed',
      interruptCount: child.interruptIds.length,
    });
    span.setStatus({code: SpanStatusCode.ERROR, message: formatError(err)});
    throw err;
  } finally {
    span.end();
  }
}

interface RunAttemptParams extends RunOnceParams {
  nodePath: string;
  runId: string;
  attempt: number;
}

/**
 * Not `async`: a node without a retry config must reach `runOnce` and settle on
 * exactly the microtask it would have without tracing (see `executeChildNode`).
 */
function runAttempt(params: RunAttemptParams): Promise<void> {
  const {node, nodePath, runId, attempt} = params;
  if (!node.preparedRetryConfig) {
    return runOnce(params);
  }
  return tracer.startActiveSpan(
    `execute_node_attempt ${params.nodeName}`,
    async (span) => {
      try {
        await runOnce(params);
        traceNodeExecution({
          nodePath,
          runId,
          attempt,
          status:
            params.child.interruptIds.length > 0 ? 'waiting' : 'completed',
          interruptCount: params.child.interruptIds.length,
        });
      } catch (err) {
        traceNodeExecution({
          nodePath,
          runId,
          attempt,
          status: 'failed',
          interruptCount: params.child.interruptIds.length,
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: formatError(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Reset per-attempt state so a retry starts clean. This covers everything a
 * failed attempt can leave behind on the child context: its output/route,
 * interrupt ids, AND its state writes. A node that calls `ctx.state.set(...)`
 * and then throws would otherwise leave the failed attempt's writes in the
 * delta, to be committed alongside the successful attempt's. `NodeContext`
 * builds its `State` over this exact `stateDelta` object once (in its
 * constructor), so we clear the keys in place rather than reassigning it.
 *
 * Note: events already pushed through the channel on a failed attempt are
 * downstream and cannot be retracted, so a node that emits N events and
 * then fails re-emits those N on retry (see the note on `executeChildNode`).
 *
 * @param childNodeContext Node context to reset
 */
function resetState(childNodeContext: NodeContext): void {
  childNodeContext.output = undefined;
  childNodeContext.route = undefined;
  childNodeContext.interruptIds = [];
  for (const key of Object.keys(childNodeContext.actions.stateDelta)) {
    delete childNodeContext.actions.stateDelta[key];
  }
}

interface RunOnceParams {
  node: BaseNode;
  child: NodeContext;
  input: unknown;
  nodeName: string;
  branch: string | undefined;
  isolationScope: string | undefined;
}

/**
 * Drives one attempt of `node.run()`, enriching and pushing each event and
 * tracking the child's output/route.
 *
 * When the node declares a `timeout` OR an external abort signal is present
 * (the invocation's, or the workflow-scoped one used to cancel siblings when
 * another node fails), execution is driven step-by-step and raced against those
 * conditions: a fired deadline raises {@link NodeTimeoutError}; any other abort
 * raises {@link InvocationAbortedError}. Either way the engine stops consuming
 * events (so nothing is pushed past cancellation — which would otherwise leak
 * into a retry or the next node), closes the generator so its `finally` blocks
 * run, and aborts `child.abortSignal` so a cooperative node body can cancel its
 * own in-flight work. Mirrors the cancellation semantics of Python's
 * `asyncio.wait_for`.
 *
 * When there is neither a deadline nor an abort signal, a plain `for await`
 * fast path is used.
 */
async function runOnce({
  node,
  child,
  input,
  nodeName,
  branch,
  isolationScope,
}: RunOnceParams): Promise<void> {
  const consume = (event: Event): void => {
    enrichEvent({event, child, nodeName, branch, isolationScope});
    if (event.output !== undefined) {
      child.output = event.output;
    }
    if (event.route !== undefined) {
      child.route = event.route;
    }
    // HITL: an interrupt event marks its ids as long-running tool ids.
    if (event.longRunningToolIds && event.longRunningToolIds.length > 0) {
      for (const id of event.longRunningToolIds) {
        if (!child.interruptIds.includes(id)) {
          child.interruptIds.push(id);
        }
      }
      // Persist the node's input on the interrupt event so a resumed
      // (waiting) node re-runs with its ORIGINAL input, not the resume
      // message. Rehydrated by reconstructNodeStates on the next turn.
      event.actions.agentState = {
        ...(event.actions.agentState ?? {}),
        input,
      };
    }
    child.channel.push(event);
  };

  const parentSignal = child.invocationContext.abortSignal;
  const hasTimeout = typeof node.timeout === 'number' && node.timeout > 0;

  // Fast path: no per-node deadline and no external cancellation to observe.
  if (!hasTimeout && !parentSignal) {
    for await (const event of node.run(child, input)) {
      consume(event);
    }
    return;
  }

  // Cooperative cancellation (external abort, no deadline): expose the abort
  // signal as `ctx.abortSignal` so a cooperative node can wind down its own work
  // (e.g. a Workflow child stopping when a sibling fails), then drain normally.
  // We do NOT force-stop: a node that ignores the signal runs to completion
  // (best-effort), and a node that fails still surfaces its error — with the
  // retry backoff observing the same signal.
  if (!hasTimeout) {
    child.abortSignal = parentSignal;
    try {
      for await (const event of node.run(child, input)) {
        consume(event);
      }
    } finally {
      child.abortSignal = undefined;
    }
    return;
  }

  // Deadline path: drive the node step-by-step and race each step against the
  // timeout (and any external abort). On the deadline (or abort) the engine
  // stops consuming events, closes the generator so its `finally` runs, and
  // aborts `child.abortSignal` so a cooperative body can cancel its in-flight
  // work; the run rejects with NodeTimeoutError. Mirrors Python's
  // `asyncio.wait_for`.
  const timeoutSeconds = node.timeout;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, {once: true});
  }
  const timer = setTimeout(
    () => controller.abort(),
    (timeoutSeconds ?? 0) * 1000,
  );
  child.abortSignal = controller.signal;

  // A single promise that rejects once the deadline (or external abort) fires;
  // reused across iterations so we don't leak a listener per step.
  const aborted = new Promise<never>((_, reject) => {
    const fail = () =>
      reject(new NodeTimeoutError({nodeName, timeout: timeoutSeconds ?? 0}));
    if (controller.signal.aborted) {
      fail();
    } else {
      controller.signal.addEventListener('abort', fail, {once: true});
    }
  });

  const iterator = node.run(child, input)[Symbol.asyncIterator]();
  try {
    let result = await Promise.race([iterator.next(), aborted]);
    while (!result.done) {
      consume(result.value);
      result = await Promise.race([iterator.next(), aborted]);
    }
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
    child.abortSignal = undefined;
    // Best-effort: close the generator so its `finally`/cleanup runs. This is
    // queued behind any in-flight `next()`; its result is discarded.
    void Promise.resolve(iterator.return?.(undefined)).catch(() => {});
  }
}

interface EnrichEventParams {
  event: Event;
  child: NodeContext;
  nodeName: string;
  branch: string | undefined;
  isolationScope: string | undefined;
}

/**
 * Stamps engine-owned provenance onto an event.
 *
 * `author`, `branch` and `isolationScope` are only filled in when the node left
 * them unset, so a node can override them. `path` is different: it is
 * engine-owned and always set to the child's real node path — a node must not be
 * able to misreport where it ran.
 */
function enrichEvent({
  event,
  child,
  nodeName,
  branch,
  isolationScope,
}: EnrichEventParams): void {
  if (!event.author) {
    event.author = nodeName;
  }
  // Engine-owned: always stamp the true node path (see doc above).
  event.nodeInfo = {...(event.nodeInfo ?? {}), path: child.nodePath};
  if (branch !== undefined && event.branch === undefined) {
    event.branch = branch;
  }
  if (isolationScope !== undefined && event.isolationScope === undefined) {
    event.isolationScope = isolationScope;
  }
}

/**
 * Promise-based delay that rejects early (with {@link InvocationAbortedError})
 * if the abort signal fires — so an abort during retry backoff is
 * distinguishable from a node failure.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new InvocationAbortedError('Invocation aborted during retry.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new InvocationAbortedError('Invocation aborted during retry.'));
    };
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}
