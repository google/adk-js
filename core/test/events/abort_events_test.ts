/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  CreateEventParams,
  Event,
  getFunctionResponses,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {buildAbortEvents, isAbortEvent} from '../../src/events/abort_events.js';

const INVOCATION_ID = 'inv_1';
const ABORT_MESSAGE = 'Invocation was aborted by client.';

function fcEvent(
  author: string,
  callIds: Array<string | undefined>,
  params: CreateEventParams = {},
): Event {
  return createEvent({
    invocationId: INVOCATION_ID,
    author,
    content: {
      role: 'model',
      parts: callIds.map((id) => ({
        functionCall: {id, name: `tool_${id}`, args: {}},
      })),
    },
    ...params,
  });
}

function frEvent(callId: string): Event {
  return createEvent({
    invocationId: INVOCATION_ID,
    author: 'agent',
    content: {
      role: 'user',
      parts: [
        {functionResponse: {id: callId, name: `tool_${callId}`, response: {}}},
      ],
    },
  });
}

function build(events: Event[], branch?: string): Event[] {
  return buildAbortEvents({
    events,
    invocationId: INVOCATION_ID,
    rootAgentName: 'root_agent',
    branch,
  });
}

function responseIds(events: Event[]): Array<Array<string | undefined>> {
  return events.map((e) => getFunctionResponses(e).map((fr) => fr.id));
}

describe('buildAbortEvents', () => {
  it('seals a dangling call with an error response from its author', () => {
    const [event, ...rest] = build([fcEvent('agent', ['call_1'])]);

    expect(rest).toEqual([]);
    expect(event.invocationId).toBe(INVOCATION_ID);
    expect(event.author).toBe('agent');
    expect(event.content?.role).toBe('user');
    expect(event.errorCode).toBe('INVOCATION_ABORTED');
    expect(event.errorMessage).toBe(ABORT_MESSAGE);
    expect(getFunctionResponses(event)).toEqual([
      {id: 'call_1', name: 'tool_call_1', response: {error: ABORT_MESSAGE}},
    ]);
  });

  it('skips answered calls and calls without an id', () => {
    const events = [
      fcEvent('agent', ['call_1', 'call_2', undefined]),
      frEvent('call_1'),
    ];

    expect(responseIds(build(events))).toEqual([['call_2']]);
  });

  it('seals long-running calls too', () => {
    const events = [
      fcEvent('agent', ['call_1'], {longRunningToolIds: ['call_1']}),
    ];

    expect(responseIds(build(events))).toEqual([['call_1']]);
  });

  it('only considers events of the aborted invocation', () => {
    const events = [
      fcEvent('agent', ['old_call'], {invocationId: 'inv_0'}),
      fcEvent('agent', ['call_1']),
    ];

    expect(responseIds(build(events))).toEqual([['call_1']]);
  });

  it('groups calls by author, branch and isolation scope', () => {
    const events = [
      fcEvent('researcher', ['call_a'], {branch: 'root.researcher'}),
      fcEvent('researcher', ['call_b'], {branch: 'root.researcher'}),
      fcEvent('coder', ['call_c'], {branch: 'root.coder'}),
      fcEvent('coder', ['call_d'], {
        branch: 'root.coder',
        isolationScope: 'task_1',
      }),
    ];

    const result = build(events);

    expect(result.map((e) => [e.author, e.branch, e.isolationScope])).toEqual([
      ['researcher', 'root.researcher', undefined],
      ['coder', 'root.coder', undefined],
      ['coder', 'root.coder', 'task_1'],
    ]);
    expect(responseIds(result)).toEqual([
      ['call_a', 'call_b'],
      ['call_c'],
      ['call_d'],
    ]);
  });

  it('falls back to the invocation branch for a call event without one', () => {
    const [event] = build([fcEvent('agent', ['call_1'])], 'root');

    expect([event.author, event.branch]).toEqual(['agent', 'root']);
  });

  it('returns a single root-agent event when nothing is dangling', () => {
    const events = [fcEvent('agent', ['call_1']), frEvent('call_1')];

    const result = build(events, 'root');

    expect(result).toHaveLength(1);
    expect(result[0].author).toBe('root_agent');
    expect(result[0].branch).toBe('root');
    expect(result[0].content).toBeUndefined();
    expect(result[0].errorCode).toBe('INVOCATION_ABORTED');
    expect(result[0].errorMessage).toBe(ABORT_MESSAGE);
  });

  it('does not seal a task agent that already paused for the user', () => {
    const events = [
      fcEvent('coordinator', ['call_1']),
      createEvent({
        invocationId: INVOCATION_ID,
        author: 'task_worker',
        isolationScope: 'call_1',
        content: {role: 'model', parts: [{text: 'Which city?'}]},
      }),
    ];

    expect(build(events)).toEqual([]);
  });
});

describe('isAbortEvent', () => {
  it('recognizes both kinds of built events', () => {
    const built = [...build([]), ...build([fcEvent('agent', ['call_1'])])];

    expect(built).toHaveLength(2);
    expect(built.every(isAbortEvent)).toBe(true);
  });

  it('does not match other error events or events without an error', () => {
    expect(isAbortEvent(fcEvent('agent', ['call_1']))).toBe(false);
    expect(
      isAbortEvent(
        createEvent({
          author: 'agent',
          errorCode: 'SAFETY',
          errorMessage: 'blocked',
        }),
      ),
    ).toBe(false);
  });
});
