/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TypeScript port of the Python snippet in
 * https://adk.dev/graphs/data-handling/#session-state-and-state-scopes
 *
 *   async def init_state_node(attempts: int = 0):
 *     yield Event(state={"attempts": attempts})
 *
 *   async def task_attempt_node(node_input: Content, attempts: int):
 *     yield Event(state={"attempts": attempts + 1})
 *
 *   async def read_state_node(ctx: Context):
 *     print(f"attempts state: {ctx.state}")   # attempts state: attempts: 1
 *
 * Python binds state values to named function parameters by signature
 * introspection. TypeScript nodes take an explicit `(ctx, input)` pair instead,
 * so you read and write the same session state through `ctx.state` — writes
 * accumulate in the node's state delta and are committed with its events.
 *
 * State-key prefixes control lifetime and scope:
 *   "app:<key>"   shared across all users and sessions of the app
 *   "user:<key>"  tied to the user, shared across their sessions
 *   "temp:<key>"  discarded when the current invocation ends
 *   "<key>"       persists for the lifetime of the session
 *
 * !! Gotcha: do not read-modify-write ONE key from several nodes. !!
 * A node's writes land in `ctx.state` immediately, but they are also replayed
 * from that node's event when the runtime commits it — and that commit lags the
 * graph by an event or two. So a later node that re-reads a key an earlier node
 * also wrote can observe the earlier (already-superseded) value. Keep each
 * state key single-writer, and move evolving values along the edges as node
 * `output`, the way `attempts` travels below.
 *
 * Caution: state is a lightweight key-value store. Do not use it to move large
 * payloads between nodes — use artifacts or a database tool for those.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/data_handling/session_state/agent.ts
 */

import {node, NodeContext, WorkflowAgent} from '@google/adk';

const initStateNode = node(
  (ctx: NodeContext, nodeInput: string) => {
    ctx.state.set('topic', String(nodeInput).trim());
    // Scoped key: dropped when this invocation ends, never persisted.
    ctx.state.set('temp:started_at', new Date().toISOString());
    // The counter travels as node output, not as a re-read state key.
    return 0;
  },
  {name: 'init_state_node'},
);

const taskAttemptNode = node(
  (ctx: NodeContext, attempts: number) => {
    const next = attempts + 1;
    // Single writer for this key, so downstream reads are stable.
    ctx.state.set('attempts', next);
    return next;
  },
  {name: 'task_attempt_node'},
);

const readStateNode = node(
  (ctx: NodeContext) =>
    `attempts state: ${ctx.state.get('attempts')} ` +
    `(topic: ${ctx.state.get('topic')}, ` +
    `started: ${ctx.state.get('temp:started_at')})`,
  {name: 'read_state_node'},
);

export const rootAgent = new WorkflowAgent({
  name: 'session_state_workflow',
  edges: [['START', initStateNode, taskAttemptNode, readStateNode]],
});
