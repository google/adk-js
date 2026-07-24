/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent in a workflow: a real LlmAgent as a workflow node, between two function
 * nodes. Mirrors Python `workflows/agent_in_workflow`.
 *
 * REQUIRES an API key (this one calls a live model). Set GEMINI_API_KEY (a
 * `.env` in the working directory is loaded automatically), then:
 *   node dev/dist/esm/cli_entrypoint.js run samples/workflows/agent_in_workflow/agent.ts
 */

import {
  LlmAgent,
  node,
  NodeContext,
  Workflow,
  WorkflowAgent,
} from '@google/adk';

const preprocess = node(
  (_c: NodeContext, input: string) => `Please answer this concisely: ${input}`,
  {name: 'preprocess'},
);

const assistant = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  instruction: 'You are a helpful assistant. Answer the user concisely.',
});

const postprocess = node(
  (_c: NodeContext, answer: string) => `Assistant replied:\n${answer}`,
  {name: 'postprocess'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'agent_in_workflow',
    edges: [['START', preprocess, assistant, postprocess]],
  }),
);
