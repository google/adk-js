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
  TrajectoryThoughtPruningCompactor,
} from '@google/adk';
import {FunctionCall, FunctionResponse} from '@google/genai';
import {describe, expect, it} from 'vitest';

function createMockEvent(
  id: string,
  parts: Array<{
    text?: string;
    thought?: boolean;
    functionCall?: FunctionCall;
    functionResponse?: FunctionResponse;
  }>,
): Event {
  return {
    id,
    timestamp: Date.now(),
    content: {
      role: 'model',
      parts: parts.map((p) => ({
        ...p,
      })),
    },
    actions: {
      stateDelta: {},
      artifactDelta: {},
      requestedAuthConfigs: {},
      requestedToolConfirmations: {},
    },
  } as unknown as Event;
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

describe('TrajectoryThoughtPruningCompactor', () => {
  describe('constructor', () => {
    it('should throw on negative eventRetentionSize', () => {
      expect(
        () => new TrajectoryThoughtPruningCompactor({eventRetentionSize: -1}),
      ).toThrow('eventRetentionSize must be a non-negative integer.');
    });

    it('should not throw on non-negative eventRetentionSize', () => {
      expect(
        () => new TrajectoryThoughtPruningCompactor({eventRetentionSize: 0}),
      ).not.toThrow();
      expect(
        () => new TrajectoryThoughtPruningCompactor({eventRetentionSize: 5}),
      ).not.toThrow();
    });
  });

  describe('shouldCompact', () => {
    it('should return false if events length is less than or equal to retention size', async () => {
      const compactor = new TrajectoryThoughtPruningCompactor({
        eventRetentionSize: 2,
      });
      const context = createMockInvocationContext([
        createMockEvent('1', [{text: 'thought', thought: true}]),
      ]);
      expect(await compactor.shouldCompact(context)).toBe(false);
    });

    it('should return false if older events have no thoughts', async () => {
      const compactor = new TrajectoryThoughtPruningCompactor({
        eventRetentionSize: 2,
      });
      const context = createMockInvocationContext([
        createMockEvent('1', [
          {text: 'action', functionCall: {name: 'mock', args: {}}},
        ]),
        createMockEvent('2', [
          {text: 'response', functionResponse: {name: 'mock', response: {}}},
        ]),
        createMockEvent('3', [{text: 'thought', thought: true}]), // in retention
        createMockEvent('4', [{text: 'thought', thought: true}]), // in retention
      ]);
      expect(await compactor.shouldCompact(context)).toBe(false);
    });

    it('should return true if older events have thoughts', async () => {
      const compactor = new TrajectoryThoughtPruningCompactor({
        eventRetentionSize: 2,
      });
      const context = createMockInvocationContext([
        createMockEvent('1', [
          {text: 'thinking', thought: true},
          {functionCall: {name: 'mock', args: {}}},
        ]),
        createMockEvent('2', [
          {text: 'response', functionResponse: {name: 'mock', response: {}}},
        ]),
        createMockEvent('3', [{text: 'thought', thought: true}]), // in retention
        createMockEvent('4', [{text: 'thought', thought: true}]), // in retention
      ]);
      expect(await compactor.shouldCompact(context)).toBe(true);
    });
  });

  describe('compact', () => {
    it('should do nothing if events length is less than or equal to retention size', async () => {
      const compactor = new TrajectoryThoughtPruningCompactor({
        eventRetentionSize: 2,
      });
      const event1 = createMockEvent('1', [{text: 'thought', thought: true}]);
      const context = createMockInvocationContext([event1]);

      await compactor.compact(context);

      expect(context.session.events.length).toBe(1);
      expect(context.session.events[0]).toBe(event1);
    });

    it('should prune thoughts from older events and preserve other parts', async () => {
      const compactor = new TrajectoryThoughtPruningCompactor({
        eventRetentionSize: 1,
      });
      const event1 = createMockEvent('1', [
        {text: 'thinking 1', thought: true},
        {text: 'action 1', functionCall: {name: 'tool1', args: {}}},
      ]);
      const event2 = createMockEvent('2', [
        {text: 'thinking 2', thought: true},
        {text: 'final answer'},
      ]); // in retention

      const context = createMockInvocationContext([event1, event2]);

      await compactor.compact(context);

      expect(context.session.events.length).toBe(2);

      const prunedEvent1 = context.session.events[0];
      expect(prunedEvent1.id).toBe('1');
      expect(prunedEvent1).not.toBe(event1); // new instance
      expect(prunedEvent1.content?.parts).toEqual([
        {text: 'action 1', functionCall: {name: 'tool1', args: {}}},
      ]);

      const unchangedEvent2 = context.session.events[1];
      expect(unchangedEvent2).toBe(event2); // same reference
    });

    it('should handle events with no content or parts gracefully', async () => {
      const compactor = new TrajectoryThoughtPruningCompactor({
        eventRetentionSize: 1,
      });
      const event1 = {id: '1', timestamp: Date.now()} as Event;
      const event2 = createMockEvent('2', [{text: 'thought', thought: true}]);

      const context = createMockInvocationContext([event1, event2]);

      await compactor.compact(context);

      expect(context.session.events.length).toBe(2);
      expect(context.session.events[0]).toBe(event1);
    });
  });
});
