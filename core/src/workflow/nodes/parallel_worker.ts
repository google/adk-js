/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseNode} from '../base_node.js';
import {RunnableNode} from '../graph.js';
import {NodeContext} from '../node_context.js';
import {buildNode} from '../utils/workflow_graph_utils.js';

/**
 * Default concurrency when `maxParallelWorkers` is not set. Bounded so a
 * data-driven list length can't fan out into an unbounded burst of concurrent
 * inner runs (a rate-limit / cost hazard when the inner node is an LLM or a
 * remote tool). Pass `Infinity` for explicitly unbounded concurrency.
 */
const DEFAULT_MAX_PARALLEL_WORKERS = 8;

/** Options for a {@link ParallelWorker}. */
export interface ParallelWorkerConfig {
  /**
   * Maximum number of items processed concurrently. Defaults to
   * `DEFAULT_MAX_PARALLEL_WORKERS` (8); pass `Infinity` for unbounded.
   */
  maxParallelWorkers?: number;
}

/**
 * A node that runs a wrapped node once per item of a list input, preserving
 * order, bounded by `maxParallelWorkers`, and stopping on the first error.
 *
 * Ported from `google/adk-python` `workflow/_parallel_worker.py`. A non-list
 * input is treated as a single-element list. Each item runs via
 * `ctx.runNode(inner, item, {useSubBranch: true})`; the node's output is the
 * ordered list of the children's outputs.
 *
 * The wrapped value is anything an edge accepts — an agent, a tool, a plain
 * function, or an already-built node — and is built the same way, so
 * `new ParallelWorker(myAgent)` works without `node(myAgent)`. It is built when
 * the worker is constructed, not per item, so every item runs the one inner
 * node — which is also where the worker's own name comes from.
 *
 * Notes:
 * - **retry/timeout live on the inner node.** `retryConfig`/`timeout` passed to
 *   `buildNode` apply to the wrapped node (per item); the ParallelWorker itself
 *   carries neither, so the two levels don't compose. Wrapping the value
 *   yourself — `new ParallelWorker(node(myAgent, {timeout: 5}))` — is how those
 *   options are set.
 * - **All-or-nothing.** If any item throws, the first error is rethrown and the
 *   already-computed sibling outputs are discarded. Make individual items
 *   failure-tolerant if partial results matter.
 * - **An item that interrupts pauses the whole worker.** It has no output to
 *   contribute, so the worker stops claiming items, emits no list, and raises
 *   the child's interrupt ids as its own. Once they are answered the worker
 *   re-runs from the top (`rerunOnResume`), and items that already completed
 *   are fast-forwarded by their run id rather than executed again.
 * - **Cancellation stops scheduling only.** On abort/timeout the loop stops
 *   claiming new items, but items already in flight run to completion —
 *   `ctx.runNode` has no way to forward a signal into a child run.
 */
export class ParallelWorker extends BaseNode {
  readonly maxParallelWorkers?: number;
  private readonly inner: BaseNode;

  constructor(inner: RunnableNode, config: ParallelWorkerConfig = {}) {
    const built = buildNode(inner);
    super({name: built.name, rerunOnResume: true});
    if (
      config.maxParallelWorkers !== undefined &&
      config.maxParallelWorkers < 1
    ) {
      throw new Error('maxParallelWorkers must be greater than or equal to 1.');
    }
    this.inner = built;
    this.maxParallelWorkers = config.maxParallelWorkers;
  }

  protected async *runImpl(
    ctx: NodeContext,
    input: unknown,
  ): AsyncGenerator<unknown, void, void> {
    const items = Array.isArray(input) ? input : [input];
    if (items.length === 0) {
      yield [];
      return;
    }

    const results = new Array<unknown>(items.length);
    const poolSize = Math.min(
      this.maxParallelWorkers ?? DEFAULT_MAX_PARALLEL_WORKERS,
      items.length,
    );

    let nextIndex = 0;
    // Separate flag from `firstError` so an item that rejects with `undefined`
    // (a bare `Promise.reject()`) still counts as a failure instead of leaving a
    // silent hole in `results` and resolving successfully.
    let failed = false;
    let firstError: unknown;
    // An item that stops to ask the user has no result to contribute, so the
    // fan-out stops claiming work the same way a failure does.
    let interrupted = false;
    const interruptIds: string[] = [];

    // Populated only when the ParallelWorker itself declares a timeout; on a
    // plain invocation abort the invocation-level signal is the one that fires.
    const isAborted = (): boolean =>
      ctx.abortSignal?.aborted === true ||
      ctx.invocationContext.abortSignal?.aborted === true;

    // Keep claiming the next item until the list is exhausted, an item fails,
    // or the invocation is aborted.
    const worker = async (): Promise<void> => {
      while (!failed && !interrupted && !isAborted()) {
        const i = nextIndex++;
        if (i >= items.length) {
          break;
        }
        try {
          // Key each child by its item index (not completion order): the runId
          // makes the run deterministic, and the distinct node path makes each
          // child's events attributable (they'd otherwise all share the inner
          // node's path). The scheduler uses the same runId to fast-forward each
          // item on resume (lands with the scheduler in a later part).
          const child = await ctx.runNode(this.inner, items[i], {
            useSubBranch: true,
            runId: String(i),
            overrideNodePath: `${ctx.nodePath}.${this.inner.name}@${i}`,
          });
          if (child.interruptIds.length > 0) {
            interrupted = true;
            for (const id of child.interruptIds) {
              if (!interruptIds.includes(id)) {
                interruptIds.push(id);
              }
            }
            break;
          }
          results[i] = child.output;
        } catch (err) {
          if (!failed) {
            failed = true;
            firstError = err;
          }
          break;
        }
      }
    };

    await Promise.all(Array.from({length: poolSize}, () => worker()));

    if (failed) {
      throw firstError;
    }
    if (interrupted) {
      for (const id of interruptIds) {
        if (!ctx.interruptIds.includes(id)) {
          ctx.interruptIds.push(id);
        }
      }
      return;
    }
    if (isAborted()) {
      // Aborted mid-flight: `results` may have holes for unscheduled items, so
      // don't emit a wrong partial list — the invocation is being torn down.
      return;
    }
    yield results;
  }
}

// The factory the engine uses to wrap a built node in a ParallelWorker (for
// `buildNode(..., {parallelWorker: true})`) is wired into PARALLEL_WORKER_FACTORY
// in ../node_builders.ts.
