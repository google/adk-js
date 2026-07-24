/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parallel worker: `node(fn, {parallelWorker: true})` maps a node across each
 * item of a list input with bounded concurrency. Mirrors Python
 * `workflows/parallel_worker`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/parallel_worker/agent.ts
 */

import {node, NodeContext, Workflow, WorkflowAgent} from '@google/adk';

const findTopics = node(() => ['ai', 'databases', 'networking'], {
  name: 'find_related_topics',
});

const explainTopic = node(
  (_c: NodeContext, topic: string) =>
    `${topic.toUpperCase()}: a short explanation of ${topic}.`,
  {name: 'explain_topic', parallelWorker: true, maxParallelWorkers: 3},
);

const aggregate = node(
  (_c: NodeContext, explanations: string[]) => explanations.join('\n\n---\n\n'),
  {name: 'aggregate'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'parallel_worker',
    edges: [['START', findTopics, explainTopic, aggregate]],
  }),
);
