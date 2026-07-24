/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Node output styles: a raw value, an explicit `Event({output})`, and a
 * structured object consumed downstream. Mirrors Python `workflows/node_output`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/node_output/agent.ts
 */

import {
  createEvent,
  node,
  NodeContext,
  Workflow,
  WorkflowAgent,
} from '@google/adk';

interface TopicDetails {
  title: string;
  description: string;
  category: string;
}

const stringOutput = node(
  (_c: NodeContext, input: string) => `Processed input: ${input}`,
  {name: 'generate_string_output'},
);

const eventOutput = node(
  (_c: NodeContext, input: string) =>
    createEvent({output: `Event-wrapped output: ${input}`}),
  {name: 'generate_event_output'},
);

const structuredOutput = node(
  (_c: NodeContext, input: string): TopicDetails => ({
    title: 'Generated Topic',
    description: `A creative topic based on: ${input}`,
    category: 'general',
  }),
  {name: 'generate_structured_output'},
);

const consumeStructured = node(
  (_c: NodeContext, details: TopicDetails) =>
    `Received structured output!\nTitle: ${details.title}\nDescription: ${details.description}\nCategory: ${details.category}`,
  {name: 'consume_structured_output'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'node_output',
    edges: [
      ['START', stringOutput, eventOutput, structuredOutput, consumeStructured],
    ],
  }),
);
