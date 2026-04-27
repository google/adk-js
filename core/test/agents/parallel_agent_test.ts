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
  ParallelAgent,
  PluginManager,
  createEvent,
  createSession,
  isParallelAgent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class MockSubAgent extends BaseAgent {
  private eventsToYield: Event[];
  private delay: number;

  constructor(config: BaseAgentConfig, eventsToYield: Event[], delay = 0) {
    super(config);
    this.eventsToYield = eventsToYield;
    this.delay = delay;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (const event of this.eventsToYield) {
      await new Promise((resolve) => setTimeout(resolve, this.delay));

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

describe('ParallelAgent', () => {
  it('should be identified as ParallelAgent', () => {
    const agent = new ParallelAgent({name: 'parallel'});
    expect(isParallelAgent(agent)).toBe(true);
  });

  it('should run sub-agents in parallel and merge events', async () => {
    const event1 = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });
    const event2 = createEvent({
      author: 'sub2',
      content: {role: 'model', parts: [{text: 'world'}]},
    });

    // sub1 takes longer, so sub2 should yield first
    const sub1 = new MockSubAgent({name: 'sub1'}, [event1], 50);
    const sub2 = new MockSubAgent({name: 'sub2'}, [event2], 10);

    const parallelAgent = new ParallelAgent({
      name: 'parallel',
      subAgents: [sub1, sub2],
    });

    const session = createSession({
      id: 'test-session',
      appName: 'test-app',
    });

    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent: parallelAgent,
      session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const event of parallelAgent.runAsync(context)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(2);
    // sub2 should be first because it has a shorter delay
    expect(yieldedEvents[0].author).toBe('sub2');
    expect(yieldedEvents[1].author).toBe('sub1');
  });

  it('should create isolated branch context for sub-agents', async () => {
    const event = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });

    const sub = new MockSubAgent({name: 'sub'}, [event]);

    const parallelAgent = new ParallelAgent({
      name: 'parallel',
      subAgents: [sub],
    });

    const session = createSession({
      id: 'test-session',
      appName: 'test-app',
    });

    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent: parallelAgent,
      session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const e of parallelAgent.runAsync(context)) {
      yieldedEvents.push(e);
    }

    expect(yieldedEvents.length).toBe(1);
    expect(yieldedEvents[0].branch).toBe('parallel.sub');
  });

  it('should respect abort signal', async () => {
    const event = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });

    // Make it take some time so we can abort
    const sub = new MockSubAgent({name: 'sub'}, [event], 100);

    const parallelAgent = new ParallelAgent({
      name: 'parallel',
      subAgents: [sub],
    });

    const controller = new AbortController();

    const session = createSession({
      id: 'test-session',
      appName: 'test-app',
    });

    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent: parallelAgent,
      session,
      pluginManager: new PluginManager(),
      abortSignal: controller.signal,
    });

    // Run in background and abort
    const runPromise = (async () => {
      const events: Event[] = [];
      for await (const e of parallelAgent.runAsync(context)) {
        events.push(e);
      }
      return events;
    })();

    controller.abort();

    const yieldedEvents = await runPromise;

    expect(yieldedEvents.length).toBe(0);
  });

  it('should abort after some events are yielded', async () => {
    const event1 = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });
    const event2 = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'world'}]},
    });

    const sub = new MockSubAgent({name: 'sub'}, [event1, event2], 10);

    const parallelAgent = new ParallelAgent({
      name: 'parallel',
      subAgents: [sub],
    });

    const controller = new AbortController();

    const session = createSession({
      id: 'test-session',
      appName: 'test-app',
    });

    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent: parallelAgent,
      session,
      pluginManager: new PluginManager(),
      abortSignal: controller.signal,
    });

    const yieldedEvents: Event[] = [];

    const runPromise = (async () => {
      for await (const e of parallelAgent.runAsync(context)) {
        yieldedEvents.push(e);
        controller.abort();
      }
    })();

    await runPromise;

    expect(yieldedEvents.length).toBe(1);
    expect(yieldedEvents[0].content?.parts?.[0]?.text).toBe('hello');
  });
});
