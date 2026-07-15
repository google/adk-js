/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentControlledContextCompactor,
  BaseAgent,
  BaseSummarizer,
  CompactedEvent,
  Event,
  InvocationContext,
  PluginManager,
  Session,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

class MockSummarizer implements BaseSummarizer {
  async summarize(events: Event[]): Promise<CompactedEvent> {
    return {
      id: 'mock-id',
      invocationId: '',
      author: 'system',
      actions: {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      },
      timestamp: Date.now(),
      isCompacted: true,
      startTime: events[0].timestamp,
      endTime: events[events.length - 1].timestamp,
      compactedContent: `Mock summary of ${events.length} events`,
      content: {
        role: 'model',
        parts: [{text: `Mock summary of ${events.length} events`}],
      },
    } as CompactedEvent;
  }
}

function createMockEvent(
  id: string,
  isToolCall?: boolean,
  toolName?: string,
): Event {
  const event: Event = {
    id,
    timestamp: Date.now(),
    content: {parts: []},
  } as unknown as Event;
  if (isToolCall && toolName) {
    event.content!.parts!.push({functionCall: {name: toolName, args: {}}});
  }
  return event;
}

function createMockInvocationContext(
  events: Event[],
  state: Record<string, unknown> = {},
): InvocationContext {
  const session = {
    id: 'test-session',
    events,
    state,
    appName: 'test-app',
    userId: 'test-user',
  } as unknown as Session;
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: {} as BaseAgent,
    session,
    pluginManager: new PluginManager([]),
  });
}

describe('AgentControlledContextCompactor', () => {
  it('shouldCompact returns true only when flag is set', () => {
    const compactor = new AgentControlledContextCompactor({
      summarizer: new MockSummarizer(),
    });

    const contextWithoutFlag = createMockInvocationContext([]);
    expect(compactor.shouldCompact(contextWithoutFlag)).toBe(false);

    const contextWithFlag = createMockInvocationContext([], {
      'temp:consolidate_context': true,
    });
    expect(compactor.shouldCompact(contextWithFlag)).toBe(true);
  });

  it('compacts events before the consolidate_context tool call and clears flags', async () => {
    const summarizer = new MockSummarizer();
    const summarizeSpy = vi.spyOn(summarizer, 'summarize');
    const compactor = new AgentControlledContextCompactor({summarizer});

    const events = [
      createMockEvent('1'),
      createMockEvent('2'),
      createMockEvent('3', true, 'consolidate_context'),
      createMockEvent('4'), // response or subsequent event
    ];

    const state = {
      'temp:consolidate_context': true,
      'temp:consolidate_context_detail': 'some detail',
    };

    const context = createMockInvocationContext(events, state);

    await compactor.compact(context);

    // Should compact events '1' and '2'.
    // And inject the instruction event.
    expect(summarizeSpy).toHaveBeenCalledOnce();
    const passedEvents = summarizeSpy.mock.calls[0][0];
    expect(passedEvents.length).toBe(3); // '1', '2' + instruction event
    expect(passedEvents[0].id).toBe('1');
    expect(passedEvents[1].id).toBe('2');
    expect(passedEvents[2].content?.parts?.[0]?.text).toContain('some detail');

    // Should append the compacted event.
    expect(context.session.events.length).toBe(5);
    expect(context.session.events[4].id).toBe('mock-id');

    // Flags should be cleared.
    expect(context.session.state['temp:consolidate_context']).toBeUndefined();
    expect(
      context.session.state['temp:consolidate_context_detail'],
    ).toBeUndefined();
  });

  it('does not compact and clears flags if consolidate_context tool call is not found', async () => {
    const summarizer = new MockSummarizer();
    const summarizeSpy = vi.spyOn(summarizer, 'summarize');
    const compactor = new AgentControlledContextCompactor({summarizer});

    const events = [createMockEvent('1'), createMockEvent('2')];
    const state = {'temp:consolidate_context': true};
    const context = createMockInvocationContext(events, state);

    await compactor.compact(context);

    expect(summarizeSpy).not.toHaveBeenCalled();
    expect(context.session.events.length).toBe(2);
    expect(context.session.state['temp:consolidate_context']).toBeUndefined();
  });

  it('does not compact and clears flags if nothing to compact before tool call', async () => {
    const summarizer = new MockSummarizer();
    const summarizeSpy = vi.spyOn(summarizer, 'summarize');
    const compactor = new AgentControlledContextCompactor({summarizer});

    const events = [
      createMockEvent('1', true, 'consolidate_context'),
      createMockEvent('2'),
    ];
    const state = {'temp:consolidate_context': true};
    const context = createMockInvocationContext(events, state);

    await compactor.compact(context);

    expect(summarizeSpy).not.toHaveBeenCalled();
    expect(context.session.events.length).toBe(2);
    expect(context.session.state['temp:consolidate_context']).toBeUndefined();
  });

  it('clears flags even if summarizer fails', async () => {
    const summarizer = {
      summarize: async () => {
        throw new Error('Summarizer failed');
      },
    };
    const compactor = new AgentControlledContextCompactor({summarizer});

    const events = [
      createMockEvent('1'),
      createMockEvent('2', true, 'consolidate_context'),
    ];
    const state = {'temp:consolidate_context': true};
    const context = createMockInvocationContext(events, state);

    await compactor.compact(context);

    expect(context.session.events.length).toBe(2); // no compacted event appended
    expect(context.session.state['temp:consolidate_context']).toBeUndefined();
  });
});
