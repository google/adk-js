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
 * A graph exported as the root, with no `WorkflowAgent` around it. Function
 * nodes rather than an `LlmAgent`, so the run needs no model.
 */
export const rootAgent = new Workflow({
  name: 'workflow_root_graph',
  description: 'Normalizes the question, then answers it.',
  edges: [['START', normalize, answer]],
});
