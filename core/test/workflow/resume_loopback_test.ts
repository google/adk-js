/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resuming a graph that routes back through a node it already ran.
 *
 * Both human-in-the-loop shapes in `contributing/samples/workflows` do this:
 * the reviewer asks for a revision, the graph loops back to the drafting node,
 * and the review node asks again. The recovered state of a prior run has to
 * apply to exactly one activation, or the loop replays that run's answer
 * forever.
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {InMemoryRunner} from '../../src/runner/in_memory_runner.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {Workflow} from '../../src/workflow/workflow.js';

/** Caps a turn so a routing regression fails the test instead of hanging it. */
const MAX_EVENTS_PER_TURN = 40;

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
          throw new Error(
            `Runaway turn: over ${MAX_EVENTS_PER_TURN} events, the graph is ` +
              'looping on a resumed node.',
          );
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

function pendingInterruptId(events: Event[]): string {
  const id = events
    .flatMap((e) => e.content?.parts ?? [])
    .find((p) => p.functionCall)?.functionCall?.id;
  expect(id, 'the turn should have paused on an interrupt').toBeDefined();
  return id!;
}

const routes = (events: Event[]): unknown[] =>
  events.map((e) => e.route).filter((r) => r !== undefined);

describe('workflow resume — routing back through an already-run node', () => {
  it('re-runs the drafting node when the reviewer asks for a revision', async () => {
    let drafts = 0;
    const draft = node(() => `draft #${++drafts}`, {name: 'draft'});
    const askReview = node(
      (_c: NodeContext, value: string) =>
        new RequestInput({message: `review: ${value}`}),
      {name: 'ask_review'},
    );
    const handleReview = node(
      (_c: NodeContext, answer: string) =>
        createEvent({route: answer === 'approve' ? 'approved' : 'revise'}),
      {name: 'handle_review'},
    );
    const send = node(() => 'sent', {name: 'send'});

    const wf = new Workflow({
      name: 'two_node',
      edges: [
        ['START', draft, askReview, handleReview],
        [handleReview, {revise: draft, approved: send}],
      ],
    });
    const run = await driver(wf);

    const turn1 = await run.run(text('go'));
    const turn2 = await run.run(reply(pendingInterruptId(turn1), 'shorter'));

    expect(routes(turn2)).toEqual(['revise']);
    expect(drafts).toBe(2);

    const turn3 = await run.run(reply(pendingInterruptId(turn2), 'approve'));
    expect(routes(turn3)).toEqual(['approved']);
    expect(turn3.some((e) => e.output === 'sent')).toBe(true);
    expect(drafts).toBe(2);
  });

  it('does not hand a rerun-on-resume node the reply it already consumed', async () => {
    let drafts = 0;
    const draft = node(() => `draft #${++drafts}`, {name: 'draft'});
    const review = node(
      (ctx: NodeContext, value: string) => {
        const answer = ctx.resumeInputs['review'];
        if (!answer) {
          return new RequestInput({
            interruptId: 'review',
            message: `review: ${value}`,
          });
        }
        return createEvent({
          route: answer === 'approve' ? 'approved' : 'revise',
        });
      },
      {name: 'review', rerunOnResume: true},
    );
    const send = node(() => 'sent', {name: 'send'});

    const wf = new Workflow({
      name: 'rerun',
      edges: [
        ['START', draft, review],
        [review, {revise: draft, approved: send}],
      ],
    });
    const run = await driver(wf);

    await run.run(text('go'));
    const turn2 = await run.run(reply('review', 'shorter'));

    expect(routes(turn2)).toEqual(['revise']);
    expect(drafts).toBe(2);

    const turn3 = await run.run(reply('review', 'approve'));
    expect(routes(turn3)).toEqual(['approved']);
    expect(turn3.some((e) => e.output === 'sent')).toBe(true);
  });

  it('replays a completed rerun-on-resume node instead of running it again', async () => {
    let ran = 0;
    const once = node(
      () => {
        ran++;
        return `ran ${ran}`;
      },
      {name: 'once', rerunOnResume: true},
    );
    const gate = node(
      (ctx: NodeContext, value: string) => {
        const answer = ctx.resumeInputs['gate'];
        return answer
          ? `${value}/${answer}`
          : new RequestInput({interruptId: 'gate', message: 'ok?'});
      },
      {name: 'gate', rerunOnResume: true},
    );
    const wf = new Workflow({
      name: 'replay',
      edges: [['START', once, gate]],
    });
    const run = await driver(wf);

    await run.run(text('go'));
    const turn2 = await run.run(reply('gate', 'yes'));

    expect(ran).toBe(1);
    expect(turn2.some((e) => e.output === 'ran 1/yes')).toBe(true);
  });

  it('replays a routing node from its recorded route instead of re-running it', async () => {
    let routed = 0;
    const gate = node(
      (_c: NodeContext, value: string) => {
        routed++;
        return new RequestInput({interruptId: 'gate', message: value});
      },
      {name: 'gate'},
    );
    const decide = node(
      (_c: NodeContext, answer: string) => {
        return createEvent({route: answer === 'stop' ? 'stop' : 'go'});
      },
      {name: 'decide'},
    );
    const finish = node(() => 'done', {name: 'finish'});
    const halt = node(() => 'halted', {name: 'halt'});

    const wf = new Workflow({
      name: 'routing',
      edges: [
        ['START', gate, decide],
        [decide, {go: finish, stop: halt}],
      ],
    });
    const run = await driver(wf);

    const turn1 = await run.run(text('go'));
    const turn2 = await run.run(reply(pendingInterruptId(turn1), 'go'));

    expect(routed).toBe(1);
    expect(routes(turn2)).toEqual(['go']);
    expect(turn2.some((e) => e.output === 'done')).toBe(true);
  });
});
