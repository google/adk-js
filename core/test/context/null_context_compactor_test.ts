/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  Event,
  InvocationContext,
  PluginManager,
  Session,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/**
 * We import NullContextCompactor directly from its source for testing to cover the actual source file.
 * Alternatively, we could import it from '@google/adk', but we already exported it there as well.
 */
import {NullContextCompactor} from '../../src/context/null_context_compactor.js';

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

describe('NullContextCompactor', () => {
  it('should compact when there are events', () => {
    const compactor = new NullContextCompactor();
    const ctx = createDummyContext([
      createDummyEvent('1'),
      createDummyEvent('2'),
      createDummyEvent('3'),
    ]);

    expect(compactor.shouldCompact(ctx)).toBe(true);
  });

  it('should not compact when there are no events', () => {
    const compactor = new NullContextCompactor();
    const ctx = createDummyContext([]);

    expect(compactor.shouldCompact(ctx)).toBe(false);
  });

  it('should remove all events upon compact', () => {
    const compactor = new NullContextCompactor();
    const ctx = createDummyContext([
      createDummyEvent('1'),
      createDummyEvent('2'),
      createDummyEvent('3'),
    ]);

    compactor.compact(ctx);

    expect(ctx.session.events.length).toBe(0);
  });
});
