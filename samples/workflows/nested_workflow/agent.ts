/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Nested workflow: a Workflow used as a node inside another workflow, alongside
 * a parallel branch and a JoinNode. Mirrors Python `workflows/nested_workflow`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/nested_workflow/agent.ts
 */

import {
  JoinNode,
  node,
  NodeContext,
  Workflow,
  WorkflowAgent,
} from '@google/adk';

const processInput = node(
  (ctx: NodeContext, year: string) => {
    ctx.state.set('year', year.trim());
    return year.trim();
  },
  {name: 'process_input'},
);

// A nested workflow: find a name, then a bio.
const findName = node(
  (_c: NodeContext, year: string) => `A famous person born in ${year}`,
  {name: 'find_name'},
);
const generateBio = node(
  (_c: NodeContext, name: string) => `${name} — a short 3-sentence biography.`,
  {name: 'generate_bio'},
);
const findFamousPerson = new Workflow({
  name: 'find_famous_person',
  edges: [['START', findName, generateBio]],
});

const findHistoricalEvent = node(
  (ctx: NodeContext) => `A significant event in ${ctx.state.get('year')}.`,
  {name: 'find_historical_event'},
);

const aggregate = node(
  (_c: NodeContext, results: Record<string, unknown>) =>
    `Person: ${results['find_famous_person']}\n\nEvent: ${results['find_historical_event']}`,
  {name: 'aggregate_results'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'nested_workflow',
    edges: [
      [
        'START',
        processInput,
        [findFamousPerson, findHistoricalEvent],
        new JoinNode({name: 'join'}),
        aggregate,
      ],
    ],
  }),
);
