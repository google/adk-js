/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session state and state scopes
 * https://adk.dev/graphs/data-handling/#session-state-and-state-scopes
 *
 * A node takes an explicit `(ctx, input)` pair and reads and writes session
 * state through `ctx.state`. A write is visible to every later node in the same
 * run, and is committed with the writing node's events — so `attempts` below is
 * initialized by one node, incremented by a second and read back by a third.
 *
 * State-key prefixes control lifetime and scope:
 *   "app:<key>"   shared across all users and sessions of the app
 *   "user:<key>"  tied to the user, shared across their sessions
 *   "temp:<key>"  discarded when the current invocation ends
 *   "<key>"       persists for the lifetime of the session
 *
 * Caution: state is a lightweight key-value store. Do not use it to move large
 * payloads between nodes — use artifacts or a database tool for those. Passing
 * a value along an edge as node `output` is also the better choice when only
 * the next node needs it; reach for state when a value has to outlive the run,
 * or be read by a tool, a callback, or `{key}` instruction templating.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/data_handling/session_state/agent.ts
 */

import {node, NodeContext, Workflow} from '@google/adk';

const initStateNode = node(
  (ctx: NodeContext, nodeInput: string) => {
    ctx.state.set('topic', nodeInput.trim());
    // Scoped key: dropped when this invocation ends, never persisted.
    ctx.state.set('temp:started_at', new Date().toISOString());
    ctx.state.set('attempts', 0);
  },
  {name: 'init_state_node'},
);

const taskAttemptNode = node(
  (ctx: NodeContext) => {
    // Reads the value init_state_node wrote earlier in this same run.
    const attempts = ctx.state.get<number>('attempts') ?? 0;
    ctx.state.set('attempts', attempts + 1);
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

export const rootAgent = new Workflow({
  name: 'session_state_workflow',
  edges: [['START', initStateNode, taskAttemptNode, readStateNode]],
});
