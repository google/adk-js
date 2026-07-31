/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseNode} from '../base_node.js';
import {NodeContext} from '../node_context.js';
import {RetryConfig} from '../retry_config.js';
import {registerParallelWorkerFactory} from '../utils/workflow_graph_utils.js';

/** Options for a {@link ParallelWorker}. */
export interface ParallelWorkerConfig {
  /** Maximum number of items processed concurrently. `undefined` = unlimited. */
  maxParallelWorkers?: number;
  retryConfig?: RetryConfig;
  timeout?: number;
}

/**
 * A node that runs a wrapped node in parallel for each item of a list input,
 * preserving order, bounded by `maxParallelWorkers`, cancelling on first error.
 *
 * Ported from `google/adk-python` `workflow/_parallel_worker.py`. A non-list
 * input is treated as a single-element list. Each item runs via
 * `ctx.runNode(inner, item, {useSubBranch: true})`; the node's output is the
 * ordered list of the children's outputs.
 */
export class ParallelWorker extends BaseNode {
  readonly maxParallelWorkers?: number;
  private readonly inner: BaseNode;

  constructor(inner: BaseNode, config: ParallelWorkerConfig = {}) {
    super({
      name: inner.name,
      rerunOnResume: true,
      retryConfig: config.retryConfig,
      timeout: config.timeout,
    });
    if (
      config.maxParallelWorkers !== undefined &&
      config.maxParallelWorkers < 1
    ) {
      throw new Error('maxParallelWorkers must be greater than or equal to 1.');
    }
    this.inner = inner;
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
      this.maxParallelWorkers ?? items.length,
      items.length,
    );

    let nextIndex = 0;
    let firstError: unknown;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (firstError !== undefined) {
          return;
        }
        const i = nextIndex++;
        if (i >= items.length) {
          return;
        }
        try {
          // Key each child run by its item index (not call order) so the
          // run id -> item mapping is deterministic. On resume this lets each
          // item fast-forward from its own cached run rather than being matched
          // to a differently-ordered run id.
          const child = await ctx.runNode(this.inner, items[i], {
            useSubBranch: true,
            runId: String(i),
          });
          results[i] = child.output;
        } catch (err) {
          if (firstError === undefined) {
            firstError = err;
          }
          return;
        }
      }
    };

    await Promise.all(Array.from({length: poolSize}, () => worker()));

    if (firstError !== undefined) {
      throw firstError;
    }
    yield results;
  }
}

/**
 * Registers the factory the engine uses to wrap a built node in a
 * {@link ParallelWorker} when `buildNode(..., {parallelWorker: true})` is
 * requested — keeping the engine core free of a static import of this module.
 */
registerParallelWorkerFactory(
  (inner, options) => new ParallelWorker(inner, options),
);
