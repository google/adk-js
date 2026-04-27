/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseAgentConfig,
  Event,
  InvocationContext,
  LoopAgent,
  PluginManager,
  Session,
  createEvent,
  createEventActions,
  isLoopAgent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class MockSubAgent extends BaseAgent {
  private eventsToYield: Event[];

  constructor(config: BaseAgentConfig, eventsToYield: Event[]) {
    super(config);
    this.eventsToYield = eventsToYield;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (const event of this.eventsToYield) {
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Ensure the event has the correct invocationId and branch from context
      yield {
        ...event,
        invocationId: context.invocationId,
        branch: context.branch,
      };
    }
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for this test
  }
}

describe('LoopAgent', () => {
  it('should be identified as LoopAgent', () => {
    const agent = new LoopAgent({name: 'loop'});
    expect(isLoopAgent(agent)).toBe(true);
  });

  it('should loop through sub-agents and yield events', async () => {
    const event1 = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });
    const event2 = createEvent({
      author: 'sub2',
      content: {role: 'model', parts: [{text: 'world'}]},
    });

    const sub1 = new MockSubAgent({name: 'sub1'}, [event1]);
    const sub2 = new MockSubAgent({name: 'sub2'}, [event2]);

    const loopAgent = new LoopAgent({
      name: 'loop',
      subAgents: [sub1, sub2],
      maxIterations: 1,
    });

    const parentContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: loopAgent,
      session: {
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        state: {},
        events: [],
        lastUpdateTime: Date.now(),
      } as unknown as Session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const event of loopAgent.runAsync(parentContext)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(2);
    expect(yieldedEvents[0].author).toBe('sub1');
    expect(yieldedEvents[1].author).toBe('sub2');
  });

  it('should stop after maxIterations', async () => {
    const event = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });

    const sub = new MockSubAgent({name: 'sub'}, [event]);

    const loopAgent = new LoopAgent({
      name: 'loop',
      subAgents: [sub],
      maxIterations: 2,
    });

    const parentContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: loopAgent,
      session: {
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        state: {},
        events: [],
        lastUpdateTime: Date.now(),
      } as unknown as Session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const event of loopAgent.runAsync(parentContext)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(2);
  });

  it('should stop on escalation', async () => {
    const event1 = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });
    const event2 = createEvent({
      author: 'sub2',
      content: {role: 'model', parts: [{text: 'world'}]},
      actions: createEventActions({escalate: true}),
    });
    const event3 = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'should not reach'}]},
    });

    const sub1 = new MockSubAgent({name: 'sub1'}, [event1, event3]);
    const sub2 = new MockSubAgent({name: 'sub2'}, [event2]);

    const loopAgent = new LoopAgent({
      name: 'loop',
      subAgents: [sub1, sub2],
      maxIterations: 5,
    });

    const parentContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: loopAgent,
      session: {
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        state: {},
        events: [],
        lastUpdateTime: Date.now(),
      } as unknown as Session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const event of loopAgent.runAsync(parentContext)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(3);
    expect(yieldedEvents[2].actions?.escalate).toBe(true);
  });

  it('should stop on abort signal', async () => {
    const event = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });

    const sub = new MockSubAgent({name: 'sub'}, [event]);

    const loopAgent = new LoopAgent({
      name: 'loop',
      subAgents: [sub],
      maxIterations: 5,
    });

    const controller = new AbortController();

    const parentContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: loopAgent,
      session: {
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        state: {},
        events: [],
        lastUpdateTime: Date.now(),
      } as unknown as Session,
      pluginManager: new PluginManager(),
      abortSignal: controller.signal,
    });

    controller.abort();

    const yieldedEvents: Event[] = [];
    for await (const event of loopAgent.runAsync(parentContext)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(0);
  });
});
