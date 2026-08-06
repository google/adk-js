/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  NodeBuilder,
  ParallelWorkerFactory,
} from './utils/workflow_graph_utils.js';

/**
 * The built-in node builders, consulted in order by `buildNode` / `isNodeLike`
 * to turn a bare function / tool / agent into the right `BaseNode`.
 *
 * This is a single, explicit, statically-imported list — node-type modules are
 * wired in here rather than self-registering at import time, so there is no
 * global mutable registry and no import-order side effects. Order is the match
 * precedence (first match wins). Each node-type part adds its builder here; the
 * list is empty in the engine-core part.
 */
export const NODE_BUILDERS: readonly NodeBuilder[] = [];

/**
 * Wraps an already-built node in a parallel worker. Wired in by the
 * parallel-worker node part; `undefined` until then, so requesting
 * `parallelWorker` before that part is present throws.
 */
export const PARALLEL_WORKER_FACTORY: ParallelWorkerFactory | undefined =
  undefined;
