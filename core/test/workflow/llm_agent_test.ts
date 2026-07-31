/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {injectSessionState} from '../../src/agents/instructions.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {ReadonlyContext} from '../../src/agents/readonly_context.js';
import {createEvent, Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {Session} from '../../src/sessions/session.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {LLMAgentWrapper} from '../../src/workflow/nodes/llm_agent_wrapper.js';
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
): Promise<{output: unknown; events: Event[]}> {
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
  return {output: root.output, events};
}

/**
 * A fake agent that echoes the most recent user turn as a model response — a
 * stand-in for a real LlmAgent so the wrapper can be tested without a model.
 */
class EchoAgent extends BaseAgent {
  constructor(name = 'echo') {
    super({name});
  }
  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const lastUser = [...ctx.session.events]
      .reverse()
      .find((e) => e.author === 'user');
    const text = (lastUser?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    yield createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      branch: ctx.branch,
      content: {role: 'model', parts: [{text: `echo:${text}`}]},
    });
  }
  // eslint-disable-next-line require-yield
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

/**
 * A fake agent that resolves a given instruction template against its context
 * (the way the real instruction request-processor does) and yields the result —
 * so we can assert workflow `{Class.field}` / `<field from node>` placeholders
 * resolve from the scope the wrapper attaches to the invocation context.
 */
class TemplateProbeAgent extends BaseAgent {
  constructor(
    private readonly template: string,
    name = 'probe',
  ) {
    super({name});
  }
  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const resolved = await injectSessionState(
      this.template,
      new ReadonlyContext(ctx),
    );
    yield createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      branch: ctx.branch,
      content: {role: 'model', parts: [{text: resolved}]},
    });
  }
  // eslint-disable-next-line require-yield
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

describe('Phase 7 — LlmAgent as a node (single_turn)', () => {
  it('runs an agent as a node and extracts its text output', async () => {
    const wf = new Workflow({
      name: 'agent_wf',
      edges: [['START', new EchoAgent()]],
    });
    const {output, events} = await driveWorkflow(wf, 'hello');
    expect(output).toBe('echo:hello');
    // The agent's model event streamed through, authored by the agent.
    expect(events.some((e) => e.author === 'echo')).toBe(true);
  });

  it('lets an agent be used directly in edges, feeding a downstream node (baseline bug #3)', async () => {
    const upper = node(
      (_c: NodeContext, input: string) => input.toUpperCase(),
      {
        name: 'upper',
      },
    );
    const wf = new Workflow({
      name: 'agent_then_fn',
      edges: [['START', new EchoAgent(), upper]],
    });
    expect((await driveWorkflow(wf, 'hi')).output).toBe('ECHO:HI');
  });

  it('resolves {Class.field} instruction placeholders from the node input', async () => {
    const probe = new TemplateProbeAgent(
      'It is {CityTime.time_info} in {CityTime.city} right now.',
    );
    const wf = new Workflow({name: 'tmpl_input', edges: [['START', probe]]});
    const {output} = await driveWorkflow(wf, {
      time_info: '10:10 AM',
      city: 'Paris',
    });
    expect(output).toBe('It is 10:10 AM in Paris right now.');
  });

  it('resolves <field from source_node> from a predecessor output event', async () => {
    const ic = createIc();
    // Seed a predecessor output the way the Runner persists node events.
    ic.session.events.push(
      createEvent({
        author: 'lookup_time_function',
        invocationId: ic.invocationId,
        nodeInfo: {path: 'wf.lookup_time_function'},
        output: {time_info: '9:00 AM', city: 'Rome'},
      }),
    );
    const probe = new TemplateProbeAgent(
      'It is <CityTime.time_info from lookup_time_function> in ' +
        '<CityTime.city from lookup_time_function>.',
    );
    const channel = new AsyncQueue<Event>();
    const root = new NodeContext({
      invocationContext: ic,
      channel,
      nodePath: '',
      runId: 'root',
    });
    const run = root.runNode(node(probe), undefined, {useAsOutput: true}).then(
      () => channel.close(),
      (err) => channel.fail(err),
    );
    for await (const _ev of channel) {
      // drain
    }
    await run;
    expect(root.output).toBe('It is 9:00 AM in Rome.');
  });

  it('persists the injected user turn through the session service', async () => {
    const ic = createIc();
    const appended: Event[] = [];
    (ic as unknown as {sessionService: unknown}).sessionService = {
      appendEvent: async ({
        session,
        event,
      }: {
        session: {events: Event[]};
        event: Event;
      }) => {
        appended.push(event);
        session.events.push(event); // mimic the base service adding to the list
        return event;
      },
    };
    const channel = new AsyncQueue<Event>();
    const root = new NodeContext({
      invocationContext: ic,
      channel,
      nodePath: '',
      runId: 'root',
    });
    const run = root
      .runNode(node(new EchoAgent()), 'hi', {useAsOutput: true})
      .then(
        () => channel.close(),
        (err) => channel.fail(err),
      );
    for await (const _ev of channel) {
      // drain
    }
    await run;

    // The user turn went through the persistence path (appendEvent), not just a
    // silent in-memory push, and the agent still saw it.
    const userTurn = appended.find((e) => e.author === 'user');
    expect(userTurn?.content?.parts?.[0]?.text).toBe('hi');
    expect(root.output).toBe('echo:hi');
  });

  it('node(agent) produces an LLMAgentWrapper carrying the agent name', () => {
    const wrapped = node(new EchoAgent('assistant'));
    expect(wrapped).toBeInstanceOf(LLMAgentWrapper);
    expect(wrapped.name).toBe('assistant');
  });

  it('routes on an agent-produced value', async () => {
    // The classifier agent echoes; a function maps it to a route.
    const classify = node(
      (_c: NodeContext, input: string) =>
        createEvent({route: input.includes('?') ? 'q' : 's', output: input}),
      {name: 'route_fn'},
    );
    const answer = node((_c: NodeContext, i: string) => `A:${i}`, {
      name: 'answer',
    });
    const comment = node((_c: NodeContext, i: string) => `C:${i}`, {
      name: 'comment',
    });
    const wf = new Workflow({
      name: 'agent_route',
      edges: [
        ['START', new EchoAgent(), classify],
        [classify, {q: answer, s: comment}],
      ],
    });
    // echo:'what?' contains '?', so route 'q'.
    expect((await driveWorkflow(wf, 'what?')).output).toBe('A:echo:what?');
  });
});
