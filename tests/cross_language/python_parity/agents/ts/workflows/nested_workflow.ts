/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/nested_workflow.
 *
 * A `Workflow` is a `BaseNode` in both runtimes, so `find_famous_person` drops
 * straight into the parent's edges as one node and the graph translates
 * one-to-one.
 *
 * Two node-level differences:
 *   - Python's `Event(state={...})` becomes `createEvent({actions:
 *     {stateDelta}})`; the delta rides on the node's event either way.
 *   - `aggregate_results(node_input, year)` gets `year` injected by parameter
 *     name from state. TS binds nothing by name — a handler is always
 *     `(ctx, input)` — so `year` is read through `ctx.state`.
 */
import {
  createEvent,
  JoinNode,
  LlmAgent,
  node,
  NodeContext,
  Workflow,
} from '@google/adk';

import {PARITY_MODEL} from '../model.ts';

/** Validates the input is a valid 4-digit year. */
const processInput = node(
  function* (_ctx: NodeContext, nodeInput: string) {
    const match = /\b\d{4}\b/.exec(nodeInput);
    if (!match) {
      yield createEvent({
        content: {
          role: 'model',
          parts: [{text: 'Please provide a valid 4-digit year (e.g., 1955).'}],
        },
      });
      throw new Error('Invalid year format.');
    }

    yield createEvent({actions: {stateDelta: {year: match[0]}}});
  },
  {name: 'process_input'},
);

const findName = new LlmAgent({
  name: 'find_name',
  model: PARITY_MODEL,
  instruction: `
    Find the name of one famous person who was born in this year: {year}.
    Return ONLY their name, nothing else.
    `,
});

const generateBio = new LlmAgent({
  name: 'generate_bio',
  model: PARITY_MODEL,
  instruction: `
    Write a short, engaging 3-sentence biography for the specified person.
    `,
});

// Sub-workflow that acts as a single node in the parent workflow
const findFamousPerson = new Workflow({
  name: 'find_famous_person',
  edges: [['START', findName, generateBio]],
});

const findHistoricalEvent = new LlmAgent({
  name: 'find_historical_event',
  model: PARITY_MODEL,
  instruction: `
    Describe one highly significant historical event that occurred in this year: {year}.
    Keep the description to 2 sentences.
    `,
});

const joinForAggregation = new JoinNode({name: 'join_for_aggregation'});

/** Combines outputs from parallel branches found in context state. */
const aggregateResults = node(
  function* (ctx: NodeContext, nodeInput: Record<string, string>) {
    const year = ctx.state.get('year');

    const combinedMessage =
      `# Year: ${year}\n\n` +
      '## Famous Person Bio:\n\n' +
      `${nodeInput['find_famous_person']}\n\n` +
      '## Historical Event:\n\n' +
      `${nodeInput['find_historical_event']}`;
    yield createEvent({
      content: {role: 'model', parts: [{text: combinedMessage}]},
    });
  },
  {name: 'aggregate_results'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [
    [
      'START',
      processInput,
      [findFamousPerson, findHistoricalEvent],
      joinForAggregation,
      aggregateResults,
    ],
  ],
});
