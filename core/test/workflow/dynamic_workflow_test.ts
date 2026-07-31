/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {Session} from '../../src/sessions/session.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
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
  wf: Workflow,
  input?: unknown,
): Promise<{events: Event[]; output: unknown}> {
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext: createIc(),
    channel,
    nodePath: '',
    runId: 'root',
  });
  const events: Event[] = [];
  const run = root.runNode(wf, input, {useAsOutput: true}).then(
    () => channel.close(),
    (err) => channel.fail(err),
  );
  for await (const ev of channel) {
    events.push(ev);
  }
  await run;
  return {events, output: root.output};
}

describe('Phase 4 — dynamic (imperative) workflows', () => {
  it('runs an imperative dynamicEntry driving ctx.runNode()', async () => {
    const step = new FunctionNode('step', (_c, input) => `step(${input})`);
    const wf = new Workflow({
      name: 'dyn',
      dynamicEntry: async (ctx, input) => {
        const child = await ctx.runNode(step, input);
        return `wrapped[${child.output}]`;
      },
    });
    expect((await driveWorkflow(wf, 'x')).output).toBe('wrapped[step(x)]');
  });

  it('supports a bounded loop (the cycle case that used to hang)', async () => {
    // Increment until >= 3; a natural JS loop, terminated by user code.
    const inc = new FunctionNode('inc', (_c, n: number) => (n as number) + 1);
    const wf = new Workflow({
      name: 'loop',
      dynamicEntry: async (ctx, input) => {
        let value = input as number;
        let iterations = 0;
        while (value < 3) {
          const child = await ctx.runNode(inc, value);
          value = child.output as number;
          iterations++;
        }
        return {value, iterations};
      },
    });
    expect((await driveWorkflow(wf, 0)).output).toEqual({
      value: 3,
      iterations: 3,
    });
  });

  it('assigns distinct run ids to repeated dynamic calls (streams each event)', async () => {
    const emit = new FunctionNode('emit', (_c, n) => `emit(${n})`);
    const wf = new Workflow({
      name: 'repeat',
      dynamicEntry: async (ctx) => {
        const outs: unknown[] = [];
        for (let i = 0; i < 3; i++) {
          outs.push((await ctx.runNode(emit, i)).output);
        }
        return outs;
      },
    });
    const {events, output} = await driveWorkflow(wf);
    expect(output).toEqual(['emit(0)', 'emit(1)', 'emit(2)']);
    // Each iteration streamed its own event.
    expect(events.filter((e) => e.author === 'emit')).toHaveLength(3);
  });

  it('deduplicates concurrent ctx.runNode() calls to the same run', async () => {
    let executions = 0;
    const slow = new FunctionNode('slow', async () => {
      executions++;
      await new Promise((r) => setTimeout(r, 10));
      return 'done';
    });
    const wf = new Workflow({
      name: 'dedup',
      dynamicEntry: async (ctx) => {
        // Same explicit runId => same run path => deduped.
        const [a, b] = await Promise.all([
          ctx.runNode(slow, undefined, {runId: 'shared'}),
          ctx.runNode(slow, undefined, {runId: 'shared'}),
        ]);
        return {a: a.output, b: b.output, executions};
      },
    });
    expect((await driveWorkflow(wf)).output).toEqual({
      a: 'done',
      b: 'done',
      executions: 1,
    });
  });

  it('supports the node-as-tool pattern (a node calls a sub-node)', async () => {
    const adder = new FunctionNode(
      'adder',
      (_c, args: {a: number; b: number}) => args.a + args.b,
    );
    const orchestrator = new FunctionNode('orchestrator', async (ctx) => {
      const r1 = await ctx.runNode(adder, {a: 2, b: 3});
      const r2 = await ctx.runNode(adder, {a: 10, b: r1.output as number});
      return r2.output;
    });
    const wf = new Workflow({
      name: 'node_as_tool',
      edges: [['START', orchestrator]],
    });
    expect((await driveWorkflow(wf)).output).toBe(15);
  });
});
