/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * State: several ways to read/write shared workflow state. One-to-one port of
 * Python `contributing/samples/workflows/state/agent.py`.
 *
 * TypeScript note: Python's `read_state_via_param` reads a state value by
 * automatic parameter-name injection. `FunctionNode` in TypeScript has a fixed
 * `(ctx, input)` signature, so the value is read explicitly via `ctx.state`.
 * See the gap report.
 *
 * Run (offline):  npm run sample -- tests/integration/workflows/state/agent.ts
 */

import {node, NodeContext, Workflow} from '@google/adk';

function processInitialInput(ctx: NodeContext, nodeInput: string): string {
  // Set initial input in state via direct dictionary modification.
  ctx.state.set('original_text', nodeInput);
  return nodeInput;
}

function updateStateViaEvent(ctx: NodeContext, nodeInput: string): void {
  ctx.state.set('uppercased_text', nodeInput.toUpperCase());
}

function readStateViaCtx(ctx: NodeContext): string {
  const original = ctx.state.get('original_text');
  const uppercased = ctx.state.get('uppercased_text');
  const result = `${uppercased} (Original was: ${original})`;
  ctx.state.set('appended_text', result);
  return result;
}

function readStateViaParam(ctx: NodeContext): string {
  const appendedText = ctx.state.get('appended_text');
  return `Final Result: ${appendedText}!`;
}

export const rootAgent = new Workflow({
  name: 'state_sample',
  edges: [
    [
      'START',
      node(processInitialInput, {name: 'process_initial_input'}),
      node(updateStateViaEvent, {name: 'update_state_via_event'}),
      node(readStateViaCtx, {name: 'read_state_via_ctx'}),
      node(readStateViaParam, {name: 'read_state_via_param'}),
    ],
  ],
});
