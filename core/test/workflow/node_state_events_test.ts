/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How a node's state writes reach the event stream and the nodes after it.
 * Both directions matter: the session is rebuilt from events, and a later node
 * reads through `ctx.state`.
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {InMemoryRunner} from '../../src/runner/in_memory_runner.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {createIc} from './test_helpers.js';

async function drive(
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
  for await (const event of channel) {
    events.push(event);
  }
  await run;
  return {output: root.output, events};
}

const deltas = (events: Event[]): Array<Record<string, unknown>> =>
  events
    .map((e) => e.actions?.stateDelta ?? {})
    .filter((d) => Object.keys(d).length > 0);

describe('node state writes and the event stream', () => {
  it('reports state written by a generator node that yields nothing', async () => {
    const write = node(
      // eslint-disable-next-line require-yield
      async function* (ctx: NodeContext, input: string) {
        ctx.state.set('seen', input);
      },
      {name: 'write'},
    );
    const read = node((ctx: NodeContext) => `read:${ctx.state.get('seen')}`, {
      name: 'read',
    });
    const wf = new Workflow({name: 'wf', edges: [['START', write, read]]});

    const {output, events} = await drive(wf, 'x');

    expect(deltas(events)).toEqual([{seen: 'x'}]);
    expect(output).toBe('read:x');
  });

  it('makes state carried on an emitted event readable by the next node', async () => {
    const write = node(
      (_c: NodeContext, input: string) =>
        createEvent({actions: {stateDelta: {seen: input.toUpperCase()}}}),
      {name: 'write'},
    );
    const read = node((ctx: NodeContext) => `read:${ctx.state.get('seen')}`, {
      name: 'read',
    });
    const wf = new Workflow({name: 'wf', edges: [['START', write, read]]});

    const {output, events} = await drive(wf, 'x');

    expect(deltas(events)).toEqual([{seen: 'X'}]);
    expect(output).toBe('read:X');
  });
});

describe('resume value unwrapping', () => {
  it('parses a structured reply sent as text', async () => {
    const ask = node(
      (ctx: NodeContext) => {
        const answer = ctx.resumeInputs['ask'];
        return answer ?? new RequestInput({interruptId: 'ask', message: '?'});
      },
      {name: 'ask', rerunOnResume: true},
    );
    const wf = new Workflow({name: 'wf', edges: [['START', ask]]});
    const runner = new InMemoryRunner({agent: wf, appName: 'app'});
    const session = await runner.sessionService.createSession({
      appName: 'app',
      userId: 'u',
    });
    const drain = async (message: Content): Promise<Event[]> => {
      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'u',
        sessionId: session.id,
        newMessage: message,
      })) {
        events.push(event);
      }
      return events;
    };

    await drain({role: 'user', parts: [{text: 'go'}]});
    const turn2 = await drain({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'ask',
            name: 'adk_request_input',
            response: {result: '{"approved": true, "days": 2}'},
          },
        },
      ],
    });

    expect(turn2.find((e) => e.output !== undefined)?.output).toEqual({
      approved: true,
      days: 2,
    });
  });

  it('leaves a plain-text reply alone', async () => {
    const ask = node(
      (ctx: NodeContext) => {
        const answer = ctx.resumeInputs['ask'];
        return answer ?? new RequestInput({interruptId: 'ask', message: '?'});
      },
      {name: 'ask', rerunOnResume: true},
    );
    const wf = new Workflow({name: 'wf2', edges: [['START', ask]]});
    const runner = new InMemoryRunner({agent: wf, appName: 'app2'});
    const session = await runner.sessionService.createSession({
      appName: 'app2',
      userId: 'u',
    });
    const drain = async (message: Content): Promise<Event[]> => {
      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'u',
        sessionId: session.id,
        newMessage: message,
      })) {
        events.push(event);
      }
      return events;
    };

    await drain({role: 'user', parts: [{text: 'go'}]});
    const turn2 = await drain({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'ask',
            name: 'adk_request_input',
            response: {result: 'approve'},
          },
        },
      ],
    });

    expect(turn2.find((e) => e.output !== undefined)?.output).toBe('approve');
  });
});
