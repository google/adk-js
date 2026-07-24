/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * State: share data across nodes via `ctx.state`. Mirrors Python
 * `workflows/state`. (TypeScript reads state explicitly via `ctx.state.get`
 * rather than Python's by-name parameter injection.)
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/state/agent.ts
 */

import {node, NodeContext, Workflow, WorkflowAgent} from '@google/adk';

const processInitialInput = node(
  (ctx: NodeContext, input: string) => {
    ctx.state.set('original_text', input);
    return input;
  },
  {name: 'process_initial_input'},
);

const updateStateViaEvent = node(
  (ctx: NodeContext, input: string) => {
    const upper = input.toUpperCase();
    ctx.state.set('uppercased_text', upper);
    return upper;
  },
  {name: 'update_state_via_event'},
);

const readStateViaCtx = node(
  (ctx: NodeContext) => {
    const upper = ctx.state.get('uppercased_text');
    const original = ctx.state.get('original_text');
    const appended = `${upper} (Original was: ${original})`;
    ctx.state.set('appended_text', appended);
    return appended;
  },
  {name: 'read_state_via_ctx'},
);

const readState = node(
  (ctx: NodeContext) => `Final Result: ${ctx.state.get('appended_text')}!`,
  {name: 'read_state'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'state_sample',
    edges: [
      [
        'START',
        processInitialInput,
        updateStateViaEvent,
        readStateViaCtx,
        readState,
      ],
    ],
  }),
);
