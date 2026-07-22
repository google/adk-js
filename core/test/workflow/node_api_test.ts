/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {Session} from '../../src/sessions/session.js';
import {BaseTool} from '../../src/tools/base_tool.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {node, Node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {JoinNode} from '../../src/workflow/nodes/join_node.js';
import {LLMAgentWrapper} from '../../src/workflow/nodes/llm_agent_wrapper.js';
import {ToolNode} from '../../src/workflow/nodes/tool_node.js';
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

async function runNode(
  n: BaseNode,
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
  const run = root.runNode(n, input, {useAsOutput: true}).then(
    () => channel.close(),
    (err) => channel.fail(err),
  );
  for await (const ev of channel) {
    events.push(ev);
  }
  await run;
  return {events, output: root.output};
}

async function driveWorkflow(wf: Workflow, input?: unknown): Promise<unknown> {
  return (await runNode(wf, input)).output;
}

describe('Phase 3 — FunctionNode', () => {
  it('boxes a plain return value into an output event', async () => {
    const n = new FunctionNode('greet', (_c, input) => `hi ${input}`);
    const {output, events} = await runNode(n, 'x');
    expect(output).toBe('hi x');
    expect(events[0].output).toBe('hi x');
  });

  it('awaits an async handler', async () => {
    const n = new FunctionNode('a', async (_c, input) => {
      await Promise.resolve();
      return `async:${input}`;
    });
    expect((await runNode(n, 'v')).output).toBe('async:v');
  });

  it('supports sync generators (multiple events, last output wins)', async () => {
    const n = new FunctionNode('gen', function* (_c, input) {
      yield `${input}-1`;
      yield `${input}-2`;
    });
    const {events, output} = await runNode(n, 'g');
    expect(events.map((e) => e.output)).toEqual(['g-1', 'g-2']);
    expect(output).toBe('g-2');
  });

  it('supports async generators', async () => {
    const n = new FunctionNode('agen', async function* (_c) {
      yield 'one';
      await Promise.resolve();
      yield 'two';
    });
    expect((await runNode(n)).events.map((e) => e.output)).toEqual([
      'one',
      'two',
    ]);
  });

  it('skips null returns but keeps state deltas', async () => {
    const n = new FunctionNode('writer', (ctx) => {
      ctx.state.set('flag', true);
      return null;
    });
    const {events} = await runNode(n);
    expect(events).toHaveLength(1);
    expect(events[0].output).toBeUndefined();
    expect(events[0].actions.stateDelta['flag']).toBe(true);
  });

  it('attaches state deltas to output events', async () => {
    const n = new FunctionNode('w', (ctx) => {
      ctx.state.set('count', 3);
      return 'ok';
    });
    const {events} = await runNode(n);
    expect(events[0].output).toBe('ok');
    expect(events[0].actions.stateDelta['count']).toBe(3);
  });

  it('validates output against an outputSchema', async () => {
    const schema = z.object({n: z.number()});
    const good = new FunctionNode('g', () => ({n: 5}), {outputSchema: schema});
    expect((await runNode(good)).output).toEqual({n: 5});

    const bad = new FunctionNode('b', () => ({n: 'not-a-number'}), {
      outputSchema: schema,
    });
    await expect(runNode(bad)).rejects.toThrow();
  });
});

describe('Phase 3 — node() factory', () => {
  it('wraps a function, deriving the name', () => {
    function classify() {
      return 'ok';
    }
    const n = node(classify);
    expect(n).toBeInstanceOf(FunctionNode);
    expect(n.name).toBe('classify');
  });

  it('wraps a function with an explicit name override', () => {
    const n = node((_c: NodeContext, input: unknown) => input, {
      name: 'passthru',
    });
    expect(n.name).toBe('passthru');
  });

  it('wraps a BaseTool into a ToolNode', () => {
    const tool = new EchoTool();
    const n = node(tool);
    expect(n).toBeInstanceOf(ToolNode);
    expect(n.name).toBe('echo');
  });

  it('returns an existing BaseNode unchanged', () => {
    const existing = new FunctionNode('keep', () => 1);
    expect(node(existing)).toBe(existing);
  });

  it('wraps an agent into an LLMAgentWrapper', () => {
    const fakeAgent = {name: 'a', runAsync: async function* () {}};
    const n = node(fakeAgent as unknown as never);
    expect(n).toBeInstanceOf(LLMAgentWrapper);
    expect(n.name).toBe('a');
  });
});

describe('Phase 3 — Node subclass', () => {
  class DoubleNode extends Node<number, number> {
    protected async *runNodeImpl(_ctx: NodeContext, input: number) {
      yield input * 2;
    }
  }

  it('runs a subclass via runNodeImpl', async () => {
    expect((await runNode(new DoubleNode({name: 'double'}), 5)).output).toBe(
      10,
    );
  });
});

describe('Phase 3 — JoinNode & ToolNode in a workflow', () => {
  it('fans in with the real JoinNode', async () => {
    const a = node((_c: NodeContext, input: unknown) => `A(${input})`, {
      name: 'A',
    });
    const b = node((_c: NodeContext, input: unknown) => `B(${input})`, {
      name: 'B',
    });
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({name: 'fan', edges: [['START', [a, b], join]]});
    expect(await driveWorkflow(wf, 'x')).toEqual({A: 'A(x)', B: 'B(x)'});
  });

  it('runs a ToolNode with object args', async () => {
    const wf = new Workflow({
      name: 'tool_wf',
      edges: [['START', new ToolNode(new EchoTool())]],
    });
    expect(await driveWorkflow(wf, {msg: 'hi'})).toEqual({
      echoed: {msg: 'hi'},
    });
  });

  it('coerces a JSON-string ToolNode input to args', async () => {
    const {output} = await runNode(new ToolNode(new EchoTool()), '{"a":1}');
    expect(output).toEqual({echoed: {a: 1}});
  });
});

// A trivial tool that echoes its args back.
class EchoTool extends BaseTool {
  constructor() {
    super({name: 'echo', description: 'Echoes the input args.'});
  }
  async runAsync({args}: {args: Record<string, unknown>}): Promise<unknown> {
    return {echoed: args};
  }
}
