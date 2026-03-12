/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  Event,
  InvocationContext,
  PluginManager,
  Session,
  TruncatingContextCompactor,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function createDummyEvent(id: string): Event {
  return {
    id,
    invocationId: 'inv-1',
    timestamp: Date.now(),
    actions: {
      stateDelta: {},
      artifactDelta: {},
      requestedAuthConfigs: {},
      requestedToolConfirmations: {},
      skipSummarization: false,
    },
  };
}

function createDummyContext(events: Event[]): InvocationContext {
  const session = {
    id: 'session-1',
    appName: 'app',
    userId: 'user',
    state: {},
    events,
    lastUpdateTime: Date.now(),
  } as Session;

  const agent = {} as BaseAgent;
  return new InvocationContext({
    invocationId: 'inv-1',
    session,
    agent,
    pluginManager: {} as PluginManager,
  });
}

describe('TruncatingContextCompactor', () => {
  it('should not compact if under threshold', () => {
    const compactor = new TruncatingContextCompactor({threshold: 3});
    const ctx = createDummyContext([
      createDummyEvent('1'),
      createDummyEvent('2'),
      createDummyEvent('3'),
    ]);

    expect(compactor.shouldCompact(ctx)).toBe(false);
  });

  it('should compact if over threshold', () => {
    const compactor = new TruncatingContextCompactor({threshold: 2});
    const ctx = createDummyContext([
      createDummyEvent('1'),
      createDummyEvent('2'),
      createDummyEvent('3'),
    ]);

    expect(compactor.shouldCompact(ctx)).toBe(true);
    compactor.compact(ctx);

    expect(ctx.session.events.length).toBe(2);
    expect(ctx.session.events[0].id).toBe('2');
    expect(ctx.session.events[1].id).toBe('3');
  });

  it('should preserve leading events', () => {
    const compactor = new TruncatingContextCompactor({
      threshold: 2,
      preserveLeadingEvents: 1,
    });
    const ctx = createDummyContext([
      createDummyEvent('1'), // leading
      createDummyEvent('2'), // removed
      createDummyEvent('3'), // retained
      createDummyEvent('4'), // retained
    ]);

    expect(compactor.shouldCompact(ctx)).toBe(true);
    compactor.compact(ctx);

    expect(ctx.session.events.length).toBe(3);
    expect(ctx.session.events[0].id).toBe('1');
    expect(ctx.session.events[1].id).toBe('3');
    expect(ctx.session.events[2].id).toBe('4');
  });
});
