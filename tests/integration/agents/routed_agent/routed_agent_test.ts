/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentRouter,
  AgentTool,
  BaseAgent,
  InvocationContext,
  LlmAgent,
  RoutedAgent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {createRunner, GeminiWithMockResponses} from '../../test_case_utils.js';

describe('RoutedAgent Integration', () => {
  it('should route to agent A when selected in root', async () => {
    const agentA = new LlmAgent({
      name: 'agent-a',
      model: new GeminiWithMockResponses([
        {
          candidates: [
            {content: {role: 'model', parts: [{text: 'Hello from A'}]}},
          ],
        },
      ]),
    });
    const agentB = new LlmAgent({
      name: 'agent-b',
      model: new GeminiWithMockResponses([]),
    });

    const router: AgentRouter = async (
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      agents: Readonly<Record<string, BaseAgent>>,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ctx: InvocationContext,
    ) => {
      return 'agent-a';
    };

    const routedAgent = new RoutedAgent({
      name: 'router',
      agents: [agentA, agentB],
      router,
    });

    const runner = await createRunner(routedAgent);
    const gen = runner.run('hi');

    let responseText = '';
    for await (const event of gen) {
      if (event.content?.role === 'model') {
        responseText += event.content.parts?.[0]?.text ?? '';
      }
    }

    expect(responseText).toBe('Hello from A');
  });

  it('should route to agent B when selected in root', async () => {
    const agentA = new LlmAgent({
      name: 'agent-a',
      model: new GeminiWithMockResponses([]),
    });
    const agentB = new LlmAgent({
      name: 'agent-b',
      model: new GeminiWithMockResponses([
        {
          candidates: [
            {content: {role: 'model', parts: [{text: 'Hello from B'}]}},
          ],
        },
      ]),
    });

    const router = async (
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      agents: Readonly<Record<string, BaseAgent>>,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ctx: InvocationContext,
    ) => {
      return 'agent-b';
    };

    const routedAgent = new RoutedAgent({
      name: 'router',
      agents: [agentA, agentB],
      router,
    });

    const runner = await createRunner(routedAgent);
    const gen = runner.run('hi');

    let responseText = '';
    for await (const event of gen) {
      if (event.content?.role === 'model') {
        responseText += event.content.parts?.[0]?.text ?? '';
      }
    }

    expect(responseText).toBe('Hello from B');
  });

  it('should work as a subagent via AgentTool', async () => {
    const leafAgent = new LlmAgent({
      name: 'leaf-agent',
      model: new GeminiWithMockResponses([
        {
          candidates: [
            {content: {role: 'model', parts: [{text: 'Response from leaf'}]}},
          ],
        },
      ]),
    });

    const router = async () => 'leaf-agent';
    const routedAgent = new RoutedAgent({
      name: 'router',
      agents: [leafAgent],
      router,
    });

    const agentTool = new AgentTool({agent: routedAgent});

    const rootAgent = new LlmAgent({
      name: 'root-agent',
      model: new GeminiWithMockResponses([
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'router',
                      args: {request: 'tell me something'},
                      id: 'mock-call-1',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{text: 'The leaf said: Response from leaf'}],
              },
            },
          ],
        },
      ]),
      tools: [agentTool],
    });

    const runner = await createRunner(rootAgent);
    const gen = runner.run('ask the router');

    let responseText = '';
    for await (const event of gen) {
      if (event.errorCode) {
        throw new Error(
          `Unexpected error event: ${event.errorCode} - ${event.errorMessage}`,
        );
      }
      if (event.content?.role === 'model') {
        responseText += event.content.parts?.[0]?.text ?? '';
      }
    }

    expect(responseText).toContain('The leaf said: Response from leaf');
  });

  it('should propagate error when router throws', async () => {
    const router = async () => {
      throw new Error('Router failed');
    };
    const routedAgent = new RoutedAgent({name: 'router', agents: [], router});
    const runner = await createRunner(routedAgent);
    const gen = runner.run('hi');
    await expect(gen.next()).rejects.toThrow('Router failed');
  });

  it('should propagate error when selected agent throws', async () => {
    class ErrorAgent extends BaseAgent {
      constructor() {
        super({name: 'error-agent'});
      }
      // eslint-disable-next-line require-yield
      protected async *runAsyncImpl() {
        throw new Error('Agent failed');
      }
      protected async *runLiveImpl() {}
    }
    const errorAgent = new ErrorAgent();
    const router = async () => 'error-agent';
    const routedAgent = new RoutedAgent({
      name: 'router',
      agents: [errorAgent],
      router,
    });
    const runner = await createRunner(routedAgent);
    const gen = runner.run('hi');
    await expect(gen.next()).rejects.toThrow('Agent failed');
  });

  it('should fail when selected agent fails (placeholder for failover)', async () => {
    class FlakyAgent extends BaseAgent {
      constructor() {
        super({name: 'flaky'});
      }
      // eslint-disable-next-line require-yield
      protected async *runAsyncImpl() {
        throw new Error('Network error');
      }
      protected async *runLiveImpl() {}
    }
    const flaky = new FlakyAgent();
    const router = async () => 'flaky';
    const routedAgent = new RoutedAgent({
      name: 'router',
      agents: [flaky],
      router,
    });
    const runner = await createRunner(routedAgent);
    const gen = runner.run('hi');
    await expect(gen.next()).rejects.toThrow('Network error');
  });
});
