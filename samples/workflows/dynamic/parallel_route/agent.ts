/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parallel execution routes
 * https://adk.dev/graphs/dynamic/#parallel-execution-routes
 *
 * `ctx.runNode()` returns a promise, so starting every child before awaiting any
 * of them runs them concurrently, and `Promise.all` gathers the results. Run
 * ids are assigned in CALL order, so kick the children off in a synchronous
 * loop to keep them deterministic across a resume.
 *
 * Resuming parallel nodes: on resume only the failed or interrupted workers
 * re-execute; children that already completed are replayed from their
 * checkpoints.
 *
 * Prefer the built-in when the shape is "map one node over a list":
 *   node(worker, {parallelWorker: true, maxParallelWorkers: 4})
 * It does the fan-out for you and bounds concurrency (default 8). Hand-rolling
 * it, as below, is for when you need custom scheduling or partial-failure
 * handling.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/dynamic/parallel_route/agent.ts
 * Enter a comma-separated list, e.g. "alpha, beta, gamma".
 */

import {node, NodeContext, Workflow} from '@google/adk';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The worker run once per list item. */
const realNode = node(
  async (_ctx: NodeContext, item: string) => {
    await sleep(200); // stand-in for real work
    return {item, length: item.length};
  },
  {name: 'analyze_item'},
);

const parallelSupervisor = node(
  async (ctx: NodeContext, nodeInput: string) => {
    const items = nodeInput
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    // Start every child first (no await inside the loop), then gather.
    const tasks = items.map((item) => ctx.runNode(realNode, item));
    const results = await Promise.all(tasks);

    return results.map((result) => result.output);
  },
  {name: 'parallel_supervisor', rerunOnResume: true},
);

const summarize = node(
  (_ctx: NodeContext, results: Array<{item: string; length: number}>) =>
    results.map((r) => `${r.item}: ${r.length} chars`).join('\n'),
  {name: 'summarize'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [['START', parallelSupervisor, summarize]],
});
