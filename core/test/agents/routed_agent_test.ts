/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  Event,
  InvocationContext,
  InvocationContextParams,
  RoutedAgent,
  createEvent,
  isRoutedAgent,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

class MockAgent extends BaseAgent {
  constructor(name: string) {
    super({name});
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {role: 'model', parts: [{text: `Response from ${this.name}`}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Mock live mode if needed
  }
}

describe('RoutedAgent', () => {
  let agentA: MockAgent;
  let agentB: MockAgent;
  let agents: MockAgent[];

  beforeEach(() => {
    agentA = new MockAgent('agent-a');
    agentB = new MockAgent('agent-b');
    agents = [agentA, agentB];
  });

  it('should route runAsync to the selected agent A', async () => {
    let routerCalledWithAgents: ReadonlyMap<string, BaseAgent> | null = null;
    let routerCalledWithContext: InvocationContext | null = null;
    const router = async (
      agents: ReadonlyMap<string, BaseAgent>,
      ctx: InvocationContext,
    ) => {
      routerCalledWithAgents = agents;
      routerCalledWithContext = ctx;
      return 'agent-a';
    };

    const routedAgent = new RoutedAgent({name: 'router', agents, router});
    const context = new InvocationContext({
      invocationId: 'test-invocation',
      branch: 'test-branch',
      agent: routedAgent,
    } as unknown as InvocationContextParams);

    const generator = routedAgent['runAsyncImpl'](context); // Test runAsyncImpl directly or runAsync
    // If we run runAsync, it will create a new context, so testing runAsyncImpl is closer to our logic.
    // But testing runAsync verifies the whole pipeline. Let's test runAsync to see if it works as a standard agent.
    const result = await generator.next();

    expect(result.value?.author).toBe('agent-a');
    expect(result.value?.content?.parts?.[0]?.text).toBe(
      'Response from agent-a',
    );
    expect(routerCalledWithContext).toBeDefined();
    expect(routerCalledWithAgents).toBeDefined();
  });

  it('should route runAsync to the selected agent B', async () => {
    const router = async (
      _agents: ReadonlyMap<string, BaseAgent>,
      _ctx: InvocationContext,
    ) => 'agent-b';

    const routedAgent = new RoutedAgent({name: 'router', agents, router});
    const context = new InvocationContext({
      invocationId: 'test-invocation',
      branch: 'test-branch',
      agent: routedAgent,
    } as unknown as InvocationContextParams);

    const generator = routedAgent['runAsyncImpl'](context);
    const result = await generator.next();

    expect(result.value?.author).toBe('agent-b');
  });

  it('should throw error if selected agent is not found', async () => {
    const router = async (
      _agents: ReadonlyMap<string, BaseAgent>,
      _ctx: InvocationContext,
    ) => 'unknown-agent';

    const routedAgent = new RoutedAgent({name: 'router', agents, router});
    const context = new InvocationContext({
      invocationId: 'test-invocation',
      branch: 'test-branch',
      agent: routedAgent,
    } as unknown as InvocationContextParams);

    const generator = routedAgent['runAsyncImpl'](context);

    await expect(generator.next()).rejects.toThrow(
      'Agent not found for key: unknown-agent',
    );
  });

  it('should maintain subAgents tree in super', () => {
    const router = async (
      _agents: ReadonlyMap<string, BaseAgent>,
      _ctx: InvocationContext,
    ) => 'agent-a';
    const routedAgent = new RoutedAgent({name: 'router', agents, router});

    expect(routedAgent.subAgents.length).toBe(2);
    expect(routedAgent.subAgents[0].name).toBe('agent-a');
    expect(routedAgent.subAgents[1].name).toBe('agent-b');

    // Check if parents are set (if BaseAgent constructor does that, which it should)
    expect(routedAgent.subAgents[0].parentAgent).toBe(routedAgent);
  });

  it('should failover in runAsyncImpl if the first agent fails before yielding', async () => {
    class FailingAgent extends BaseAgent {
      constructor(name: string) {
        super({name});
      }

      // eslint-disable-next-line require-yield
      protected async *runAsyncImpl(
        _context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        throw new Error('Agent failed');
      }

      protected async *runLiveImpl(
        _context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {}
    }

    const failingAgent = new FailingAgent('agent-failing');
    const successAgent = new MockAgent('agent-success');
    const testAgents = [failingAgent, successAgent];

    let routerCalls = 0;
    const router = async (
      agents: ReadonlyMap<string, BaseAgent>,
      ctx: InvocationContext,
      context?: {failedKeys: ReadonlySet<string>; lastError: unknown},
    ) => {
      routerCalls++;
      if (!context) return 'agent-failing';
      if (context.failedKeys.has('agent-failing')) return 'agent-success';
      return undefined;
    };

    const routedAgent = new RoutedAgent({
      name: 'router',
      agents: testAgents,
      router,
    });
    const context = new InvocationContext({
      invocationId: 'test-invocation',
      branch: 'test-branch',
      agent: routedAgent,
    } as unknown as InvocationContextParams);

    const generator = routedAgent['runAsyncImpl'](context);
    const result = await generator.next();

    expect(result.value?.author).toBe('agent-success');
    expect(routerCalls).toBe(2);
  });

  it('should not failover in runAsyncImpl if failure occurs after yielding events', async () => {
    class PartialAgent extends BaseAgent {
      constructor(name: string) {
        super({name});
      }

      protected async *runAsyncImpl(
        context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          content: {role: 'model', parts: [{text: 'Partial response'}]},
        });
        throw new Error('Mid-stream failure');
      }

      protected async *runLiveImpl(
        _context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {}
    }

    const partialAgent = new PartialAgent('agent-partial');
    const fallbackAgent = new MockAgent('agent-fallback');
    const testAgents = [partialAgent, fallbackAgent];

    let routerCalls = 0;
    const router = async (
      agents: ReadonlyMap<string, BaseAgent>,
      ctx: InvocationContext,
      context?: {failedKeys: ReadonlySet<string>; lastError: unknown},
    ) => {
      routerCalls++;
      if (!context) return 'agent-partial';
      return 'agent-fallback';
    };

    const routedAgent = new RoutedAgent({
      name: 'router',
      agents: testAgents,
      router,
    });
    const context = new InvocationContext({
      invocationId: 'test-invocation',
      branch: 'test-branch',
      agent: routedAgent,
    } as unknown as InvocationContextParams);

    const generator = routedAgent['runAsyncImpl'](context);

    const firstResult = await generator.next();
    expect(firstResult.value?.content?.parts?.[0]?.text).toBe(
      'Partial response',
    );

    await expect(generator.next()).rejects.toThrow('Mid-stream failure');
    expect(routerCalls).toBe(1);
  });

  it('should propagate error if router returns undefined (bails out)', async () => {
    class FailingAgent extends BaseAgent {
      constructor(name: string) {
        super({name});
      }

      // eslint-disable-next-line require-yield
      protected async *runAsyncImpl(
        _context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        throw new Error('Initial fail');
      }

      protected async *runLiveImpl(
        _context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {}
    }

    const failingAgent = new FailingAgent('agent-failing');
    const testAgents = [failingAgent];

    const router = async (
      agents: ReadonlyMap<string, BaseAgent>,
      ctx: InvocationContext,
      context?: {failedKeys: ReadonlySet<string>; lastError: unknown},
    ) => {
      if (!context) return 'agent-failing';
      return undefined;
    };

    const routedAgent = new RoutedAgent({
      name: 'router',
      agents: testAgents,
      router,
    });
    const context = new InvocationContext({
      invocationId: 'test-invocation',
      branch: 'test-branch',
      agent: routedAgent,
    } as unknown as InvocationContextParams);

    const generator = routedAgent['runAsyncImpl'](context);
    await expect(generator.next()).rejects.toThrow('Initial fail');
  });
});

describe('isRoutedAgent', () => {
  it('should return false for null and undefined', () => {
    expect(isRoutedAgent(null)).toBe(false);
    expect(isRoutedAgent(undefined)).toBe(false);
  });

  it('should return false for plain objects', () => {
    expect(isRoutedAgent({})).toBe(false);
    expect(isRoutedAgent({name: 'test'})).toBe(false);
  });

  it('should return true for objects with the signature symbol', () => {
    const symbol = Symbol.for('google.adk.routedAgent');
    expect(isRoutedAgent({[symbol]: true})).toBe(true);
  });

  it('should return false for objects with the signature symbol set to false', () => {
    const symbol = Symbol.for('google.adk.routedAgent');
    expect(isRoutedAgent({[symbol]: false})).toBe(false);
  });

  it('should check if a RoutedAgent instance is identified', () => {
    const router = async () => 'agent-a';
    const agent = new RoutedAgent({name: 'router', agents: [], router});
    expect(isRoutedAgent(agent)).toBe(true);
  });
});
