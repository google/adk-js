/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Vendored copy of samples/workflows/nested_workflow/agent.ts so this integration test
// is self-contained; keep it in sync with the sample.

/**
 * Nested workflow: a sub-Workflow used as a node, running in parallel with an
 * agent, joined and aggregated. Faithful port of Python
 * `contributing/samples/workflows/nested_workflow`.
 *
 * Requires an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/workflows/nested_workflow/agent.ts
 * Enter a 4-digit year, e.g. "1955".
 */

import {
  createEvent,
  JoinNode,
  LlmAgent,
  node,
  NodeContext,
  Workflow,
} from '@google/adk';

const processInput = node(
  function* (ctx: NodeContext, nodeInput: string) {
    const match = String(nodeInput).match(/\b\d{4}\b/);
    if (!match) {
      yield createEvent({
        content: {
          role: 'model',
          parts: [{text: 'Please provide a valid 4-digit year (e.g., 1955).'}],
        },
      });
      throw new Error('Invalid year format.');
    }
    ctx.state.set('year', match[0]);
  },
  {name: 'process_input'},
);

const findName = new LlmAgent({
  name: 'find_name',
  model: 'gemini-2.5-flash',
  instruction: `
    Find the name of one famous person who was born in this year: {year}.
    Return ONLY their name, nothing else.
    `,
});

const generateBio = new LlmAgent({
  name: 'generate_bio',
  model: 'gemini-2.5-flash',
  instruction: `
    Write a short, engaging 3-sentence biography for the specified person.
    `,
});

// Sub-workflow that acts as a single node in the parent workflow.
const findFamousPerson = new Workflow({
  name: 'find_famous_person',
  edges: [['START', findName, generateBio]],
});

const findHistoricalEvent = new LlmAgent({
  name: 'find_historical_event',
  model: 'gemini-2.5-flash',
  instruction: `
    Describe one highly significant historical event that occurred in this year: {year}.
    Keep the description to 2 sentences.
    `,
});

const joinForAggregation = new JoinNode({name: 'join_for_aggregation'});

const aggregateResults = node(
  function* (ctx: NodeContext, nodeInput: Record<string, string>) {
    const year = ctx.state.get('year');
    const combined =
      `# Year: ${year}\n\n` +
      '## Famous Person Bio:\n\n' +
      `${nodeInput['find_famous_person']}\n\n` +
      '## Historical Event:\n\n' +
      `${nodeInput['find_historical_event']}`;
    yield createEvent({content: {role: 'model', parts: [{text: combined}]}});
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
