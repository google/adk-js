/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {calculateRetainStartIndex} from '../../src/context/compaction_utils.js';
import {createEvent, Event} from '../../src/events/event.js';

type Tags = Pick<Event, 'branch' | 'isolationScope'>;

function text(id: string, tags: Tags = {}): Event {
  return createEvent({
    id,
    author: 'user',
    content: {role: 'user', parts: [{text: id}]},
    ...tags,
  });
}

function call(
  id: string,
  callIds: Array<string | undefined> = ['c'],
  tags: Tags = {},
): Event {
  return createEvent({
    id,
    author: 'agent',
    content: {
      role: 'model',
      parts: callIds.map((callId) => ({
        functionCall: {id: callId, name: 'work', args: {}},
      })),
    },
    ...tags,
  });
}

function response(
  id: string,
  responseIds: Array<string | undefined> = ['c'],
  tags: Tags = {},
): Event {
  return createEvent({
    id,
    author: 'user',
    content: {
      role: 'user',
      parts: responseIds.map((responseId) => ({
        functionResponse: {
          id: responseId,
          name: 'work',
          response: {result: `result-${responseId}`},
        },
      })),
    },
    ...tags,
  });
}

function state(id: string, tags: Tags = {}): Event {
  return createEvent({
    id,
    author: 'agent',
    actions: {stateDelta: {audit: true}},
    ...tags,
  });
}

describe('calculateRetainStartIndex', () => {
  it('keeps an id-less adjacent call and response together', () => {
    expect(
      calculateRetainStartIndex(
        [
          text('old'),
          call('call', [undefined]),
          response('response', [undefined]),
        ],
        1,
      ),
    ).toBe(1);
  });

  it('retains a call separated from its response by a state event', () => {
    expect(
      calculateRetainStartIndex(
        [text('old'), call('call'), state('state'), response('response')],
        1,
      ),
    ).toBe(1);
  });

  it('retains a sub-agent call answered by an unbranched user response', () => {
    // A sub-agent call carries the sub-agent branch, while the runner appends
    // user messages without a branch. The content builder pairs them by ID
    // after filtering, so compaction must retain the call.
    expect(
      calculateRetainStartIndex(
        [
          text('old'),
          call('call', ['c'], {branch: 'root.sub'}),
          state('state'),
          response('response', ['c']),
        ],
        1,
      ),
    ).toBe(1);
  });

  it('retains an untagged call whose response carries the caller scope', () => {
    // Regression for the review finding: the content builder sees both events
    // (untagged events are shared history) and pairs them by ID. Keying the
    // match on the scope used to summarize the call away and make the builder
    // throw `No function call event found`.
    expect(
      calculateRetainStartIndex(
        [
          text('old'),
          call('call'),
          state('state'),
          response('response', ['c'], {isolationScope: 'current'}),
        ],
        1,
      ),
    ).toBe(1);
  });

  it('retains all calls from a multi-call event across a state event', () => {
    expect(
      calculateRetainStartIndex(
        [
          text('old'),
          call('calls', ['a', 'b']),
          state('state'),
          response('responses', ['a', 'b']),
        ],
        1,
      ),
    ).toBe(1);
  });

  it('follows chained dependencies exposed by extending the retained tail', () => {
    // Retaining response-b's call (call-b) exposes response-a, whose own call
    // is call-a. The shrinking loop bound must follow that chain.
    expect(
      calculateRetainStartIndex(
        [
          text('old'),
          call('call-a', ['a']),
          call('call-b', ['b']),
          response('response-a', ['a']),
          state('state'),
          response('response-b', ['b']),
        ],
        1,
      ),
    ).toBe(1);
  });

  it('does not match an orphan response to a future call', () => {
    expect(
      calculateRetainStartIndex(
        [
          text('old'),
          response('response'),
          state('state'),
          call('future-call'),
        ],
        3,
      ),
    ).toBe(1);
  });

  it('uses the nearest preceding call when an ID is reused', () => {
    expect(
      calculateRetainStartIndex(
        [
          call('old-call'),
          state('state-a'),
          call('new-call'),
          state('state-b'),
          response('response'),
        ],
        1,
      ),
    ).toBe(2);
  });

  it('does not let a future reuse of the ID shadow the preceding call', () => {
    expect(
      calculateRetainStartIndex(
        [
          text('old'),
          call('original-call'),
          state('state'),
          response('response'),
          call('later-call'),
        ],
        2,
      ),
    ).toBe(1);
  });
});
