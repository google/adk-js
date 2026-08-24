/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/node_output.
 *
 * Same four steps: a bare return, an explicit `Event(output=...)`, an
 * `outputSchema` agent, and a consumer that gets the structured value back.
 *
 * Python coerces the agent's dict into `TopicDetails` from the parameter type
 * hint. TS has no runtime type hints, so the equivalent contract goes on the
 * node as `inputSchema` — the same zod object, validated by the framework
 * before the handler runs.
 */
import {createEvent, LlmAgent, node, NodeContext, Workflow} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const topicDetailsSchema = z.object({
  title: z.string().describe('The title of the generated topic.'),
  description: z.string().describe('A short description of the topic.'),
  category: z.string().describe('The broad category of the topic.'),
});
type TopicDetails = z.infer<typeof topicDetailsSchema>;

/** Returns a simple string. Framework automatically wraps it in an Event. */
const generateStringOutput = node(
  (_ctx: NodeContext, nodeInput: string) => `Processed input: ${nodeInput}`,
  {name: 'generate_string_output'},
);

/** Explicitly returns an Event object for more control. */
const generateEventOutput = node(
  (_ctx: NodeContext, nodeInput: string) =>
    createEvent({output: `Event wrapped output: ${nodeInput}`}),
  {name: 'generate_event_output'},
);

const generatePydanticOutput = new LlmAgent({
  name: 'generate_pydantic_output',
  model: PARITY_MODEL,
  instruction: 'Generate a creative topic based on the following input.',
  outputSchema: topicDetailsSchema,
});

/**
 * Relying on the node's declared `inputSchema`.
 * The framework will coerce the dictionary or JSON into a TopicDetails
 * object automatically.
 */
const consumePydanticOutput = node(
  (_ctx: NodeContext, nodeInput: TopicDetails) =>
    'Received Pydantic Model!\n' +
    `Title: ${nodeInput.title}\n` +
    `Description: ${nodeInput.description}\n` +
    `Category: ${nodeInput.category}`,
  {name: 'consume_pydantic_output', inputSchema: topicDetailsSchema},
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
