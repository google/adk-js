/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlugin,
  createEvent,
  Event,
  InMemoryRunner,
  InvocationContext,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const TEST_USER_ID = 'test_user_id';
const TEST_MESSAGE = 'Hello, agent!';

class MockAgent extends BaseAgent {
  constructor(name = 'mock_agent') {
    super({name});
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'Mock response'}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

describe('InMemoryRunner', () => {
  it('should initialize with required agent parameter', () => {
    const agent = new MockAgent();
    const runner = new InMemoryRunner({agent});

    expect(runner.agent).toBe(agent);
    expect(runner.appName).toBe('InMemoryRunner');
  });

  it('should use custom appName when provided', () => {
    const agent = new MockAgent();
    const runner = new InMemoryRunner({agent, appName: 'MyApp'});

    expect(runner.appName).toBe('MyApp');
  });

  it('should initialize with in-memory services', () => {
    const agent = new MockAgent();
    const runner = new InMemoryRunner({agent});

    expect(runner.sessionService).toBeDefined();
    expect(runner.artifactService).toBeDefined();
    expect(runner.memoryService).toBeDefined();
  });

  it('should accept plugins', () => {
    const agent = new MockAgent();
    const plugin = new (class extends BasePlugin {
      constructor() {
        super('test_plugin');
      }
    })();

    const runner = new InMemoryRunner({agent, plugins: [plugin]});
    expect(runner.pluginManager).toBeDefined();
  });

  it('should default to empty plugins array', () => {
    const agent = new MockAgent();
    const runner = new InMemoryRunner({agent});

    expect(runner.pluginManager).toBeDefined();
  });

  it('should run agent and yield events', async () => {
    const agent = new MockAgent();
    const runner = new InMemoryRunner({agent});

    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: TEST_USER_ID,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: TEST_USER_ID,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: TEST_MESSAGE}]},
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    const agentEvent = events.find((e) => e.author === 'mock_agent');
    expect(agentEvent).toBeDefined();
    expect(agentEvent?.content?.parts?.[0]?.text).toBe('Mock response');
  });

  it('should support multiple independent sessions', async () => {
    const agent = new MockAgent();
    const runner = new InMemoryRunner({agent});

    const session1 = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'user_1',
    });
    const session2 = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'user_2',
    });

    expect(session1.id).not.toBe(session2.id);

    const events1: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user_1',
      sessionId: session1.id,
      newMessage: {role: 'user', parts: [{text: 'Hello from user 1'}]},
    })) {
      events1.push(event);
    }

    const events2: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user_2',
      sessionId: session2.id,
      newMessage: {role: 'user', parts: [{text: 'Hello from user 2'}]},
    })) {
      events2.push(event);
    }

    expect(events1.length).toBeGreaterThan(0);
    expect(events2.length).toBeGreaterThan(0);
  });
});
