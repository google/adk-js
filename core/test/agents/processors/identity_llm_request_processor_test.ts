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
import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {IDENTITY_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/identity_llm_request_processor.js';

/** Forces `disallowTransferToParent` and `disallowTransferToPeers` to true. */
const OUTPUT_SCHEMA: Schema = {type: Type.OBJECT};

const SHARED_INSTRUCTION = 'Shared instruction.';

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

  it('omits the preamble when both transfer directions are disabled', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('omits the preamble for an agent whose outputSchema disables transfer', async () => {
    const agent = new LlmAgent({
      name: 'child_one',
      model: 'gemini-2.5-flash',
      outputSchema: OUTPUT_SCHEMA,
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('gives fan-out siblings an identical system prompt', async () => {
    const requests = ['child_one', 'child_two'].map((name) => {
      const agent = new LlmAgent({
        name,
        model: 'gemini-2.5-flash',
        instruction: SHARED_INSTRUCTION,
        outputSchema: OUTPUT_SCHEMA,
      });
      const llmRequest = makeLlmRequest();
      llmRequest.config = {systemInstruction: SHARED_INSTRUCTION};
      return {
        invocationContext: createMockInvocationContext(agent),
        llmRequest,
      };
    });

    for (const {invocationContext, llmRequest} of requests) {
      await runProcessor(invocationContext, llmRequest);
    }

    expect(requests[0].llmRequest.config?.systemInstruction).toBe(
      SHARED_INSTRUCTION,
    );
    expect(requests[0].llmRequest.config?.systemInstruction).toBe(
      requests[1].llmRequest.config?.systemInstruction,
    );
  });

  it('keeps the preamble when only transfer to the parent is disabled', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: true,
      disallowTransferToPeers: false,
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(
      'Your internal name is "my_agent"',
    );
  });

  it('keeps the preamble when only transfer to peers is disabled', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: false,
      disallowTransferToPeers: true,
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(
      'Your internal name is "my_agent"',
    );
  });

  it('keeps the preamble when transfer is disabled but the agent has sub-agents', async () => {
    const agent = new LlmAgent({
      name: 'my_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
      subAgents: [new LlmAgent({name: 'leaf', model: 'gemini-2.5-flash'})],
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(
      'Your internal name is "my_agent"',
    );
  });
});
