/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseSummarizer,
  CompactedEvent,
  Event,
  InvocationContext,
  PluginManager,
  Session,
  TokenBasedContextCompactor,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class MockSummarizer implements BaseSummarizer {
  async summarize(events: Event[]): Promise<CompactedEvent> {
    return {
      id: 'mock-id',
      invocationId: '',
      author: 'system',
      actions: {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfigs: [],
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
  tokenCount?: number,
  isFuncCall?: boolean,
  isFuncResp?: boolean,
): Event {
  const event: Event = {
    id,
    timestamp: Date.now(),
    content: {parts: []},
  } as unknown as Event;
  if (tokenCount !== undefined) {
    event.usageMetadata = {promptTokenCount: tokenCount};
  }
  if (isFuncCall) {
    event.content!.parts!.push({functionCall: {name: 'mock', args: {}}});
  }
  if (isFuncResp) {
    event.content!.parts!.push({
      functionResponse: {name: 'mock', response: {}},
    });
  }
  return event;
}

function createMockInvocationContext(events: Event[]): InvocationContext {
  const session = {
    id: 'test-session',
    events,
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

describe('TokenBasedContextCompactor', () => {
  it('should not compact if event count is within retention size', async () => {
    const compactor = new TokenBasedContextCompactor({
      tokenThreshold: 10,
      eventRetentionSize: 3,
      summarizer: new MockSummarizer(),
    });

    const context = createMockInvocationContext([
      createMockEvent('1', 5),
      createMockEvent('2', 5),
      createMockEvent('3', 5),
    ]);

    expect(await compactor.shouldCompact(context)).toBe(false);

    await compactor.compact(context);
    expect(context.session.events.length).toBe(3);
  });

  it('should compact if token threshold exceeded and retention size met', async () => {
    const compactor = new TokenBasedContextCompactor({
      tokenThreshold: 10,
      eventRetentionSize: 2,
      summarizer: new MockSummarizer(),
    });

    // Total tokens: 5 + 5 + 5 + 5 = 20 > 10. Length = 4 > 2.
    const context = createMockInvocationContext([
      createMockEvent('1', 5),
      createMockEvent('2', 5),
      createMockEvent('3', 5),
      createMockEvent('4', 5),
    ]);

    expect(await compactor.shouldCompact(context)).toBe(true);

    await compactor.compact(context);

    // Should append 1 compacted event and keep all 4 initial events.
    // Resulting length = 4 (initial) + 1 (compacted) = 5
    expect(context.session.events.length).toBe(5);
    const compacted = context.session.events[4];
    expect((compacted as unknown as {isCompacted: boolean}).isCompacted).toBe(
      true,
    );
    expect(
      (compacted as unknown as {compactedContent: string}).compactedContent,
    ).toBe('Mock summary of 2 events');
    expect(context.session.events[2].id).toBe('3');
    expect(context.session.events[3].id).toBe('4');
  });

  it('should not split tool call and responses', async () => {
    const compactor = new TokenBasedContextCompactor({
      tokenThreshold: 10,
      eventRetentionSize: 2,
      summarizer: new MockSummarizer(),
    });

    // Suppose we have 4 events. Retention = 2 implies events[2] and events[3] retained.
    // If events[2] is a response, and events[1] is the call, then events[1] should safely be retained too.
    const context = createMockInvocationContext([
      createMockEvent('0', 5), // text
      createMockEvent('1', 5, true, false), // call
      createMockEvent('2', 5, false, true), // response
      createMockEvent('3', 5), // text
    ]);

    await compactor.compact(context);

    // Initial split index would be 2. Since events[1] is a call and events[2] is a resp, it drops split index to 1.
    // So only events[0] is compacted, and the new CompactedEvent is appended.
    expect(context.session.events.length).toBe(5); // 4 initial + 1 compacted
    const compacted = context.session.events[4];
    expect((compacted as unknown as {isCompacted: boolean}).isCompacted).toBe(
      true,
    );
    expect(
      (compacted as unknown as {compactedContent: string}).compactedContent,
    ).toBe('Mock summary of 1 events');
    expect(context.session.events[1].id).toBe('1');
    expect(context.session.events[2].id).toBe('2');
    expect(context.session.events[3].id).toBe('3');
  });
});
