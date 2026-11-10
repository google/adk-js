/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A `JoinNode` on a cycle fires once per iteration, with the outputs of that
 * iteration. Ported from `google/adk-python`
 * `tests/unittests/workflow/test_join_node.py`.
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {InMemoryRunner} from '../../src/runner/in_memory_runner.js';
import {JoinNode} from '../../src/workflow/nodes/join_node.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveNode, FnNode} from './test_helpers.js';

type JoinInput = Record<string, unknown>;

/** A node that records each input it receives and ends the run. */
function capturing(name: string, received: unknown[]): FnNode {
  return new FnNode(name, (_c, input) => {
    received.push(input);
    return undefined;
  });
}

describe('JoinNode in a loop', () => {
  it('waits for every predecessor to run again in each iteration', async () => {
    const joinInputs: JoinInput[] = [];
    const a = new FnNode('a', () => (joinInputs.length ? 'A2' : 'A1'));
    const b = new FnNode('b', () => (joinInputs.length ? 'B2' : 'B1'));
    const check = new FnNode('check', (_c, input) => {
      joinInputs.push(input as JoinInput);
      return joinInputs.length === 1 ? createEvent({route: 'again'}) : null;
    });
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', a, b],
        [[a, b], join, check],
        [check, {again: a}],
      ],
    });

    await driveNode(wf, 'start');

    expect(joinInputs).toEqual([
      {a: 'A1', b: 'B1'},
      {a: 'A2', b: 'B2'},
    ]);
  });

  it('passes undefined for a predecessor whose rerun has no output', async () => {
    const joinInputs: JoinInput[] = [];
    const a = new FnNode('a', () => (joinInputs.length ? undefined : 'A1'));
    const b = new FnNode('b', () => (joinInputs.length ? 'B2' : 'B1'));
    const check = new FnNode('check', (_c, input) => {
      joinInputs.push(input as JoinInput);
      return joinInputs.length === 1 ? createEvent({route: 'again'}) : null;
    });
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', a, b],
        [[a, b], join, check],
        [check, {again: a}],
      ],
    });

    await driveNode(wf, 'start');

    expect(joinInputs).toHaveLength(2);
    expect(joinInputs[1]).toStrictEqual({a: undefined, b: 'B2'});
  });

  it('fires in every iteration when a predecessor runs once before the loop', async () => {
    const joinInputs: JoinInput[] = [];
    const setup = new FnNode('setup', () => 'config');
    const body = new FnNode('body', () => `B${joinInputs.length + 1}`);
    const check = new FnNode('check', (_c, input) => {
      joinInputs.push(input as JoinInput);
      return joinInputs.length < 3 ? createEvent({route: 'again'}) : null;
    });
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', setup, body],
        [[setup, body], join, check],
        [check, {again: body}],
      ],
    });

    await driveNode(wf, 'start');

    expect(joinInputs).toEqual([
      {setup: 'config', body: 'B1'},
      {setup: 'config', body: 'B2'},
      {setup: 'config', body: 'B3'},
    ]);
  });

  it('keeps the latest output of a predecessor on its own upstream cycle', async () => {
    let producerRuns = 0;
    const joinInputs: JoinInput[] = [];
    const producer = new FnNode('producer', () => {
      producerRuns += 1;
      return createEvent({
        output: `P${producerRuns}`,
        route: producerRuns < 2 ? 'again' : 'ready',
      });
    });
    const body = new FnNode('body', () => `B${joinInputs.length + 1}`);
    const check = new FnNode('check', (_c, input) => {
      joinInputs.push(input as JoinInput);
      return joinInputs.length < 3 ? createEvent({route: 'again'}) : null;
    });
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', producer],
        [producer, join],
        [producer, {again: producer, ready: body}],
        [body, join],
        [join, check],
        [check, {again: body}],
      ],
    });

    await driveNode(wf, 'start');

    expect(joinInputs).toEqual([
      {producer: 'P2', body: 'B1'},
      {producer: 'P2', body: 'B2'},
      {producer: 'P2', body: 'B3'},
    ]);
  });

  it('waits for a predecessor that is running again when the others arrive', async () => {
    let aRuns = 0;
    let bRuns = 0;
    const a = new FnNode('a', async () => {
      aRuns += 1;
      if (aRuns === 2) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return `A${aRuns}`;
    });
    const b = new FnNode('b', () => {
      bRuns += 1;
      return createEvent({
        output: `B${bRuns}`,
        route: bRuns === 1 ? 'retry' : 'to_join',
      });
    });
    const restart = new FnNode('restart', () => null);
    const join = new JoinNode({name: 'join'});
    const received: unknown[] = [];
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', [a, b]],
        [a, join],
        [b, {to_join: join, retry: restart}],
        [restart, [a, b]],
        [join, capturing('capture', received)],
      ],
    });

    await driveNode(wf, 'start');

    expect(received).toEqual([{a: 'A2', b: 'B2'}]);
  });
});

describe('JoinNode after a loop', () => {
  it('fires once when a predecessor in the loop keeps running', async () => {
    let bRuns = 0;
    const a = new FnNode('a', () => 'A');
    const b = new FnNode('b', () => {
      bRuns += 1;
      return createEvent({
        output: `B${bRuns}`,
        route: bRuns < 3 ? 'again' : 'done',
      });
    });
    const c = new FnNode('c', () => 'C');
    const join = new JoinNode({name: 'join'});
    const received: unknown[] = [];
    // The join is downstream of the a/b loop, not on it. b feeds it in every
    // iteration (B1, B2, B3), so it fires once and ignores the reruns.
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', [a, c]],
        [a, b],
        [b, {again: a}],
        [[b, c], join, capturing('capture', received)],
      ],
    });

    await driveNode(wf, 'start');

    expect(bRuns).toBe(3);
    expect(received).toEqual([{b: 'B1', c: 'C'}]);
  });
});

describe('JoinNode in a loop across a resume', () => {
  it('waits for a predecessor that paused for input in a later iteration', async () => {
    const joinInputs: JoinInput[] = [];
    const a = new FnNode('a', () => (joinInputs.length ? 'A2' : 'A1'));
    const b = new FnNode('b', () =>
      joinInputs.length
        ? new RequestInput({interruptId: 'continue', message: 'Continue?'})
        : 'B1',
    );
    const check = new FnNode('check', (_c, input) => {
      joinInputs.push(input as JoinInput);
      return joinInputs.length === 1 ? createEvent({route: 'again'}) : null;
    });
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', a, b],
        [[a, b], join, check],
        [check, {again: a}],
      ],
    });
    const runner = new InMemoryRunner({agent: wf, appName: 'app'});
    const session = await runner.sessionService.createSession({
      appName: 'app',
      userId: 'u',
    });
    const run = async (newMessage: Content): Promise<Event[]> => {
      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'u',
        sessionId: session.id,
        newMessage,
      })) {
        events.push(event);
      }
      return events;
    };

    await run({role: 'user', parts: [{text: 'start'}]});

    expect(joinInputs).toEqual([{a: 'A1', b: 'B1'}]);

    await run({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'continue',
            name: 'adk_request_input',
            response: {result: 'B2'},
          },
        },
      ],
    });

    expect(joinInputs).toEqual([
      {a: 'A1', b: 'B1'},
      {a: 'A2', b: 'B2'},
    ]);
  });
});
