/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/state.
 *
 * The Python sample demonstrates four state techniques; three port directly
 * and the fourth cannot:
 *   1. `ctx.state["k"] = v`            -> `ctx.state.set('k', v)`
 *   2. `yield Event(state={...})`      -> `createEvent({actions: {stateDelta}})`
 *   3. `ctx.state["k"]`                -> `ctx.state.get('k')`
 *   4. parameter injection by name     -> NOT a TS feature. A handler is always
 *      `(ctx, input)` and nothing is bound by parameter name, so
 *      `read_state_via_param` reads the same key through `ctx.state`. Graph
 *      shape, node names and outputs are unchanged.
 */
import {createEvent, node, NodeContext, Workflow} from '@google/adk';

/** Takes initial input and sets it in state via direct dict modification. */
const processInitialInput = node(
  (ctx: NodeContext, nodeInput: string) => {
    ctx.state.set('original_text', nodeInput);
    return nodeInput;
  },
  {name: 'process_initial_input'},
);

/** Returns an Event that implicitly updates the shared workflow state. */
const updateStateViaEvent = node(
  (_ctx: NodeContext, nodeInput: string) =>
    createEvent({
      actions: {stateDelta: {uppercased_text: nodeInput.toUpperCase()}},
    }),
  {name: 'update_state_via_event'},
);

/** Reads a state variable via direct dictionary access and appends to it. */
const readStateViaCtx = node(
  (ctx: NodeContext) => {
    const original = ctx.state.get('original_text');
    const uppercased = ctx.state.get('uppercased_text');

    const result = `${uppercased} (Original was: ${original})`;
    ctx.state.set('appended_text', result);
    return result;
  },
  {name: 'read_state_via_ctx'},
);

/** Reads a state variable — by key, since TS injects nothing by name. */
const readStateViaParam = node(
  (ctx: NodeContext) => `Final Result: ${ctx.state.get('appended_text')}!`,
  {name: 'read_state_via_param'},
);

export const rootAgent = new Workflow({
  name: 'state_sample',
  edges: [
    [
      'START',
      processInitialInput,
      updateStateViaEvent,
      readStateViaCtx,
      readStateViaParam,
    ],
  ],
});
