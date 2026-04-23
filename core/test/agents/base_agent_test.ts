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
  LlmAgent,
  PluginManager,
  Session,
  createEvent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class MockAgent extends BaseAgent {
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
      content: {role: 'model', parts: [{text: `Response from ${this.name}`}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for this test
  }
}

describe('BaseAgent', () => {
  describe('rootAgent', () => {
    it('should return the actual root agent for sub-agents', () => {
      const subAgent = new LlmAgent({
        name: 'sub_agent',
        description: 'A sub agent',
      });

      const rootAgent = new LlmAgent({
        name: 'root_agent',
        description: 'The root agent',
        subAgents: [subAgent],
      });

      expect(subAgent.rootAgent).toBe(rootAgent);
      expect(rootAgent.rootAgent).toBe(rootAgent);
    });

    it('should traverse multiple levels of nesting', () => {
      const leafAgent = new LlmAgent({name: 'leaf_agent'});
      const middleAgent = new LlmAgent({
        name: 'middle_agent',
        subAgents: [leafAgent],
      });
      const rootAgent = new LlmAgent({
        name: 'root_agent',
        subAgents: [middleAgent],
      });

      expect(leafAgent.rootAgent).toBe(rootAgent);
      expect(middleAgent.rootAgent).toBe(rootAgent);
      expect(rootAgent.rootAgent).toBe(rootAgent);
    });
  });

  describe('Abort Signal Handling', () => {
    it('should stop processing beforeAgentCallbacks if aborted', async () => {
      const controller = new AbortController();
      let callback2Called = false;

      const agent = new MockAgent({
        name: 'test_agent',
        beforeAgentCallback: [
          async () => {
            controller.abort();
            return undefined;
          },
          async () => {
            callback2Called = true;
            return undefined;
          },
        ],
      });

      const parentContext = new InvocationContext({
        invocationId: 'test',
        agent: agent,
        session: {
          id: 'test-session',
          appName: 'test-app',
          userId: 'test-user',
          state: {},
          events: [],
          lastUpdateTime: Date.now(),
        } as Session,
        pluginManager: new PluginManager(),
        abortSignal: controller.signal,
      });

      const generator = agent.runAsync(parentContext);

      // Consume the generator
      for await (const _ of generator) {
        // do nothing
      }

      expect(callback2Called).toBe(false);
    });

    it('should stop processing afterAgentCallbacks if aborted', async () => {
      const controller = new AbortController();
      let callback2Called = false;

      const agent = new MockAgent({
        name: 'test_agent',
        afterAgentCallback: [
          async () => {
            controller.abort();
            return undefined;
          },
          async () => {
            callback2Called = true;
            return undefined;
          },
        ],
      });

      const parentContext = new InvocationContext({
        invocationId: 'test',
        agent: agent,
        session: {
          id: 'test-session',
          appName: 'test-app',
          userId: 'test-user',
          state: {},
          events: [],
          lastUpdateTime: Date.now(),
        } as Session,
        pluginManager: new PluginManager(),
        abortSignal: controller.signal,
      });

      const generator = agent.runAsync(parentContext);

      // Consume the generator
      for await (const _ of generator) {
        // do nothing
      }

      expect(callback2Called).toBe(false);
    });
  });
});
