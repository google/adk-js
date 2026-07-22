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
  LlmAgent,
  LoopAgent,
  PluginManager,
  Session,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function makeSession(): Session {
  return {
    id: 'test-session',
    appName: 'test-app',
    userId: 'test-user',
    state: {},
    events: [],
    lastUpdateTime: Date.now(),
  } as unknown as Session;
}

/**
 * A minimal sub-agent that mirrors what an LlmAgent does per run: it records a
 * single LLM call against the invocation's shared counter (as
 * `LlmAgent.callLlmAsync` does via `invocationContext.incrementLlmCallCount()`)
 * and yields one event. It deliberately goes through `BaseAgent.runAsync`, so
 * each run builds a fresh child context via the real `createInvocationContext`
 * — the exact code path where the counter used to reset.
 */
class LlmCallingAgent extends BaseAgent {
  constructor(config: BaseAgentConfig) {
    super(config);
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    context.incrementLlmCallCount();
    yield createEvent({
      author: this.name,
      content: {role: 'model', parts: [{text: 'ok'}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for this test.
  }
}

describe('InvocationContext LLM-call cost tracking', () => {
  it('shares the LLM-call counter across child contexts so maxLlmCalls spans the whole invocation', () => {
    const rootAgent = new LoopAgent({name: 'root'});
    const subAgent = new LoopAgent({name: 'sub'});

    const root = new InvocationContext({
      invocationId: 'inv-1',
      agent: rootAgent,
      session: makeSession(),
      pluginManager: new PluginManager(),
      runConfig: {maxLlmCalls: 2},
    });

    // Mirrors BaseAgent.createInvocationContext: a child context for a
    // sub-agent copies the parent context and swaps the agent. The LLM-call
    // counter must be shared, not reset.
    const child = new InvocationContext({...root, agent: subAgent});

    root.incrementLlmCallCount(); // invocation total = 1
    child.incrementLlmCallCount(); // invocation total = 2 (shared counter)

    // The 3rd call anywhere in the invocation must exceed the limit of 2.
    expect(() => child.incrementLlmCallCount()).toThrowError(
      /Max number of llm calls limit of 2 exceeded/,
    );
  });

  it('shares the counter across a grandchild context (nested sub-agents)', () => {
    const root = new InvocationContext({
      invocationId: 'inv-1',
      agent: new LoopAgent({name: 'root'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
      runConfig: {maxLlmCalls: 1},
    });
    const child = new InvocationContext({
      ...root,
      agent: new LoopAgent({name: 'child'}),
    });
    const grandChild = new InvocationContext({
      ...child,
      agent: new LoopAgent({name: 'grandchild'}),
    });

    root.incrementLlmCallCount(); // total = 1 (at limit)

    expect(() => grandChild.incrementLlmCallCount()).toThrowError(
      /Max number of llm calls limit of 1 exceeded/,
    );
  });

  it('starts a fresh counter for a separate invocation', () => {
    const agent = new LoopAgent({name: 'root'});

    const first = new InvocationContext({
      invocationId: 'inv-1',
      agent,
      session: makeSession(),
      pluginManager: new PluginManager(),
      runConfig: {maxLlmCalls: 1},
    });
    first.incrementLlmCallCount(); // total = 1 (at limit)
    expect(() => first.incrementLlmCallCount()).toThrow();

    // A brand-new invocation context must not inherit the previous counter.
    const second = new InvocationContext({
      invocationId: 'inv-2',
      agent,
      session: makeSession(),
      pluginManager: new PluginManager(),
      runConfig: {maxLlmCalls: 1},
    });
    expect(() => second.incrementLlmCallCount()).not.toThrow();
  });

  it('enforces maxLlmCalls across a real multi-iteration LoopAgent run', async () => {
    // Reproduces the reported runaway scenario end-to-end: a LoopAgent whose
    // sub-agent makes one LLM call per iteration. Before the fix, every
    // iteration built a child context with a fresh counter, so the run made an
    // unbounded number of LLM calls and never tripped `maxLlmCalls`. With the
    // shared cost manager, the counter accumulates across iterations and the
    // limit bounds the whole run.
    const inner = new LlmCallingAgent({name: 'inner'});
    const loop = new LoopAgent({
      name: 'loop',
      subAgents: [inner],
      // Far more iterations than maxLlmCalls; the LLM-call limit — not the
      // iteration count — must stop the run.
      maxIterations: 100,
    });

    const rootContext = new InvocationContext({
      invocationId: 'inv-run',
      agent: loop,
      session: makeSession(),
      pluginManager: new PluginManager(),
      runConfig: {maxLlmCalls: 3},
    });

    const events: Event[] = [];
    const run = async () => {
      for await (const event of loop.runAsync(rootContext)) {
        events.push(event);
      }
    };

    // The 4th call across the run exceeds the limit of 3.
    await expect(run()).rejects.toThrowError(
      /Max number of llm calls limit of 3 exceeded/,
    );
    // Exactly the 3 permitted iterations produced an event before the throw,
    expect(events).toHaveLength(3);
  });
});

describe('InvocationContext.shouldPauseInvocation', () => {
  function createTestContext(events: Event[] = []): InvocationContext {
    const agent = new LlmAgent({name: 'test_agent', description: 'Agent'});
    const session = createSession({
      id: 'test_session',
      appName: 'test_app',
      userId: 'test_user',
      events: [],
    });
    for (const e of events) {
      session.events.push(e);
    }
    return new InvocationContext({
      invocationId: 'inv_test',
      agent,
      session,
      pluginManager: new PluginManager(),
    });
  }

  it('returns false for events without longRunningToolIds', () => {
    const context = createTestContext();
    const event = createEvent({
      invocationId: 'inv_test',
      author: 'test_agent',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });

    expect(context.shouldPauseInvocation(event)).toBe(false);
  });

  it('returns false when longRunningToolIds is non-empty but event has no function calls', () => {
    const context = createTestContext();
    const event = createEvent({
      invocationId: 'inv_test',
      author: 'test_agent',
      content: {role: 'model', parts: [{text: 'hello'}]},
      longRunningToolIds: ['adk-1'],
    });

    expect(context.shouldPauseInvocation(event)).toBe(false);
  });

  it('returns true for events with active longRunningToolIds not resolved in session history', () => {
    const context = createTestContext();
    const event = createEvent({
      id: 'event-1',
      invocationId: 'inv_test',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'long_tool',
              args: {},
              id: 'adk-1',
            },
          },
        ],
      },
      longRunningToolIds: ['adk-1'],
    });
    context.session.events.push(event);

    expect(context.shouldPauseInvocation(event)).toBe(true);
  });

  it('returns false when longRunningToolIds are resolved by subsequent user event in sub-branch', () => {
    const toolCallEvent = createEvent({
      id: 'event-1',
      invocationId: 'inv_test',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'long_tool',
              args: {},
              id: 'adk-1',
            },
          },
        ],
      },
      longRunningToolIds: ['adk-1'],
    });

    const userResumeEvent = createEvent({
      id: 'event-2',
      invocationId: 'inv_test',
      author: 'user',
      branch: 'test_agent.long_tool@adk-1',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'long_tool',
              response: {status: 'done'},
              id: 'adk-1',
            },
          },
        ],
      },
    });

    const context = createTestContext([toolCallEvent, userResumeEvent]);
    expect(context.shouldPauseInvocation(toolCallEvent)).toBe(false);
  });

  it('handles branch run ID extraction edge cases when checking sub-branch resolution', () => {
    const toolCallEvent = createEvent({
      id: 'event-1',
      invocationId: 'inv_test',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'long_tool',
              args: {},
              id: 'adk-2',
            },
          },
        ],
      },
      longRunningToolIds: ['adk-2'],
    });

    const userResumeWithMultiBranch = createEvent({
      id: 'event-2',
      invocationId: 'inv_test',
      author: 'user',
      branch: 'parent@run1.tool@adk-2.child@run3',
      content: {
        role: 'user',
        parts: [{text: 'resumed'}],
      },
    });

    const context = createTestContext([
      toolCallEvent,
      userResumeWithMultiBranch,
    ]);
    expect(context.shouldPauseInvocation(toolCallEvent)).toBe(false);

    const userResumeWithEmptyBranch = createEvent({
      id: 'event-3',
      invocationId: 'inv_test',
      author: 'user',
      branch: 'parent.tool@',
      content: {
        role: 'user',
        parts: [{text: 'resumed'}],
      },
    });

    const context2 = createTestContext([
      toolCallEvent,
      userResumeWithEmptyBranch,
    ]);
    expect(context2.shouldPauseInvocation(toolCallEvent)).toBe(true);
  });
});
