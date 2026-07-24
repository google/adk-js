/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Message: a node emits a display message (event content) distinct from its
 * structured output. Mirrors Python `workflows/message`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/message/agent.ts
 */

import {
  createEvent,
  node,
  NodeContext,
  Workflow,
  WorkflowAgent,
} from '@google/adk';

const greet = node(
  (_c: NodeContext, name: string) =>
    createEvent({
      content: {
        role: 'model',
        parts: [
          {
            text: `Hello, ${name}! This event carries a message for display, but no structured output.`,
          },
        ],
      },
    }),
  {name: 'greet'},
);

const withOutput = node(
  (_c: NodeContext, name: string) =>
    createEvent({
      content: {
        role: 'model',
        parts: [{text: `(also produced an output value)`}],
      },
      output: {greeted: name},
    }),
  {name: 'greet_with_output'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'message_sample',
    edges: [['START', greet, withOutput]],
  }),
);
