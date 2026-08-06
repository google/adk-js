/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {WorkflowAgent} from '../../src/workflow/workflow_agent.js';

async function drain(gen: AsyncGenerator<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

async function runOnce(agent: WorkflowAgent, text = 'x') {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'test_app',
    userId: 'u1',
  });
  const runner = new Runner({appName: 'test_app', agent, sessionService});
  const events = await drain(
    runner.runAsync({
      userId: 'u1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text}]},
    }),
  );
  const finalSession = await sessionService.getSession({
    appName: 'test_app',
    userId: 'u1',
    sessionId: session.id,
  });
  return {events, state: finalSession?.state ?? {}};
}

describe('workflow state consistency across nodes', () => {
  it('a node observes the most recent write to a key, not an earlier one', async () => {
    // Regression: the runner's event commit lags node execution and re-applies
    // each event's stateDelta to the live session state. Re-applying `a`'s
    // delta used to roll back `b`'s write, so `c` read 0 instead of 1.
    const reads: Array<number | undefined> = [];

    const a = new FunctionNode('a', (ctx: NodeContext) => {
      ctx.state.set('attempts', 0);
      return 'a';
    });
    const b = new FunctionNode('b', (ctx: NodeContext) => {
      const seen = ctx.state.get<number>('attempts') ?? -1;
      ctx.state.set('attempts', seen + 1);
      return 'b';
    });
    const c = new FunctionNode('c', (ctx: NodeContext) => {
      reads.push(ctx.state.get<number>('attempts'));
      return 'c';
    });

    const {state} = await runOnce(
      new WorkflowAgent({name: 'state_wf', edges: [['START', a, b, c]]}),
    );

    expect(reads).toEqual([1]);
    // The committed session state still ends up correct.
    expect(state['attempts']).toBe(1);
  });

  it('survives a long read-modify-write chain', async () => {
    const reads: number[] = [];
    const bump = (name: string) =>
      new FunctionNode(name, (ctx: NodeContext) => {
        const next = (ctx.state.get<number>('n') ?? 0) + 1;
        ctx.state.set('n', next);
        reads.push(next);
        return name;
      });

    const nodes = ['n1', 'n2', 'n3', 'n4', 'n5'].map(bump);
    const {state} = await runOnce(
      new WorkflowAgent({name: 'chain_wf', edges: [['START', ...nodes]]}),
    );

    expect(reads).toEqual([1, 2, 3, 4, 5]);
    expect(state['n']).toBe(5);
  });

  it('still reads state that was seeded on the session before the run', async () => {
    const seen: Array<string | undefined> = [];
    const read = new FunctionNode('read', (ctx: NodeContext) => {
      seen.push(ctx.state.get<string>('seeded'));
      return 'read';
    });

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
      state: {seeded: 'from-before'},
    });
    const agent = new WorkflowAgent({
      name: 'seeded_wf',
      edges: [['START', read]],
    });
    const runner = new Runner({appName: 'test_app', agent, sessionService});
    await drain(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'x'}]},
      }),
    );

    expect(seen).toEqual(['from-before']);
  });

  it('writes remain visible on session.state for instruction templating', async () => {
    // Agent instruction templates resolve `{key}` against
    // `invocationContext.session.state`, so node writes must still land there
    // synchronously — the overlay must not divert them.
    let observed: unknown;
    const write = new FunctionNode('write', (ctx: NodeContext) => {
      ctx.state.set('topic', 'oceans');
      return 'write';
    });
    const peek = new FunctionNode('peek', (ctx: NodeContext) => {
      observed = ctx.invocationContext.session.state['topic'];
      return 'peek';
    });

    await runOnce(
      new WorkflowAgent({name: 'tmpl_wf', edges: [['START', write, peek]]}),
    );

    expect(observed).toBe('oceans');
  });

  it('does not leak one invocation\u2019s overlay into another session', async () => {
    // The overlay is keyed by the session's live state object and guarded by
    // invocation id, so a second, unrelated run starts from a clean slate.
    const seen: Array<number | undefined> = [];
    const bump = new FunctionNode('bump', (ctx: NodeContext) => {
      const next = (ctx.state.get<number>('count') ?? 0) + 1;
      ctx.state.set('count', next);
      seen.push(next);
      return next;
    });
    const agent = new WorkflowAgent({
      name: 'isolated_wf',
      edges: [['START', bump]],
    });

    await runOnce(agent, 'one');
    await runOnce(agent, 'two');

    expect(seen).toEqual([1, 1]);
  });
});
