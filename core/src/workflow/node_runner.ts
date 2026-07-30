/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {createEvent, Event} from '../events/event.js';
import {logger} from '../utils/logger.js';

import {BaseNode} from './base_node.js';
import {NodeTimeoutError} from './errors.js';
import {NodeContext} from './node_context.js';
import {getRetryDelayMs, shouldRetryNode} from './retry_config.js';

/**
 * The parameters for {@link runNode}.
 */
export interface RunNodeOptions {
  /** The invocation this node run belongs to. */
  invocationContext: InvocationContext;

  /** The input to pass to the node. */
  nodeInput?: unknown;

  /** The `nodePath` of the node scheduling this run, when nested. */
  parentNodePath?: string;

  /** Identifier of this run of the node. Defaults to `'1'`. */
  runId?: string;
}

/**
 * Observes a promise that is no longer awaited so a late rejection cannot
 * crash the process.
 *
 * A timed-out attempt abandons the node's in-flight `next()` and asks its
 * generator to close. JavaScript cannot preempt the node, so both may still
 * settle later; the run's real outcome has already been decided by then.
 */
function ignoreLateRejection(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

/** Runs one attempt of a node, enforcing `node.timeoutMs` if it is set. */
async function* runAttempt(
  node: BaseNode,
  ctx: NodeContext,
  nodeInput: unknown,
  controller: AbortController,
): AsyncGenerator<Event, void, void> {
  const generator = node.run(ctx, nodeInput);
  const timeoutMs = node.timeoutMs;
  if (timeoutMs === undefined) {
    yield* generator;
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new NodeTimeoutError({nodeName: node.name, timeoutMs}));
    }, timeoutMs);
  });

  try {
    for (;;) {
      const step = generator.next();
      ignoreLateRejection(step);
      const result = await Promise.race([step, expiry]);
      if (result.done) {
        return;
      }
      yield result.value;
    }
  } finally {
    clearTimeout(timer);
    ignoreLateRejection(generator.return(undefined));
  }
}

/**
 * Runs a node to completion, applying its timeout and retry policy.
 *
 * The timeout is not cancellation: JavaScript cannot preempt a running task,
 * so an expired node run rejects the caller and aborts `ctx.abortSignal`, and
 * a node that does not observe that signal keeps running until its next
 * `await`.
 *
 * @param node The node to run.
 * @param options Where and how to run it.
 * @yields The events the node emits, plus one error event per failed attempt
 *     and one event carrying any state or artifact changes it made.
 * @returns The finished context, carrying the node's `output` and `route`.
 * @throws The node's error once retries are exhausted, or `NodeTimeoutError`.
 */
export async function* runNode(
  node: BaseNode,
  options: RunNodeOptions,
): AsyncGenerator<Event, NodeContext, void> {
  const runId = options.runId ?? '1';
  const parentSignal = options.invocationContext.abortSignal;

  for (let attemptCount = 1; ; attemptCount++) {
    // Relayed by hand rather than with AbortSignal.any: the listener is
    // detached in the `finally` below, so a long invocation running many nodes
    // cannot accumulate dependents on the caller's signal.
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (parentSignal?.aborted) {
      controller.abort();
    } else {
      parentSignal?.addEventListener('abort', onParentAbort, {once: true});
    }

    const ctx = new NodeContext({
      invocationContext: new InvocationContext({
        ...options.invocationContext,
        abortSignal: controller.signal,
      }),
      node,
      runId,
      attemptCount,
      parentNodePath: options.parentNodePath,
    });

    try {
      yield* runAttempt(node, ctx, options.nodeInput, controller);
      if (
        ctx.state.hasDelta() ||
        Object.keys(ctx.actions.artifactDelta).length > 0
      ) {
        yield createEvent({
          author: node.name,
          invocationId: ctx.invocationId,
          actions: ctx.actions,
        });
      }
      return ctx;
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      yield createEvent({
        author: node.name,
        invocationId: ctx.invocationId,
        errorCode: error.name,
        errorMessage: error.message,
      });
      if (!shouldRetryNode(error, node.retryConfig, attemptCount)) {
        throw error;
      }
      const delayMs = getRetryDelayMs(node.retryConfig, attemptCount);
      logger.warn(
        `Node ${node.name} failed with ${error.name} and is being retried in ` +
          `${delayMs} ms (attempt ${attemptCount + 1}).`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } finally {
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  }
}
