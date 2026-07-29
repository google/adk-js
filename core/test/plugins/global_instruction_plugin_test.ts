/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Context,
  createSession,
  GlobalInstructionPlugin,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class MockLlm extends BaseLlm {
  lastRequest?: LlmRequest;

  constructor() {
    super({model: 'mock-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.lastRequest = request;
    yield {
      content: {parts: [{text: 'Hello from mock LLM'}]},
    };
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

describe('GlobalInstructionPlugin', () => {
  const mockSession = createSession({
    id: 'session-1',
    appName: 'test-app',
    userId: 'user-1',
    state: {user_id: 'test_user_123'},
  });

  const mockInvocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'test_agent'}),
    session: mockSession,
    pluginManager: new PluginManager(),
  });

  const mockCallbackContext = new Context({
    invocationContext: mockInvocationContext,
  });

  it('should initialize with default name "global_instruction"', () => {
    const plugin = new GlobalInstructionPlugin('instruction');
    expect(plugin.name).toBe('global_instruction');
  });

  it('should accept custom name', () => {
    const plugin = new GlobalInstructionPlugin('instruction', 'custom_name');
    expect(plugin.name).toBe('custom_name');
  });

  it('should apply string global instruction to system instruction', async () => {
    const plugin = new GlobalInstructionPlugin(
      'You are a helpful assistant with a friendly personality.',
    );
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: ''},
    };

    const result = await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest,
    });

    expect(result).toBeUndefined();
    expect(llmRequest.config?.systemInstruction).toBe(
      'You are a helpful assistant with a friendly personality.',
    );
  });

  it('should apply InstructionProvider global instruction', async () => {
    const provider = async (readonlyContext: ReadonlyContext) => {
      return `You are assistant for user ${readonlyContext.invocationContext.session.state['user_id']}.`;
    };
    const plugin = new GlobalInstructionPlugin(provider);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: ''},
    };

    const result = await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest,
    });

    expect(result).toBeUndefined();
    expect(llmRequest.config?.systemInstruction).toBe(
      'You are assistant for user test_user_123.',
    );
  });

  it('should not modify system instruction when global instruction resolves empty', async () => {
    const pluginEmpty = new GlobalInstructionPlugin('');
    const pluginProviderEmpty = new GlobalInstructionPlugin(async () => '');

    const llmRequest1: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: 'Original instruction'},
    };
    const llmRequest3: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: 'Original instruction'},
    };

    await pluginEmpty.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest: llmRequest1,
    });
    await pluginProviderEmpty.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest: llmRequest3,
    });

    expect(llmRequest1.config?.systemInstruction).toBe('Original instruction');
    expect(llmRequest3.config?.systemInstruction).toBe('Original instruction');
  });

  it('should prepend global instruction to existing string system instruction', async () => {
    const plugin = new GlobalInstructionPlugin('You are a helpful assistant.');
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: 'Existing instructions.'},
    };

    await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest,
    });

    expect(llmRequest.config?.systemInstruction).toBe(
      'You are a helpful assistant.\n\nExisting instructions.',
    );
  });

  it('should prepend global instruction to existing array system instruction', async () => {
    const plugin = new GlobalInstructionPlugin('Global instruction.');
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: ['Existing instruction.']},
    };

    await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest,
    });

    expect(llmRequest.config?.systemInstruction).toEqual([
      'Global instruction.',
      'Existing instruction.',
    ]);
  });

  it('should inject session state variables into string global instruction', async () => {
    const plugin = new GlobalInstructionPlugin(
      'Welcome back, user: {user_id}.',
    );
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: ''},
    };

    await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest,
    });

    expect(llmRequest.config?.systemInstruction).toBe(
      'Welcome back, user: test_user_123.',
    );
  });

  it('should handle undefined config and empty existing instruction array or undefined', async () => {
    const plugin = new GlobalInstructionPlugin('Global instruction.');
    const llmRequestNoConfig: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const llmRequestEmptyArray: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: [] as string[]},
    };
    const llmRequestUndefinedInstruction: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: undefined},
    };

    await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest: llmRequestNoConfig,
    });
    await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest: llmRequestEmptyArray,
    });
    await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest: llmRequestUndefinedInstruction,
    });

    expect(llmRequestNoConfig.config?.systemInstruction).toBe(
      'Global instruction.',
    );
    expect(llmRequestEmptyArray.config?.systemInstruction).toBe(
      'Global instruction.',
    );
    expect(llmRequestUndefinedInstruction.config?.systemInstruction).toBe(
      'Global instruction.',
    );
  });

  it('should prepend global instruction to an existing bare Part system instruction', async () => {
    const plugin = new GlobalInstructionPlugin('Global instruction.');
    const existingPart = {text: 'Some object instruction'};
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: existingPart},
    };

    await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest,
    });

    expect(llmRequest.config?.systemInstruction).toEqual([
      'Global instruction.',
      existingPart,
    ]);
  });

  it('should keep an existing Content system instruction a Content', async () => {
    const plugin = new GlobalInstructionPlugin('Global instruction.');
    const existingContent = {
      role: 'system',
      parts: [{text: 'Agent instruction.'}],
    };
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: existingContent},
    };

    await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest,
    });

    expect(llmRequest.config?.systemInstruction).toEqual({
      role: 'system',
      parts: [{text: 'Global instruction.'}, {text: 'Agent instruction.'}],
    });
    // The agent's own Content must not be mutated: the request config is a
    // shallow copy of it, so mutating would accumulate on every invocation.
    expect(existingContent.parts).toEqual([{text: 'Agent instruction.'}]);
  });

  it('should not accumulate the global instruction across repeated invocations', async () => {
    const plugin = new GlobalInstructionPlugin('Global instruction.');
    const agentContent = {
      role: 'system',
      parts: [{text: 'Agent instruction.'}],
    };

    for (let i = 0; i < 3; i++) {
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
        // Mirrors basic_llm_request_processor: a shallow copy that shares the
        // agent's Content object.
        config: {systemInstruction: agentContent},
      };
      await plugin.beforeModelCallback({
        callbackContext: mockCallbackContext,
        llmRequest,
      });
      expect(llmRequest.config?.systemInstruction).toEqual({
        role: 'system',
        parts: [{text: 'Global instruction.'}, {text: 'Agent instruction.'}],
      });
    }
  });

  it('should inject system instruction in an end-to-end InMemoryRunner simulation', async () => {
    const mockLlm = new MockLlm();
    const agent = new LlmAgent({
      name: 'test_agent',
      model: mockLlm,
      instruction: 'Agent specific instruction.',
    });
    const plugin = new GlobalInstructionPlugin(
      'Global application instruction.',
    );
    const runner = new InMemoryRunner({
      agent,
      plugins: [plugin],
    });

    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'test_user',
    });

    const events: unknown[] = [];
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Hi'}]},
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(mockLlm.lastRequest).toBeDefined();
    expect(mockLlm.lastRequest?.config?.systemInstruction).toBe(
      'Global application instruction.\n\nYou are an agent. Your internal name is "test_agent".\n\nAgent specific instruction.',
    );
  });
});
