/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {ContentRequestProcessor} from '../../src/agents/processors/content_request_processor.js';
import {AnchoredContextCompactor} from '../../src/context/anchored_context_compactor.js';
import {BaseSummarizer} from '../../src/context/summarizers/base_summarizer.js';
import {TokenBasedContextCompactor} from '../../src/context/token_based_context_compactor.js';
import {createCompactedEvent} from '../../src/events/compacted_event.js';
import {createEvent, Event} from '../../src/events/event.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';

type Tags = Pick<Event, 'branch' | 'isolationScope'>;

function text(id: string, tags: Tags = {}): Event {
  return createEvent({
    id,
    author: 'user',
    content: {role: 'user', parts: [{text: id}]},
    ...tags,
  });
}

function call(id: string, ids = ['c'], tags: Tags = {}): Event {
  return createEvent({
    id,
    author: 'agent',
    usageMetadata: {promptTokenCount: 10},
    content: {
      role: 'model',
      parts: ids.map((id) => ({functionCall: {id, name: 'work', args: {}}})),
    },
    ...tags,
  });
}

function response(id: string, ids = ['c'], tags: Tags = {}): Event {
  return createEvent({
    id,
    author: 'user',
    content: {
      role: 'user',
      parts: ids.map((id) => ({
        functionResponse: {
          id,
          name: 'work',
          response: {result: `result-${id}`},
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

async function fixture(
  kind: 'token' | 'anchored',
  events: Event[],
  eventRetentionSize = 1,
  tags: Tags = {},
) {
  const sessions = new InMemorySessionService();
  const session = await sessions.createSession({
    appName: 'app',
    userId: 'user',
  });
  for (const [index, event] of events.entries()) {
    await sessions.appendEvent({
      session,
      event: {...event, timestamp: (index + 1) * 1000},
    });
  }
  const context = new InvocationContext({
    invocationId: 'compaction-test',
    agent: new LlmAgent({name: 'agent', model: 'gemini-2.5-flash'}),
    session,
    sessionService: sessions,
    pluginManager: new PluginManager([]),
    ...tags,
  });
  const summarized: string[][] = [];
  const summarizer: BaseSummarizer = {
    async summarize(prefix) {
      summarized.push(prefix.map((event) => event.id));
      return createCompactedEvent({
        id: 'summary',
        author: 'system',
        timestamp: 100_000,
        startTime: prefix[0].timestamp,
        endTime: prefix[prefix.length - 1].timestamp,
        compactedContent: 'Local summary',
        content: {role: 'model', parts: [{text: 'Local summary'}]},
      });
    },
  };
  const options = {tokenThreshold: 1, eventRetentionSize, summarizer};
  const compactor =
    kind === 'token'
      ? new TokenBasedContextCompactor(options)
      : new AnchoredContextCompactor(options);
  async function build() {
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    for await (const _ of new ContentRequestProcessor().runAsync(
      context,
      request,
    )) {
      // Drain the real request processor without invoking a model.
    }
    return request.contents.flatMap((content) => content.parts ?? []);
  }
  return {compactor, context, summarized, build};
}

describe.each(['token', 'anchored'] as const)(
  '%s compactor tool pairs',
  (kind) => {
    it.each([
      {gap: false, retention: 1},
      {gap: true, retention: 1},
      {gap: true, retention: 2},
    ])(
      'preserves a pair with gap=$gap and retention=$retention',
      async ({gap, retention}) => {
        const {compactor, context, summarized, build} = await fixture(
          kind,
          [
            text('old'),
            call('call'),
            ...(gap ? [state('state')] : []),
            response('response'),
          ],
          retention,
        );
        expect(
          (await build()).map((part) => part.functionResponse?.response),
        ).toContainEqual({result: 'result-c'});
        expect(await compactor.shouldCompact(context)).toBe(true);
        await compactor.compact(context);
        const parts = await build();
        expect(
          parts.map((part) => part.functionResponse?.response),
        ).toContainEqual({result: 'result-c'});
        expect(parts.map((part) => part.functionCall?.id)).toContain('c');
        expect(summarized).toEqual([['old']]);
        expect(context.session.state['audit']).toBe(gap ? true : undefined);
      },
    );

    it('retains all calls from a multi-call event across state-only events', async () => {
      const {compactor, context, summarized, build} = await fixture(kind, [
        text('old'),
        call('calls', ['a', 'b']),
        state('state'),
        response('responses', ['a', 'b']),
      ]);
      await build();
      await compactor.compact(context);
      const parts = await build();
      expect(
        parts.flatMap((part) =>
          part.functionCall ? [part.functionCall.id] : [],
        ),
      ).toEqual(['a', 'b']);
      expect(
        parts.flatMap((part) =>
          part.functionResponse ? [part.functionResponse.response] : [],
        ),
      ).toEqual([{result: 'result-a'}, {result: 'result-b'}]);
      expect(summarized).toEqual([['old']]);
    });

    it('retains dependencies exposed by extending the retained tail', async () => {
      const {compactor, context, summarized, build} = await fixture(kind, [
        text('old'),
        call('call-a', ['a']),
        call('call-b', ['b']),
        response('response-a', ['a']),
        state('state'),
        response('response-b', ['b']),
      ]);
      await compactor.compact(context);
      expect(summarized).toEqual([['old']]);
      // The content builder's existing async-response rearrangement is separate
      // from compaction. The latest result must still have its original call.
      const parts = await build();
      expect(
        parts.map((part) => part.functionResponse?.response),
      ).toContainEqual({result: 'result-b'});
      expect(parts.map((part) => part.functionCall?.id)).toContain('b');
    });

    it('keeps a scoped pair while excluding peer events from the summary', async () => {
      const tags = {isolationScope: 'current', branch: 'root.worker'};
      const {compactor, context, summarized, build} = await fixture(
        kind,
        [
          text('old', tags),
          call('call', ['c'], tags),
          call('peer-call', ['c'], {
            isolationScope: 'peer',
            branch: 'root.worker',
          }),
          state('state', tags),
          response('response', ['c'], tags),
        ],
        1,
        tags,
      );
      await build();
      await compactor.compact(context);
      expect(summarized).toEqual([['old']]);
      expect(
        (await build()).map((part) => part.functionResponse?.response),
      ).toContainEqual({result: 'result-c'});
      expect(
        context.session.events.some((event) => event.id === 'peer-call'),
      ).toBe(true);
    });

    it('does not compact when protecting a nonadjacent pair retains all history', async () => {
      const {compactor, context, summarized, build} = await fixture(kind, [
        call('call'),
        state('state'),
        response('response'),
      ]);
      expect(await compactor.shouldCompact(context)).toBe(false);
      await compactor.compact(context);
      expect(summarized).toEqual([]);
      expect(
        (await build()).map((part) => part.functionResponse?.response),
      ).toContainEqual({result: 'result-c'});
    });

    it('does not let a future reuse of the ID shadow the preceding call', async () => {
      const {compactor, context, summarized} = await fixture(
        kind,
        [
          text('old'),
          call('original-call'),
          state('state'),
          response('response'),
          call('later-call'),
        ],
        2,
      );
      await compactor.compact(context);
      expect(summarized).toEqual([['old']]);
    });

    it('retains a sub-agent call answered by an unbranched user response', async () => {
      // The runner appends user messages without a branch, so the response to
      // a sub-agent call has no branch. The content builder pairs the two by
      // ID; compaction must keep the call for that pairing to be possible.
      const tags = {branch: 'root.sub'};
      const {compactor, context, summarized, build} = await fixture(
        kind,
        [
          text('old', tags),
          call('call', ['c'], tags),
          state('state'),
          response('response', ['c']),
        ],
        1,
        tags,
      );
      await compactor.compact(context);
      expect(summarized).toEqual([['old']]);
      const parts = await build();
      expect(
        parts.map((part) => part.functionResponse?.response),
      ).toContainEqual({result: 'result-c'});
      expect(parts.map((part) => part.functionCall?.id)).toContain('c');
    });

    it('retains an untagged call whose response carries the caller scope', async () => {
      // Untagged events are shared history, so the content builder sees both
      // events and pairs them by ID. A scope-sensitive match used to summarize
      // the call and make the builder throw `No function call event found`.
      const tags = {isolationScope: 'current'};
      const {compactor, context, summarized, build} = await fixture(
        kind,
        [
          text('old'),
          call('call'),
          state('state'),
          response('response', ['c'], tags),
        ],
        1,
        tags,
      );
      await compactor.compact(context);
      expect(summarized).toEqual([['old']]);
      const parts = await build();
      expect(
        parts.map((part) => part.functionResponse?.response),
      ).toContainEqual({result: 'result-c'});
      expect(parts.map((part) => part.functionCall?.id)).toContain('c');
    });

    // This test documents existing behavior rather than the fix: the
    // response's ID has no preceding call, so there is nothing compaction can
    // retain and the content builder still throws. It pins the boundary of
    // the fix from both sides (before and after compaction).
    it('leaves a response with no matching call unmatched in the content builder', async () => {
      const {compactor, context, summarized, build} = await fixture(kind, [
        text('old'),
        call('other-call', ['other']),
        state('state'),
        response('response'),
      ]);
      await expect(build()).rejects.toThrow('No function call event found');
      await compactor.compact(context);
      expect(summarized).toEqual([['old', 'other-call', 'state']]);
      await expect(build()).rejects.toThrow('No function call event found');
    });
  },
);
