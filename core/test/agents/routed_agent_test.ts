/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {RoutedAgent} from '../../src/agents/routed_agent.js';
import {Event, createEvent} from '../../src/events/event.js';

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
    let selectorCalledWith: InvocationContext | null = null;
    const selector = async (ctx: InvocationContext) => {
      selectorCalledWith = ctx;
      return 'agent-a';
    };

    const routedAgent = new RoutedAgent({name: 'router', agents, selector});
    const context = new InvocationContext({
      invocationId: 'test-invocation',
      branch: 'test-branch',
      agent: routedAgent,
    });

    const generator = routedAgent['runAsyncImpl'](context); // Test runAsyncImpl directly or runAsync
    // If we run runAsync, it will create a new context, so testing runAsyncImpl is closer to our logic.
    // But testing runAsync verifies the whole pipeline. Let's test runAsync to see if it works as a standard agent.
    const result = await generator.next();

    expect(result.value?.author).toBe('agent-a');
    expect(result.value?.content?.parts?.[0]?.text).toBe(
      'Response from agent-a',
    );
    expect(selectorCalledWith).toBeDefined();
  });

  it('should route runAsync to the selected agent B', async () => {
    const selector = async (_ctx: InvocationContext) => 'agent-b';

    const routedAgent = new RoutedAgent({name: 'router', agents, selector});
    const context = new InvocationContext({
      invocationId: 'test-invocation',
      branch: 'test-branch',
      agent: routedAgent,
    });

    const generator = routedAgent['runAsyncImpl'](context);
    const result = await generator.next();

    expect(result.value?.author).toBe('agent-b');
  });

  it('should throw error if selected agent is not found', async () => {
    const selector = async (_ctx: InvocationContext) => 'unknown-agent';

    const routedAgent = new RoutedAgent({name: 'router', agents, selector});
    const context = new InvocationContext({
      invocationId: 'test-invocation',
      branch: 'test-branch',
      agent: routedAgent,
    });

    const generator = routedAgent['runAsyncImpl'](context);

    await expect(generator.next()).rejects.toThrow(
      'Agent not found for key: unknown-agent',
    );
  });

  it('should maintain subAgents tree in super', () => {
    const selector = async (_ctx: InvocationContext) => 'agent-a';
    const routedAgent = new RoutedAgent({name: 'router', agents, selector});

    expect(routedAgent.subAgents.length).toBe(2);
    expect(routedAgent.subAgents[0].name).toBe('agent-a');
    expect(routedAgent.subAgents[1].name).toBe('agent-b');

    // Check if parents are set (if BaseAgent constructor does that, which it should)
    expect(routedAgent.subAgents[0].parentAgent).toBe(routedAgent);
  });
});
