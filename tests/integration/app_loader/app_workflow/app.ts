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
  (_ctx: NodeContext, question: string) =>
    `Hello from a bare Workflow root: ${question}`,
  {name: 'answer'},
);

/**
 * An entrypoint that exports a graph as the root, with no `App` around it. Function nodes rather than an `LlmAgent`, so the run needs no
 * model and no recorded response.
 */
export const rootAgent = new Workflow({
  name: 'workflow_app_integration',
  description: 'Normalizes the question, then answers it.',
  edges: [['START', normalize, answer]],
});
