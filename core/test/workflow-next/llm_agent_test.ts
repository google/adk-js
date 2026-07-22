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
import {node} from '../../src/workflow-next/node.js';
import {NodeContext} from '../../src/workflow-next/node_context.js';
import {LLMAgentWrapper} from '../../src/workflow-next/nodes/llm_agent_wrapper.js';
import {EventChannel} from '../../src/workflow-next/utils/event_channel.js';
import {Workflow} from '../../src/workflow-next/workflow.js';

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
  const channel = new EventChannel<Event>();
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
