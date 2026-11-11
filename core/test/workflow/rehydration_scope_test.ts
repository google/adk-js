/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {hasRequestInputFunctionCall} from '../../src/workflow/utils/hitl_utils.js';
import {eventsForCurrentRun} from '../../src/workflow/utils/rehydration_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';

async function drain(gen: AsyncGenerator<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

function nodeEvent(
  invocationId: string,
  path: string,
  extra: Partial<Event> = {},
): Event {
  return createEvent({
    author: path.split('.').pop(),
    invocationId,
    nodeInfo: {path},
    ...extra,
  });
}

/**
 * A node event that paused for a human, shaped like the engine's own: an
 * `adk_request_input` call whose id is also a long-running tool id (see
 * `createRequestInputEvent`).
 */
function pauseEvent(
  invocationId: string,
  path: string,
  interruptId: string,
): Event {
  return nodeEvent(invocationId, path, {
    content: {
      role: 'model',
      parts: [
        {functionCall: {name: 'adk_request_input', id: interruptId, args: {}}},
      ],
    },
    longRunningToolIds: [interruptId],
  });
}

describe('eventsForCurrentRun', () => {
  it('drops a run that already completed', () => {
    const events = [
      createEvent({author: 'user', invocationId: 'a'}),
      nodeEvent('a', 'wf.n1', {output: 'one'}),
      nodeEvent('a', 'wf.n2', {output: 'two'}),
      createEvent({author: 'user', invocationId: 'b'}),
    ];
    expect(eventsForCurrentRun(events, 'b')).toEqual([events[3]]);
  });

  it('keeps a run that paused, so resume still sees its outputs', () => {
    const events = [
      createEvent({author: 'user', invocationId: 'a'}),
      nodeEvent('a', 'wf.n1', {output: 'one'}),
      pauseEvent('a', 'wf.gate', 'gate-1'),
      createEvent({author: 'user', invocationId: 'b'}),
    ];
    expect(eventsForCurrentRun(events, 'b')).toEqual(events.slice(1));
  });

  it('keeps every invocation of a run that paused more than once', () => {
    const events = [
      createEvent({author: 'user', invocationId: 'a'}),
      nodeEvent('a', 'wf.n1', {output: 'one'}),
      pauseEvent('a', 'wf.gate1', 'g1'),
      createEvent({author: 'user', invocationId: 'b'}),
      nodeEvent('b', 'wf.n2', {output: 'two'}),
      pauseEvent('b', 'wf.gate2', 'g2'),
      createEvent({author: 'user', invocationId: 'c'}),
    ];
    expect(eventsForCurrentRun(events, 'c')).toEqual(events.slice(1));
  });

  it('cuts at the last completed run when a completed run precedes a paused one', () => {
    const events = [
      createEvent({author: 'user', invocationId: 'a'}),
      nodeEvent('a', 'wf.n1', {output: 'stale'}),
      createEvent({author: 'user', invocationId: 'b'}),
      nodeEvent('b', 'wf.n1', {output: 'one'}),
      pauseEvent('b', 'wf.gate', 'g1'),
      createEvent({author: 'user', invocationId: 'c'}),
    ];
    // Run `a` finished; only the paused run `b` onward may be rehydrated.
    expect(eventsForCurrentRun(events, 'c')).toEqual(events.slice(3));
  });

  it('treats an id-less engine event as part of the surrounding invocation', () => {
    // A RequestInput interrupt is enriched with author/path/branch but no
    // invocation id; it must not open a run of its own, or the boundary lands
    // mid-run and already-completed nodes are re-executed.
    const events = [
      createEvent({author: 'user', invocationId: 'a'}),
      nodeEvent('a', 'wf.n1', {output: 'one'}),
      pauseEvent('', 'wf.gate', 'gate-1'),
      createEvent({author: 'user', invocationId: 'b'}),
    ];
    expect(eventsForCurrentRun(events, 'b')).toEqual(events.slice(1));
  });

  it('drops a completed run that merely used a long-running tool', () => {
    // `longRunningToolIds` marks any tool declared `isLongRunning`, not only a
    // HITL pause. A run that called one and then finished is finished, and must
    // not be kept and fast-forwarded on the next turn.
    const events = [
      createEvent({author: 'user', invocationId: 'a'}),
      nodeEvent('a', 'wf.n1', {
        output: 'one',
        longRunningToolIds: ['poll-job-1'],
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'start_job', id: 'poll-job-1'}}],
        },
      }),
      createEvent({author: 'user', invocationId: 'b'}),
    ];
    expect(eventsForCurrentRun(events, 'b')).toEqual([events[2]]);
  });

  it('keeps a run paused on a tool confirmation', () => {
    const events = [
      createEvent({author: 'user', invocationId: 'a'}),
      nodeEvent('a', 'wf.n1', {output: 'one'}),
      nodeEvent('a', 'wf.act', {
        longRunningToolIds: ['c1'],
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'adk_request_confirmation',
                id: 'c1',
                args: {},
              },
            },
          ],
        },
      }),
      createEvent({author: 'user', invocationId: 'b'}),
    ];
    expect(eventsForCurrentRun(events, 'b')).toEqual(events.slice(1));
  });

  it('passes through when there is nothing earlier to drop', () => {
    const events = [createEvent({author: 'user', invocationId: 'a'})];
    expect(eventsForCurrentRun(events, 'a')).toEqual(events);
    expect(eventsForCurrentRun([], 'a')).toEqual([]);
  });
});

describe('workflow re-invocation after completion', () => {
  it('runs again on the next turn instead of replaying the previous answer', async () => {
    const runs: string[] = [];
    const n1 = new FunctionNode('n1', (_c: NodeContext, input: unknown) => {
      runs.push(`n1(${input})`);
      return `n1:${input}`;
    });
    const n2 = new FunctionNode('n2', (_c: NodeContext, input: unknown) => {
      runs.push('n2');
      return `n2:${input}`;
    });

    const agent = new Workflow({name: 'wf', edges: [['START', n1, n2]]});
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'app',
      userId: 'u',
    });
    const runner = new Runner({appName: 'app', agent, sessionService});

    const ask = (text: string) =>
      drain(
        runner.runAsync({
          userId: 'u',
          sessionId: session.id,
          newMessage: {role: 'user', parts: [{text}]},
        }),
      );

    const turn1 = await ask('first');
    const turn2 = await ask('second');

    // Both nodes execute on both turns, against that turn's own input.
    expect(runs).toEqual(['n1(first)', 'n2', 'n1(second)', 'n2']);
    expect(turn1.some((e) => e.output === 'n2:n1:first')).toBe(true);
    // The second turn must answer the second question, not replay the first.
    expect(turn2.some((e) => e.output === 'n2:n1:second')).toBe(true);
    expect(turn2.some((e) => e.output === 'n2:n1:first')).toBe(false);
  });

  it('still resumes a pause, then starts clean on the turn after it finishes', async () => {
    const runs: string[] = [];
    const ask = new FunctionNode(
      'ask',
      (ctx: NodeContext) => {
        runs.push('ask');
        const reply = ctx.resumeInputs['q'];
        return reply === undefined
          ? new RequestInput({interruptId: 'q', message: 'q?'})
          : `got:${reply}`;
      },
      {rerunOnResume: true},
    );
    const after = new FunctionNode(
      'after',
      (_c: NodeContext, input: unknown) => {
        runs.push('after');
        return `after:${input}`;
      },
    );

    const agent = new Workflow({
      name: 'wf_hitl',
      edges: [['START', ask, after]],
    });
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'app',
      userId: 'u',
    });
    const runner = new Runner({appName: 'app', agent, sessionService});
    const send = (text: string) =>
      drain(
        runner.runAsync({
          userId: 'u',
          sessionId: session.id,
          newMessage: {role: 'user', parts: [{text}]},
        }),
      );

    // Turn 1 pauses.
    const turn1 = await send('go');
    expect(turn1.some(hasRequestInputFunctionCall)).toBe(true);
    expect(runs).toEqual(['ask']);

    // Turn 2 resumes the SAME run: `ask` re-runs with the reply, `after` runs.
    const turn2 = await send('yes');
    expect(turn2.some((e) => e.output === 'after:got:yes')).toBe(true);
    expect(runs).toEqual(['ask', 'ask', 'after']);

    // Turn 3 is a NEW run: the finished one must not be replayed.
    const turn3 = await send('again');
    expect(runs).toEqual(['ask', 'ask', 'after', 'ask']);
    expect(turn3.some(hasRequestInputFunctionCall)).toBe(true);
  });
});
