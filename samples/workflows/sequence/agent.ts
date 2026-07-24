/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sequence workflow: a linear chain of nodes where each node's output feeds the
 * next. Mirrors the Python `workflows/sequence` sample (using function nodes so
 * it runs offline without an API key).
 *
 * Run:  npm run sample -- samples/workflows/sequence/agent.ts
 */

import {node, NodeContext, Workflow, WorkflowAgent} from '@google/adk';

const generateFruit = node(() => 'apple', {name: 'generate_fruit'});

const describeFruit = node(
  (_ctx: NodeContext, fruit: string) =>
    `A ${fruit} a day keeps the doctor away.`,
  {name: 'describe_fruit'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'sequence_workflow',
    edges: [['START', generateFruit, describeFruit]],
  }),
);
