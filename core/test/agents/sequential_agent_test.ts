/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseAgentConfig,
  createEvent,
  createSession,
  Event,
  InvocationContext,
  isSequentialAgent,
  PluginManager,
  SequentialAgent,
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
      yield {
        ...event,
        invocationId: context.invocationId,
        branch: context.branch,
      };
    }
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

function makeContext(agent: BaseAgent): InvocationContext {
  const session = createSession({
    id: 'test-session',
    appName: 'test-app',
  });
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session,
    pluginManager: new PluginManager(),
  });
}

describe('SequentialAgent', () => {
  it('should be identified by isSequentialAgent', () => {
    const agent = new SequentialAgent({name: 'seq'});
    expect(isSequentialAgent(agent)).toBe(true);
  });

  it('should return false for non-SequentialAgent objects', () => {
    expect(isSequentialAgent(null)).toBe(false);
    expect(isSequentialAgent(undefined)).toBe(false);
    expect(isSequentialAgent({})).toBe(false);
    expect(isSequentialAgent('string')).toBe(false);
  });

  it('should run sub-agents in sequential order', async () => {
    const event1 = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'from sub1'}]},
    });
    const event2 = createEvent({
      author: 'sub2',
      content: {role: 'model', parts: [{text: 'from sub2'}]},
    });

    const sub1 = new MockSubAgent({name: 'sub1'}, [event1]);
    const sub2 = new MockSubAgent({name: 'sub2'}, [event2]);

    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [sub1, sub2],
    });

    const context = makeContext(seq);

    const yieldedEvents: Event[] = [];
    for await (const event of seq.runAsync(context)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(2);
    // sub1 must come before sub2 (sequential order)
    expect(yieldedEvents[0].author).toBe('sub1');
    expect(yieldedEvents[1].author).toBe('sub2');
  });

  it('should yield all events from each sub-agent before moving to the next', async () => {
    const sub1Events = [
      createEvent({
        author: 'sub1',
        content: {role: 'model', parts: [{text: 'sub1 event 1'}]},
      }),
      createEvent({
        author: 'sub1',
        content: {role: 'model', parts: [{text: 'sub1 event 2'}]},
      }),
    ];
    const sub2Events = [
      createEvent({
        author: 'sub2',
        content: {role: 'model', parts: [{text: 'sub2 event 1'}]},
      }),
    ];

    const sub1 = new MockSubAgent({name: 'sub1'}, sub1Events);
    const sub2 = new MockSubAgent({name: 'sub2'}, sub2Events);

    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [sub1, sub2],
    });

    const context = makeContext(seq);

    const authors: string[] = [];
    for await (const event of seq.runAsync(context)) {
      authors.push(event.author);
    }

    expect(authors).toEqual(['sub1', 'sub1', 'sub2']);
  });

  it('should yield no events when there are no sub-agents', async () => {
    const seq = new SequentialAgent({name: 'seq', subAgents: []});
    const context = makeContext(seq);

    const yieldedEvents: Event[] = [];
    for await (const event of seq.runAsync(context)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(0);
  });

  it('should propagate invocationId to sub-agent events', async () => {
    const event = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });
    const sub1 = new MockSubAgent({name: 'sub1'}, [event]);
    const seq = new SequentialAgent({name: 'seq', subAgents: [sub1]});
    const context = makeContext(seq);

    const yieldedEvents: Event[] = [];
    for await (const e of seq.runAsync(context)) {
      yieldedEvents.push(e);
    }

    expect(yieldedEvents[0].invocationId).toBe('test-invocation');
  });

  it('should handle single sub-agent', async () => {
    const event = createEvent({
      author: 'only_sub',
      content: {role: 'model', parts: [{text: 'only response'}]},
    });
    const sub = new MockSubAgent({name: 'only_sub'}, [event]);
    const seq = new SequentialAgent({name: 'seq', subAgents: [sub]});
    const context = makeContext(seq);

    const yieldedEvents: Event[] = [];
    for await (const e of seq.runAsync(context)) {
      yieldedEvents.push(e);
    }

    expect(yieldedEvents.length).toBe(1);
    expect(yieldedEvents[0].author).toBe('only_sub');
  });
});
