/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {createEvent, Event} from '../../src/events/event.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {createIc} from './test_helpers.js';

async function driveWorkflow(
  wf: Workflow,
  input?: unknown,
  ic: InvocationContext = createIc(),
): Promise<{output: unknown; events: Event[]}> {
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext: ic,
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
 * A model that answers with whatever `reply` makes of the request it was sent,
 * so a test can assert on what the agent actually put in front of a model —
 * the injected node input, or a resolved instruction.
 */
class ScriptedLlm extends BaseLlm {
  constructor(private readonly reply: (request: LlmRequest) => string) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield {
      content: {role: 'model', parts: [{text: this.reply(request)}]},
    };
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('not implemented');
  }
}

/** The text of the last user turn the agent sent to the model. */
function lastUserText(request: LlmRequest): string {
  const lastUser = [...request.contents]
    .reverse()
    .find((c) => c.role === 'user');
  return (lastUser?.parts ?? []).map((p) => p.text ?? '').join('');
}

/** An agent that echoes the last user turn back as its model reply. */
function echoAgent(name = 'echo'): LlmAgent {
  return new LlmAgent({
    name,
    model: new ScriptedLlm((request) => `echo:${lastUserText(request)}`),
  });
}

/**
 * An agent whose instruction is `template`, answering with the instruction as
 * the model received it — i.e. after placeholder resolution. The agent's own
 * identity preamble comes first in the system instruction, so the reply is the
 * last non-empty line of it.
 */
function templateProbeAgent(template: string, name = 'probe'): LlmAgent {
  return new LlmAgent({
    name,
    instruction: template,
    model: new ScriptedLlm((request) => {
      const lines = String(request.config?.systemInstruction ?? '')
        .split('\n')
        .filter((line) => line.trim());
      return lines[lines.length - 1] ?? '';
    }),
  });
}

describe('LlmAgent as a node (single_turn)', () => {
  it('runs an agent as a node and extracts its text output', async () => {
    const wf = new Workflow({
      name: 'agent_wf',
      edges: [['START', echoAgent()]],
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
      edges: [['START', echoAgent(), upper]],
    });
    expect((await driveWorkflow(wf, 'hi')).output).toBe('ECHO:HI');
  });

  it('resolves {Class.field} instruction placeholders from the node input', async () => {
    const probe = templateProbeAgent(
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
    const probe = templateProbeAgent(
      'It is <CityTime.time_info from lookup_time_function> in ' +
        '<CityTime.city from lookup_time_function>.',
    );
    const wf = new Workflow({name: 'tmpl_pred', edges: [['START', probe]]});
    const {output} = await driveWorkflow(wf, undefined, ic);
    expect(output).toBe('It is 9:00 AM in Rome.');
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
    const run = root.runNode(echoAgent(), 'hi', {useAsOutput: true}).then(
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

  it('node(agent) is the agent, carrying its own name', () => {
    const agent = echoAgent('assistant');
    expect(node(agent)).toBe(agent);
    expect(node(agent).name).toBe('assistant');
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
        ['START', echoAgent(), classify],
        [classify, {q: answer, s: comment}],
      ],
    });
    // echo:'what?' contains '?', so route 'q'.
    expect((await driveWorkflow(wf, 'what?')).output).toBe('A:echo:what?');
  });
});
