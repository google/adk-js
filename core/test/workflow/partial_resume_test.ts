/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resuming a run that waits on several interrupts when the reply answers only
 * some of them.
 *
 * A node whose own interrupts are all still open keeps waiting: it does not run
 * again and does not ask again. A node that has `rerunOnResume` and got an
 * answer to at least one of its interrupts runs again with what it has. This is
 * `google/adk-python`'s rule (`_replay_interceptor.check_interception`).
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {Event} from '../../src/events/event.js';
import {InMemoryRunner} from '../../src/runner/in_memory_runner.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {JoinNode} from '../../src/workflow/nodes/join_node.js';
import {ParallelWorker} from '../../src/workflow/nodes/parallel_worker.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {Workflow} from '../../src/workflow/workflow.js';

/** Caps a turn so a resume regression fails the test instead of hanging it. */
const MAX_EVENTS_PER_TURN = 60;

interface Driver {
  run(message: Content): Promise<Event[]>;
}

async function driver(agent: Workflow): Promise<Driver> {
  const runner = new InMemoryRunner({agent, appName: 'app'});
  const session = await runner.sessionService.createSession({
    appName: 'app',
    userId: 'u',
  });
  return {
    async run(message: Content): Promise<Event[]> {
      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'u',
        sessionId: session.id,
        newMessage: message,
      })) {
        events.push(event);
        if (events.length > MAX_EVENTS_PER_TURN) {
          throw new Error(`Runaway turn: over ${MAX_EVENTS_PER_TURN} events.`);
        }
      }
      return events;
    },
  };
}

const text = (value: string): Content => ({
  role: 'user',
  parts: [{text: value}],
});

const reply = (id: string, value: string): Content => ({
  role: 'user',
  parts: [
    {
      functionResponse: {
        id,
        name: 'adk_request_input',
        response: {result: value},
      },
    },
  ],
});

/** The ids of the questions a turn asked, in order. */
const questions = (events: Event[]): string[] =>
  events
    .flatMap((e) => e.content?.parts ?? [])
    .map((p) => p.functionCall?.id)
    .filter((id): id is string => id !== undefined);

/** A node that asks `interruptId` until it is answered, counting its runs. */
function asking(
  name: string,
  interruptId: string,
  runs: Record<string, number>,
  rerunOnResume: boolean,
) {
  return node(
    (ctx: NodeContext) => {
      runs[name] = (runs[name] ?? 0) + 1;
      const answer = ctx.resumeInputs[interruptId];
      return answer === undefined
        ? new RequestInput({interruptId, message: `${name}?`})
        : `${name}:${answer}`;
    },
    {name, rerunOnResume},
  );
}

describe('workflow resume — a reply that answers some of the open interrupts', () => {
  for (const rerunOnResume of [false, true]) {
    it(`keeps a sibling waiting on its own question (rerunOnResume: ${rerunOnResume})`, async () => {
      const runs: Record<string, number> = {};
      const received: unknown[] = [];
      const a = asking('a', 'x', runs, rerunOnResume);
      const b = asking('b', 'y', runs, rerunOnResume);
      const done = node(
        (_c: NodeContext, input: unknown) => {
          received.push(input);
          return 'done';
        },
        {name: 'done'},
      );
      const wf = new Workflow({
        name: 'wf',
        edges: [
          ['START', [a, b]],
          [[a, b], new JoinNode({name: 'join'}), done],
        ],
      });
      const run = await driver(wf);

      expect(questions(await run.run(text('go')))).toEqual(['x', 'y']);

      const turn2 = await run.run(reply('y', 'yy'));

      expect(questions(turn2)).toEqual([]);
      expect(runs['a']).toBe(1);
      expect(received).toEqual([]);

      const turn3 = await run.run(reply('x', 'xx'));

      expect(questions(turn3)).toEqual([]);
      expect(received).toEqual([
        rerunOnResume ? {a: 'a:xx', b: 'b:yy'} : {a: 'xx', b: 'yy'},
      ]);
    });
  }

  it('does not ask again under a new id when the ids are generated', async () => {
    let aRuns = 0;
    const received: unknown[] = [];
    const a = node(
      () => {
        aRuns += 1;
        return new RequestInput({message: 'a?'});
      },
      {name: 'a'},
    );
    const b = node(() => new RequestInput({message: 'b?'}), {name: 'b'});
    const done = node(
      (_c: NodeContext, input: unknown) => {
        received.push(input);
        return 'done';
      },
      {name: 'done'},
    );
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', [a, b]],
        [[a, b], new JoinNode({name: 'join'}), done],
      ],
    });
    const run = await driver(wf);

    const turn1 = await run.run(text('go'));
    const [askA, askB] = questions(turn1);

    expect(questions(await run.run(reply(askB, 'yes')))).toEqual([]);
    expect(aRuns).toBe(1);

    await run.run(reply(askA, 'ok'));

    expect(received).toEqual([{a: 'ok', b: 'yes'}]);
  });

  it('keeps a sibling waiting inside a nested workflow', async () => {
    const runs: Record<string, number> = {};
    const received: unknown[] = [];
    const a = asking('a', 'x', runs, true);
    const b = asking('b', 'y', runs, true);
    const inner = new Workflow({
      name: 'inner',
      edges: [
        ['START', [a, b]],
        [[a, b], new JoinNode({name: 'join'})],
      ],
    });
    const capture = node(
      (_c: NodeContext, input: unknown) => {
        received.push(input);
        return 'done';
      },
      {name: 'capture'},
    );
    const wf = new Workflow({
      name: 'outer',
      edges: [['START', inner, capture]],
    });
    const run = await driver(wf);

    expect(questions(await run.run(text('go')))).toEqual(['x', 'y']);

    expect(questions(await run.run(reply('y', 'yy')))).toEqual([]);
    expect(runs['a']).toBe(1);

    await run.run(reply('x', 'xx'));

    expect(received).toEqual([{a: 'a:xx', b: 'b:yy'}]);
  });
});

describe('ParallelWorker resume — answering one item', () => {
  it('runs the answered item again and keeps the other one waiting', async () => {
    const runs: Record<string, number> = {};
    const item = node(
      (ctx: NodeContext, v: string) => {
        runs[v] = (runs[v] ?? 0) + 1;
        const answer = ctx.resumeInputs[`q-${v}`];
        return answer === undefined
          ? new RequestInput({interruptId: `q-${v}`, message: `${v}?`})
          : `${v}:${answer}`;
      },
      {name: 'item', rerunOnResume: true},
    );
    const wf = new Workflow({
      name: 'wf',
      edges: [
        [
          'START',
          node(() => ['a', 'b'], {name: 'items'}),
          new ParallelWorker(item),
        ],
      ],
    });
    const run = await driver(wf);

    expect(questions(await run.run(text('go')))).toEqual(['q-a', 'q-b']);

    const turn2 = await run.run(reply('q-a', 'A'));

    expect(questions(turn2)).toEqual([]);
    expect(runs).toEqual({a: 2, b: 1});

    const turn3 = await run.run(reply('q-b', 'B'));

    expect(runs).toEqual({a: 2, b: 2});
    expect(
      turn3.some((e) => JSON.stringify(e.output) === '["a:A","b:B"]'),
    ).toBe(true);
  });
});
