/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Node output styles: a raw string, an explicit `Event({output})`, a
 * schema-typed LlmAgent output, and a downstream node consuming it. One-to-one
 * port of Python `contributing/samples/workflows/node_output/agent.py`.
 *
 * Requires an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- tests/integration/workflows/node_output/agent.ts
 */

import {createEvent, LlmAgent, node, NodeContext, Workflow} from '@google/adk';
import {z} from 'zod';

const topicDetails = z.object({
  title: z.string().describe('The title of the generated topic.'),
  description: z.string().describe('A short description of the topic.'),
  category: z.string().describe('The broad category of the topic.'),
});

const generateStringOutput = node(
  // Returns a simple string; the framework wraps it in an Event.
  (_c: NodeContext, nodeInput: string) => `Processed input: ${nodeInput}`,
  {name: 'generate_string_output'},
);

const generateEventOutput = node(
  // Explicitly returns an Event for more control.
  (_c: NodeContext, nodeInput: string) =>
    createEvent({output: `Event wrapped output: ${nodeInput}`}),
  {name: 'generate_event_output'},
);

const generatePydanticOutput = new LlmAgent({
  name: 'generate_pydantic_output',
  model: 'gemini-2.5-flash',
  instruction: 'Generate a creative topic based on the following input.',
  outputSchema: topicDetails,
});

const consumePydanticOutput = node(
  (_c: NodeContext, nodeInput: z.infer<typeof topicDetails>) =>
    'Received Pydantic Model!\n' +
    `Title: ${nodeInput.title}\n` +
    `Description: ${nodeInput.description}\n` +
    `Category: ${nodeInput.category}`,
  {name: 'consume_pydantic_output', inputSchema: topicDetails},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [
    [
      'START',
      generateStringOutput,
      generateEventOutput,
      generatePydanticOutput,
      consumePydanticOutput,
    ],
  ],
});
