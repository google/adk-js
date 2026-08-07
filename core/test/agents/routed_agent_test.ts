/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseAgentConfig,
  Event,
  InvocationContext,
  InvocationContextParams,
  LlmAgent,
  RoutedAgent,
  Session,
  createEvent,
  isRoutedAgent,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';
import {Logger, setLogger} from '../../src/utils/logger.js';

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
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {
        role: 'model',
        parts: [{text: `Live response from ${this.name}`}],
      },
    });
  }

  override async *runLive(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runLiveImpl(context);
  }
}

function createTestContext(params: {
  invocationId?: string;
  branch?: string;
  agent: BaseAgent;
  session?: Session;
}): InvocationContext {
  return new InvocationContext({
    invocationId: params.invocationId ?? 'test-invocation',
    branch: params.branch ?? 'test-branch',
    agent: params.agent,
    session: params.session,
  } as unknown as InvocationContextParams);
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

  describe('experimental check', () => {
    const warnCalls: string[] = [];
    const mockLogger: Logger = {
      setLogLevel: () => {},
      log: () => {},
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => {
        warnCalls.push(args.map((a) => String(a)).join(' '));
      },
      error: () => {},
    };

    it('warns when instantiated', () => {
      setLogger(mockLogger);

      const router = async () => 'agent-a';
      new RoutedAgent({name: 'router', agents: [], router});

      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0]).toContain('Class RoutedAgent is experimental');
    });
  });

  it('should route runAsync to the selected agent A', async () => {
    let routerCalledWithAgents: Readonly<Record<string, BaseAgent>> | null =
      null;
    let routerCalledWithContext: InvocationContext | null = null;
    const router = async (
      agents: Readonly<Record<string, BaseAgent>>,
      ctx: InvocationContext,
    ) => {
      routerCalledWithAgents = agents;
      routerCalledWithContext = ctx;
      return 'agent-a';
    };

    const routedAgent = new RoutedAgent({name: 'router', agents, router});
    const context = createTestContext({agent: routedAgent});

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
      _agents: Readonly<Record<string, BaseAgent>>,
      _ctx: InvocationContext,
    ) => 'agent-b';

    const routedAgent = new RoutedAgent({name: 'router', agents, router});
    const context = createTestContext({agent: routedAgent});

    const generator = routedAgent['runAsyncImpl'](context);
    const result = await generator.next();

    expect(result.value?.author).toBe('agent-b');
  });

  it('should throw error if selected agent is not found', async () => {
    const router = async (
      _agents: Readonly<Record<string, BaseAgent>>,
      _ctx: InvocationContext,
    ) => 'unknown-agent';

    const routedAgent = new RoutedAgent({name: 'router', agents, router});
    const context = createTestContext({agent: routedAgent});

    const generator = routedAgent['runAsyncImpl'](context);

    await expect(generator.next()).rejects.toThrow(
      'Item not found for key: unknown-agent',
    );
  });

  it('should maintain subAgents tree in super', () => {
    const router = async (
      _agents: Readonly<Record<string, BaseAgent>>,
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
      agents: Readonly<Record<string, BaseAgent>>,
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
    const context = createTestContext({agent: routedAgent});

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
      agents: Readonly<Record<string, BaseAgent>>,
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
    const context = createTestContext({agent: routedAgent});

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
      agents: Readonly<Record<string, BaseAgent>>,
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
    const context = createTestContext({agent: routedAgent});

    const generator = routedAgent['runAsyncImpl'](context);
    await expect(generator.next()).rejects.toThrow('Initial fail');
  });

  it('should maintain the session history on the next invocation when a new agent is selected', async () => {
    const session: Session = {
      id: 'session-id',
      appName: 'test-app',
      userId: 'user-id',
      state: {},
      events: [] as Event[],
      lastUpdateTime: Date.now(),
    };

    let selectedAgentName = 'agent-a';
    const router = async () => selectedAgentName;

    class HistoryCheckingAgent extends BaseAgent {
      constructor(name: string) {
        super({name});
      }

      protected async *runAsyncImpl(
        context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        expect(context.session?.events.length).toBe(1);
        expect(context.session?.events[0].author).toBe('agent-a');

        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          content: {
            role: 'model',
            parts: [{text: `Response from ${this.name}`}],
          },
        });
      }

      protected async *runLiveImpl(_context: InvocationContext) {}
    }

    const localAgentA = new MockAgent('agent-a');
    const localAgentB = new HistoryCheckingAgent('agent-b');
    const testAgents = [localAgentA, localAgentB];

    const routedAgent = new RoutedAgent({
      name: 'router',
      agents: testAgents,
      router,
    });

    const context1 = createTestContext({
      invocationId: 'invocation-1',
      branch: 'branch-1',
      agent: routedAgent,
      session,
    });

    const generator1 = routedAgent['runAsyncImpl'](context1);
    const event1 = await generator1.next();

    if (event1.value) {
      session.events.push(event1.value);
    }

    selectedAgentName = 'agent-b';

    const context2 = createTestContext({
      invocationId: 'invocation-2',
      branch: 'branch-2',
      agent: routedAgent,
      session,
    });

    const generator2 = routedAgent['runAsyncImpl'](context2);
    const event2 = await generator2.next();

    expect(session.events.length).toBe(1);
    expect(event2.value?.author).toBe('agent-b');
  });

  it('should route runLive to the selected agent A', async () => {
    let routerCalledWithAgents: Readonly<Record<string, BaseAgent>> | null =
      null;
    let routerCalledWithContext: InvocationContext | null = null;
    const router = async (
      agents: Readonly<Record<string, BaseAgent>>,
      ctx: InvocationContext,
    ) => {
      routerCalledWithAgents = agents;
      routerCalledWithContext = ctx;
      return 'agent-a';
    };

    const routedAgent = new RoutedAgent({name: 'router', agents, router});
    const context = createTestContext({agent: routedAgent});

    const generator = routedAgent['runLiveImpl'](context);
    const result = await generator.next();

    expect(result.value?.author).toBe('agent-a');
    expect(result.value?.content?.parts?.[0]?.text).toBe(
      'Live response from agent-a',
    );
    expect(routerCalledWithContext).toBeDefined();
    expect(routerCalledWithAgents).toBeDefined();
  });

  it('should failover in runLiveImpl if the first agent fails before yielding', async () => {
    class FailingLiveAgent extends BaseAgent {
      constructor(name: string) {
        super({name});
      }

      protected async *runAsyncImpl(
        _context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {}

      // eslint-disable-next-line require-yield
      protected async *runLiveImpl(
        _context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        throw new Error('Live agent failed');
      }
    }

    const failingAgent = new FailingLiveAgent('agent-failing');
    const successAgent = new MockAgent('agent-success');
    const testAgents = [failingAgent, successAgent];

    let routerCalls = 0;
    const router = async (
      agents: Readonly<Record<string, BaseAgent>>,
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
    const context = createTestContext({agent: routedAgent});

    const generator = routedAgent['runLiveImpl'](context);
    const result = await generator.next();

    expect(result.value?.author).toBe('agent-success');
    expect(routerCalls).toBe(2);
  });

  describe('clone', () => {
    // A clone-compatible mock: unlike the top-level `MockAgent` (whose
    // constructor takes a bare `name`), this accepts a config object, so
    // `BaseAgent.clone()` can rebuild it via `new ctor(config)`. It yields a
    // deterministic event so routing can be verified without a model.
    class CloneableAgent extends BaseAgent {
      constructor(config: BaseAgentConfig) {
        super(config);
      }

      protected async *runAsyncImpl(
        context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          content: {
            role: 'model',
            parts: [{text: `Response from ${this.name}`}],
          },
        });
      }

      protected async *runLiveImpl(
        _context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {}
    }

    it('deep-clones and re-parents array-form routing targets (detached root)', () => {
      const agentA = new CloneableAgent({name: 'agent-a'});
      const agentB = new CloneableAgent({name: 'agent-b'});
      const original = new RoutedAgent({
        name: 'router',
        agents: [agentA, agentB],
        router: () => 'agent-a',
      });

      const clone = original.clone();

      expect(clone).not.toBe(original);
      expect(clone).toBeInstanceOf(RoutedAgent);
      expect(clone.parentAgent).toBeUndefined();
      expect(clone.subAgents).toHaveLength(2);
      clone.subAgents.forEach((sub, i) => {
        expect(sub).not.toBe(original.subAgents[i]);
        expect(sub).toBeInstanceOf(CloneableAgent);
        expect(sub.name).toBe(original.subAgents[i].name);
        expect(sub.parentAgent).toBe(clone);
      });
      expect(clone.subAgents.map((s) => s.name)).toEqual([
        'agent-a',
        'agent-b',
      ]);

      // The originals are left untouched: still parented to the original router.
      expect(agentA.parentAgent).toBe(original);
      expect(agentB.parentAgent).toBe(original);
      expect(original.subAgents).toHaveLength(2);
      expect(original.subAgents[0]).toBe(agentA);
      expect(original.subAgents[1]).toBe(agentB);
    });

    it('preserves record keys and routes to the cloned target for the selected key', async () => {
      const primary = new CloneableAgent({name: 'primary-agent'});
      const fallback = new CloneableAgent({name: 'fallback-agent'});
      const original = new RoutedAgent({
        name: 'router',
        agents: {primary, fallback},
        router: () => 'primary',
      });

      const clone = original.clone();

      // The routing map keeps the record keys and maps them to cloned targets.
      const routingMap = clone['agents'] as Readonly<Record<string, BaseAgent>>;
      expect(Object.keys(routingMap)).toEqual(['primary', 'fallback']);
      expect(routingMap['primary'].name).toBe('primary-agent');
      expect(routingMap['primary']).not.toBe(primary);
      expect(routingMap['primary'].parentAgent).toBe(clone);

      // Functionally routes to the cloned primary target.
      const context = createTestContext({agent: clone});
      const result = await clone['runAsyncImpl'](context).next();
      expect(result.value?.author).toBe('primary-agent');
    });

    it('uses an `agents` override verbatim without cloning it', async () => {
      const target = new CloneableAgent({name: 'target'});
      const original = new RoutedAgent({
        name: 'router',
        agents: [target],
        router: () => 'replacement',
      });
      const replacement = new CloneableAgent({name: 'replacement'});

      const clone = original.clone({agents: [replacement]});

      expect(clone.subAgents).toHaveLength(1);
      expect(clone.subAgents[0]).toBe(replacement);
      expect(replacement.parentAgent).toBe(clone);

      const context = createTestContext({agent: clone});
      const result = await clone['runAsyncImpl'](context).next();
      expect(result.value?.author).toBe('replacement');
    });

    it('applies non-`agents` overrides while still cloning targets', () => {
      const agentA = new CloneableAgent({name: 'agent-a'});
      const original = new RoutedAgent({
        name: 'router',
        agents: [agentA],
        router: () => 'agent-a',
      });

      const clone = original.clone({name: 'router2'});

      expect(clone.name).toBe('router2');
      expect(original.name).toBe('router');
      expect(clone.subAgents).toHaveLength(1);
      expect(clone.subAgents[0]).not.toBe(agentA);
      expect(clone.subAgents[0].name).toBe('agent-a');
      expect(clone.subAgents[0].parentAgent).toBe(clone);
    });

    it('rejects a `parentAgent` override', () => {
      const agentA = new CloneableAgent({name: 'agent-a'});
      const original = new RoutedAgent({
        name: 'router',
        agents: [agentA],
        router: () => 'agent-a',
      });
      const someParent = new CloneableAgent({name: 'some-parent'});

      expect(() => original.clone({parentAgent: someParent})).toThrow(
        'Cannot update `parentAgent` field in clone.',
      );
    });

    it('clones a RoutedAgent whose targets are real LlmAgents (array form)', () => {
      const target = new LlmAgent({name: 'target'});
      const original = new RoutedAgent({
        name: 'router',
        agents: [target],
        router: () => 'target',
      });

      const clone = original.clone();

      expect(clone).not.toBe(original);
      expect(clone).toBeInstanceOf(RoutedAgent);
      expect(clone.parentAgent).toBeUndefined();
      expect(clone.subAgents[0]).toBeInstanceOf(LlmAgent);
      expect(clone.subAgents[0]).not.toBe(target);
      expect(clone.subAgents[0].name).toBe('target');
      expect(clone.subAgents[0].parentAgent).toBe(clone);
      expect(target.parentAgent).toBe(original);
    });
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
