/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InvocationContext,
  InvocationContextParams,
} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {BaseNode} from './base_node.js';
import {BranchPath} from './branch_path.js';
import {NodeTimeoutError} from './errors.js';
import {NodeContext} from './node_context.js';
import {createNodeState} from './node_state.js';
import {NodeStatus} from './node_status.js';
import {getRetryDelaySeconds, shouldRetryNode} from './utils/retry_utils.js';

/**
 * Options controlling a single `ctx.runNode(...)` execution.
 */
export interface RunNodeOptions {
  /** Deterministic tracking name; defaults to `node.name`. */
  nodeName?: string;
  /** Unique id for this specific run; defaults to `nodeName`. */
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

/**
 * Executes a child node on behalf of `parent.runNode(...)`.
 *
 * Responsibilities (Phase 1 scope): create the child {@link NodeContext},
 * drive `node.run()`, enrich each emitted event (author, node path, branch,
 * isolation scope), track the child's `output`/`route`, apply the per-node
 * `timeout`, and retry on failure per `retryConfig`. Returns the child context.
 */
export async function executeChildNode(
  parent: NodeContext,
  node: BaseNode,
  input: unknown,
  options: RunNodeOptions = {},
): Promise<NodeContext> {
  const nodeName = options.nodeName ?? node.name;
  const runId = options.runId ?? nodeName;
  const nodePath =
    options.overrideNodePath ??
    (parent.nodePath ? `${parent.nodePath}.${nodeName}` : nodeName);

  let branch = parent.branch;
  if (options.overrideBranch !== undefined) {
    branch = options.overrideBranch;
  } else if (options.useSubBranch) {
    branch = BranchPath.createSubBranch(parent.branch, {
      name: nodeName,
      runId: options.runId,
    });
  }

  const isolationScope =
    options.overrideIsolationScope ?? parent.isolationScope;

  const childIc =
    branch === parent.invocationContext.branch
      ? parent.invocationContext
      : withBranch(parent.invocationContext, branch);

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

  const nodeState = createNodeState({
    status: NodeStatus.RUNNING,
    input,
    runId,
  });

  for (;;) {
    // Reset per-attempt output so a retry starts clean.
    child.output = undefined;
    child.route = undefined;
    child.interruptIds = [];
    child.attemptCount = nodeState.attemptCount;
    try {
      await runOnce(node, child, input, nodeName, branch, isolationScope);
      break;
    } catch (err) {
      // Check retry eligibility with the attempt that just failed, compute its
      // backoff delay, THEN advance the counter (matches Python semantics).
      if (shouldRetryNode(err, node.retryConfig, nodeState)) {
        const delaySeconds = getRetryDelaySeconds(node.retryConfig, nodeState);
        nodeState.attemptCount += 1;
        await delay(delaySeconds * 1000, parent.invocationContext.abortSignal);
        continue;
      }
      throw err;
    }
  }

  if (options.useAsOutput) {
    parent.output = child.output;
    parent.route = child.route;
  }

  return child;
}

/**
 * Drives one attempt of `node.run()`, enriching and pushing each event and
 * tracking the child's output/route.
 *
 * When the node declares a `timeout`, execution is driven step-by-step and
 * raced against a deadline: on timeout the engine stops consuming events (so
 * nothing is pushed past the deadline — which would otherwise leak into a retry
 * or the next node), closes the generator so its `finally` blocks run, and
 * aborts `child.abortSignal` so a cooperative node body can cancel its own
 * in-flight work. Mirrors the cancellation semantics of Python's
 * `asyncio.wait_for`.
 */
async function runOnce(
  node: BaseNode,
  child: NodeContext,
  input: unknown,
  nodeName: string,
  branch: string | undefined,
  isolationScope: string | undefined,
): Promise<void> {
  const consume = (event: Event): void => {
    enrichEvent(event, child, nodeName, branch, isolationScope);
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

  if (!(typeof node.timeout === 'number' && node.timeout > 0)) {
    for await (const event of node.run(child, input)) {
      consume(event);
    }
    return;
  }

  const timeoutSeconds = node.timeout;
  const controller = new AbortController();
  const parentSignal = child.invocationContext.abortSignal;
  const onParentAbort = () => controller.abort();
  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, {once: true});
  }
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  child.abortSignal = controller.signal;

  // A single promise that rejects once the deadline (or external abort) fires;
  // reused across iterations so we don't leak a listener per step.
  const aborted = new Promise<never>((_, reject) => {
    const fail = () =>
      reject(new NodeTimeoutError({nodeName, timeout: timeoutSeconds}));
    if (controller.signal.aborted) {
      fail();
    } else {
      controller.signal.addEventListener('abort', fail, {once: true});
    }
  });

  const iterator = node.run(child, input)[Symbol.asyncIterator]();
  try {
    for (;;) {
      const result = await Promise.race([iterator.next(), aborted]);
      if (result.done) {
        break;
      }
      consume(result.value);
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

/**
 * Stamps engine-owned provenance onto an event without clobbering values the
 * node explicitly set.
 */
function enrichEvent(
  event: Event,
  child: NodeContext,
  nodeName: string,
  branch: string | undefined,
  isolationScope: string | undefined,
): void {
  if (!event.author) {
    event.author = nodeName;
  }
  event.nodeInfo = {...(event.nodeInfo ?? {}), path: child.nodePath};
  if (branch !== undefined && event.branch === undefined) {
    event.branch = branch;
  }
  if (isolationScope !== undefined && event.isolationScope === undefined) {
    event.isolationScope = isolationScope;
  }
}

/**
 * Creates a shallow child InvocationContext with a different branch, preserving
 * the shared invocation cost manager and all services/session.
 */
function withBranch(
  ic: InvocationContext,
  branch: string | undefined,
): InvocationContext {
  return new InvocationContext({
    ...(ic as unknown as InvocationContextParams),
    branch,
  });
}

/**
 * Promise-based delay that rejects early if the abort signal fires.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}
