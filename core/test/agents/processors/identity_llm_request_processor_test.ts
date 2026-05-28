/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {IDENTITY_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/identity_llm_request_processor.js';

class MockRootAgent extends BaseAgent {
  constructor(name: string, subAgents: BaseAgent[] = []) {
    super({name, subAgents});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

function createMockInvocationContext(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function makeLlmRequest(): LlmRequest {
  return {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

async function runProcessor(
  invocationContext: InvocationContext,
  llmRequest: LlmRequest,
) {
  for await (const _ of IDENTITY_LLM_REQUEST_PROCESSOR.runAsync(
    invocationContext,
    llmRequest,
  )) {
    // intentionally empty
  }
}

describe('IdentityLlmRequestProcessor', () => {
  it('should append agent name to system instruction', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(
      'Your internal name is "my_agent"',
    );
  });

  it('should append agent description when present', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
      description: 'A helpful agent',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(
      'The description about you is "A helpful agent"',
    );
  });

  it('should not append description when not provided', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).not.toContain(
      'The description about you is',
    );
  });

  it('should work for non-LlmAgent (BaseAgent subclass)', async () => {
    const agent = new MockRootAgent('base_agent');
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(
      'Your internal name is "base_agent"',
    );
  });

  it('should yield no events', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    const events = [];
    for await (const event of IDENTITY_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
  });

  it('should include both name and description in instruction', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
      description: 'Processes data',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    const instruction = llmRequest.config?.systemInstruction as string;
    expect(instruction).toContain('my_agent');
    expect(instruction).toContain('Processes data');
  });
});
