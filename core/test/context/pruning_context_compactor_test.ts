/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePruner,
  createEvent,
  Event,
  InvocationContext,
  PluginManager,
  PruningContextCompactor,
  Session,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

function createToolResponseEvent(
  id: string,
  toolName: string,
  response: unknown,
): Event {
  return createEvent({
    id,
    invocationId: 'inv-1',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: toolName,
            response,
          },
        },
      ],
    },
  });
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

describe('PruningContextCompactor', () => {
  const mockPruner: BasePruner = {
    prune: vi.fn().mockImplementation(() => 'pruned_value'),
  };

  it('should not compact if no events match rules', () => {
    const compactor = new PruningContextCompactor({
      rules: [{toolName: 'matching_tool', pruner: mockPruner}],
    });
    const ctx = createDummyContext([
      createToolResponseEvent('1', 'non_matching_tool', 'some response'),
      createEvent({
        id: '2',
        invocationId: 'inv-1',
        content: {role: 'user', parts: [{text: 'hello'}]},
      }),
    ]);

    expect(compactor.shouldCompact(ctx)).toBe(false);
  });

  it('should not compact if matching event is under threshold', () => {
    const compactor = new PruningContextCompactor({
      rules: [{toolName: 'matching_tool', pruner: mockPruner}],
      sizeThreshold: 100,
    });
    const ctx = createDummyContext([
      createToolResponseEvent('1', 'matching_tool', 'short'), // size is 7 (string len) or 9 (json stringified len)
    ]);

    expect(compactor.shouldCompact(ctx)).toBe(false);
  });

  it('should compact if matching event is over threshold', () => {
    const compactor = new PruningContextCompactor({
      rules: [{toolName: 'matching_tool', pruner: mockPruner}],
      sizeThreshold: 10,
    });
    const ctx = createDummyContext([
      createToolResponseEvent(
        '1',
        'matching_tool',
        'very_long_response_content',
      ),
    ]);

    expect(compactor.shouldCompact(ctx)).toBe(true);
  });

  it('should compact if matching event exists and no threshold specified', () => {
    const compactor = new PruningContextCompactor({
      rules: [{toolName: 'matching_tool', pruner: mockPruner}],
    });
    const ctx = createDummyContext([
      createToolResponseEvent('1', 'matching_tool', 'any'),
    ]);

    expect(compactor.shouldCompact(ctx)).toBe(true);
  });

  it('should prune only matching events over threshold during compact', async () => {
    const compactor = new PruningContextCompactor({
      rules: [{toolName: 'matching_tool', pruner: mockPruner}],
      sizeThreshold: 10,
    });

    const matchingOver = createToolResponseEvent(
      '1',
      'matching_tool',
      'very_long_response_content',
    );
    const matchingUnder = createToolResponseEvent(
      '2',
      'matching_tool',
      'short',
    );
    const nonMatching = createToolResponseEvent(
      '3',
      'other_tool',
      'very_long_response_content',
    );

    const ctx = createDummyContext([matchingOver, matchingUnder, nonMatching]);

    await compactor.compact(ctx);

    // matchingOver should be pruned
    expect(mockPruner.prune).toHaveBeenCalledWith('very_long_response_content');
    expect(matchingOver.content?.parts?.[0].functionResponse?.response).toBe(
      'pruned_value',
    );

    // matchingUnder should NOT be pruned
    expect(matchingUnder.content?.parts?.[0].functionResponse?.response).toBe(
      'short',
    );

    // nonMatching should NOT be pruned
    expect(nonMatching.content?.parts?.[0].functionResponse?.response).toBe(
      'very_long_response_content',
    );
  });
});
