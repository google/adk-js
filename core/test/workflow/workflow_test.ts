/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {createEvent, Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {Session} from '../../src/sessions/session.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {DEFAULT_ROUTE} from '../../src/workflow/graph.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {EventChannel} from '../../src/workflow/utils/event_channel.js';
import {Workflow} from '../../src/workflow/workflow.js';

function createIc(): InvocationContext {
  const session = {
    id: 's1',
    appName: 'app',
    userId: 'u',
    events: [],
    state: {},
    lastUpdateTime: Date.now(),
  } as unknown as Session;
  return new InvocationContext({
    invocationId: 'inv-1',
    session,
    agent: {
      name: 'wf',
      runAsync: async function* () {},
    } as unknown as BaseAgent,
    pluginManager: new PluginManager(),
  });
}

async function driveWorkflow(
  workflow: Workflow,
  input?: unknown,
): Promise<{events: Event[]; output: unknown}> {
  const channel = new EventChannel<Event>();
  const root = new NodeContext({
    invocationContext: createIc(),
    channel,
    nodePath: '',
    runId: 'root',
  });
  const events: Event[] = [];
  const run = root.runNode(workflow, input, {useAsOutput: true}).then(
    () => channel.close(),
    (err) => channel.fail(err),
  );
  for await (const ev of channel) {
    events.push(ev);
  }
  await run;
  return {events, output: root.output};
}

// Yields whatever the function returns (value | Event).
class FnNode extends BaseNode {
  constructor(
    name: string,
    private readonly fn: (ctx: NodeContext, input: unknown) => unknown,
  ) {
    super({name});
  }
  protected async *runImpl(ctx: NodeContext, input: unknown) {
    yield await this.fn(ctx, input);
  }
}

// Fan-in barrier: waits for all predecessors, then emits the aggregated inputs.
class JoinNode extends BaseNode {
  override get requiresAllPredecessors(): boolean {
    return true;
  }
  protected async *runImpl(_ctx: NodeContext, input: unknown) {
    yield input;
  }
}

describe('Phase 2 — Workflow orchestration', () => {
  it('runs a linear sequence and threads input downstream (baseline bug fix)', async () => {
    const a = new FnNode('step_a', (_c, input) => `${input}->A`);
    const b = new FnNode('step_b', (_c, input) => `${input}->B`);
    const c = new FnNode('step_c', (_c, input) => `${input}->C`);
    const wf = new Workflow({name: 'seq', edges: [['START', a, b, c]]});

    const {output, events} = await driveWorkflow(wf, 'INIT');

    // The initial input reaches the first node (previously 'undefined->A').
    expect(output).toBe('INIT->A->B->C');
    const outputs = events
      .filter((e) => e.output !== undefined)
      .map((e) => e.output);
    expect(outputs).toEqual(['INIT->A', 'INIT->A->B', 'INIT->A->B->C']);
  });

  it('routes conditionally via a routing map', async () => {
    const router = new FnNode('router', (_c, input) =>
      createEvent({
        route: (input as string).endsWith('?') ? 'question' : 'statement',
        output: input,
      }),
    );
    const q = new FnNode('answer', (_c, input) => `Q:${input}`);
    const s = new FnNode('comment', (_c, input) => `S:${input}`);
    const wf = new Workflow({
      name: 'router_wf',
      edges: [
        ['START', router],
        [router, {question: q, statement: s}],
      ],
    });

    expect((await driveWorkflow(wf, 'what?')).output).toBe('Q:what?');
    expect((await driveWorkflow(wf, 'hello')).output).toBe('S:hello');
  });

  it('falls back to DEFAULT_ROUTE when no specific route matches', async () => {
    const check = new FnNode('check', (_c, input) =>
      createEvent(
        input === 'jane'
          ? {output: input} // no route -> DEFAULT
          : {route: 'retry', output: input},
      ),
    );
    const retry = new FnNode('retry_node', (_c, input) => `RETRY:${input}`);
    const gen = new FnNode('generate', (_c, input) => `GEN:${input}`);
    const wf = new Workflow({
      name: 'default_route_wf',
      edges: [
        ['START', check],
        [check, {retry, [DEFAULT_ROUTE]: gen}],
      ],
    });

    expect((await driveWorkflow(wf, 'john')).output).toBe('RETRY:john');
    expect((await driveWorkflow(wf, 'jane')).output).toBe('GEN:jane');
  });

  it('fans out to parallel branches and joins them at a barrier', async () => {
    const a = new FnNode('A', (_c, input) => `A(${input})`);
    const b = new FnNode('B', (_c, input) => `B(${input})`);
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'fan_wf',
      edges: [['START', [a, b], join]],
    });

    const {output} = await driveWorkflow(wf, 'x');
    expect(output).toEqual({A: 'A(x)', B: 'B(x)'});
  });

  it('rejects an unconditional cycle at construction', () => {
    const a = new FnNode('cyc_a', (_c, i) => i);
    const b = new FnNode('cyc_b', (_c, i) => i);
    expect(
      () =>
        new Workflow({
          name: 'cycle_wf',
          edges: [
            ['START', a],
            [a, b],
            [b, a],
          ],
        }),
    ).toThrow(/cycle/i);
  });

  it('rejects an unreachable node', () => {
    const a = new FnNode('reach_a', (_c, i) => i);
    const orphan = new FnNode('orphan', (_c, i) => i);
    const b = new FnNode('reach_b', (_c, i) => i);
    expect(
      () =>
        new Workflow({
          name: 'unreachable_wf',
          // orphan -> b is never reachable from START.
          edges: [
            ['START', a],
            [orphan, b],
          ],
        }),
    ).toThrow(/unreachable/i);
  });
});
