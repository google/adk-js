/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {node, NodeContext, Workflow} from '@google/adk';

const normalize = node(
  (_ctx: NodeContext, question: string) => question.trim().toLowerCase(),
  {name: 'normalize'},
);

const answer = node(
  (_ctx: NodeContext, question: string) => `graph handled: ${question}`,
  {name: 'answer'},
);

/**
 * A directory entrypoint whose root is a bare `Workflow`, with no `App` around
 * it. Function nodes rather than an `LlmAgent`, so it can
 * be run for real without a model.
 */
export const rootAgent = new Workflow({
  name: 'graph_workflow',
  description: 'Normalizes the question, then answers it.',
  edges: [['START', normalize, answer]],
});
