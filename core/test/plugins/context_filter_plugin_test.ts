/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {Context} from '../../src/agents/context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {
  ContextFilterPlugin,
  isContextFilterPlugin,
} from '../../src/plugins/context_filter_plugin.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {InMemoryRunner} from '../../src/runner/in_memory_runner.js';

class MockLlm extends BaseLlm {
  lastRequest?: LlmRequest;

  constructor() {
    super({model: 'mock-llm'});
  }

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.lastRequest = request;
    yield {
      content: {role: 'model', parts: [{text: 'Hello from mock LLM'}]},
    };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

function createContent(role: string, text: string): Content {
  return {
    role,
    parts: [{text}],
  };
}

function createFunctionCallContent(name: string, callId: string): Content {
  return {
    role: 'model',
    parts: [
      {
        functionCall: {
          id: callId,
          name,
          args: {},
        },
      },
    ],
  };
}

function createFunctionResponseContent(name: string, callId: string): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: callId,
          name,
          response: {result: 'ok'},
        },
      },
    ],
  };
}

function createMockContext(): Context {
  return {
    invocationId: 'inv-test',
    agentName: 'test_agent',
    state: {
      get: () => undefined,
      set: () => {},
    },
  } as unknown as Context;
}

function createMockLlmRequest(contents: Content[]): LlmRequest {
  return {
    contents,
    toolsDict: {},
    liveConnectConfig: {},
  };
}

describe('ContextFilterPlugin', () => {
  it('should not perform filtering when no options are provided', async () => {
    const plugin = new ContextFilterPlugin();
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
    ];
    const llmRequest = createMockLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents).toEqual(contents);
    expect(llmRequest.contents.length).toBe(2);
  });

  it('should truncate context to the last N invocations', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ];
    const llmRequest = createMockLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents.length).toBe(2);
    expect(llmRequest.contents[0].parts?.[0]?.text).toBe('user_prompt_2');
    expect(llmRequest.contents[1].parts?.[0]?.text).toBe('model_response_2');
  });

  it('should apply a custom synchronous filter function', async () => {
    const removeModelResponses = (items: Content[]) =>
      items.filter((c) => c.role !== 'model');

    const plugin = new ContextFilterPlugin({
      customFilter: removeModelResponses,
    });
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ];
    const llmRequest = createMockLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents.length).toBe(2);
    expect(llmRequest.contents.every((c) => c.role === 'user')).toBe(true);
  });

  it('should apply an asynchronous custom filter function', async () => {
    const asyncFilter = async (items: Content[]) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return items.filter((c) => c.parts?.[0]?.text?.includes('2'));
    };

    const plugin = new ContextFilterPlugin({customFilter: asyncFilter});
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ];
    const llmRequest = createMockLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents.length).toBe(2);
    expect(llmRequest.contents[0].parts?.[0]?.text).toBe('user_prompt_2');
    expect(llmRequest.contents[1].parts?.[0]?.text).toBe('model_response_2');
  });

  it('should apply both custom filter and last N invocations filtering', async () => {
    const removeFirstItem = (items: Content[]) => items.slice(1);

    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 1,
      customFilter: removeFirstItem,
    });
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      createContent('model', 'model_response_3'),
    ];
    const llmRequest = createMockLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createMockContext(),
      llmRequest,
    });

    // Keeping last 1 invocation leaves prompt_3 and response_3 (2 items),
    // and customFilter removes the first item, leaving 1 item (response_3).
    expect(llmRequest.contents.length).toBe(1);
    expect(llmRequest.contents[0].parts?.[0]?.text).toBe('model_response_3');
  });

  it('should handle invocations with multiple consecutive user turns', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2a'),
      createContent('user', 'user_prompt_2b'),
      createContent('model', 'model_response_2'),
    ];
    const llmRequest = createMockLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents.length).toBe(3);
    expect(llmRequest.contents[0].parts?.[0]?.text).toBe('user_prompt_2a');
    expect(llmRequest.contents[1].parts?.[0]?.text).toBe('user_prompt_2b');
    expect(llmRequest.contents[2].parts?.[0]?.text).toBe('model_response_2');
  });

  it('should not filter when total invocations are below keep + remove threshold', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 3});
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ];
    const llmRequest = createMockLlmRequest(contents);
    const originalContents = [...llmRequest.contents];

    await plugin.beforeModelCallback({
      callbackContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents).toEqual(originalContents);
  });

  it('should gracefully handle exceptions in custom filter without altering context', async () => {
    const faultyFilter = () => {
      throw new Error('Custom filter boom');
    };

    const plugin = new ContextFilterPlugin({customFilter: faultyFilter});
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
    ];
    const llmRequest = createMockLlmRequest(contents);
    const originalContents = [...llmRequest.contents];

    await plugin.beforeModelCallback({
      callbackContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents).toEqual(originalContents);
  });

  it('should preserve function_call and function_response pairs to avoid orphaned responses', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 2});

    const contents = [
      createContent('user', 'Hello'),
      createContent('model', 'Hi there!'),
      createContent('user', 'I want to know about X'),
      createFunctionCallContent('knowledge_base', 'call_1'),
      createFunctionResponseContent('knowledge_base', 'call_1'),
      createContent('model', 'I found some information...'),
      createContent('user', 'can you explain more about Y'),
      createFunctionCallContent('knowledge_base', 'call_2'),
      createFunctionResponseContent('knowledge_base', 'call_2'),
    ];
    const llmRequest = createMockLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createMockContext(),
      llmRequest,
    });

    const callIdsPresent = new Set<string>();
    const responseIdsPresent = new Set<string>();

    for (const content of llmRequest.contents) {
      if (content.parts) {
        for (const part of content.parts) {
          if (part.functionCall?.id) {
            callIdsPresent.add(part.functionCall.id);
          }
          if (part.functionResponse?.id) {
            responseIdsPresent.add(part.functionResponse.id);
          }
        }
      }
    }

    // Every function response MUST have a matching function call present in the contents
    for (const responseId of responseIdsPresent) {
      expect(callIdsPresent.has(responseId)).toBe(true);
    }
  });

  it('should handle nested and multiple tool calls without orphaned responses', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});

    const contents = [
      createContent('user', 'Hello'),
      createContent('model', 'Hi!'),
      createContent('user', 'Do task'),
      createFunctionCallContent('tool_a', 'call_a'),
      createFunctionResponseContent('tool_a', 'call_a'),
      createFunctionCallContent('tool_b', 'call_b'),
      createFunctionResponseContent('tool_b', 'call_b'),
      createContent('model', 'Done with tasks'),
    ];
    const llmRequest = createMockLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createMockContext(),
      llmRequest,
    });

    const callIds = new Set<string>();
    const responseIds = new Set<string>();
    const texts: string[] = [];

    for (const content of llmRequest.contents) {
      if (content.parts) {
        for (const part of content.parts) {
          if (part.functionCall?.id) callIds.add(part.functionCall.id);
          if (part.functionResponse?.id)
            responseIds.add(part.functionResponse.id);
          if (part.text) texts.push(part.text);
        }
      }
    }

    expect(texts).toContain('Do task');
    expect(texts).toContain('Done with tasks');
    expect(texts).not.toContain('Hello');
    expect(texts).not.toContain('Hi!');

    for (const responseId of responseIds) {
      expect(callIds.has(responseId)).toBe(true);
    }
  });

  it('should keep initial user prompt in multi-turn tool invocation', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});

    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createFunctionCallContent('get_weather', 'call_1'),
      createFunctionResponseContent('get_weather', 'call_1'),
      createContent('model', 'final_answer_2'),
    ];
    const llmRequest = createMockLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createMockContext(),
      llmRequest,
    });

    const texts = llmRequest.contents.flatMap(
      (c) =>
        c.parts?.map((p) => p.text).filter((t): t is string => Boolean(t)) ??
        [],
    );

    expect(texts).toContain('user_prompt_2');
    expect(texts).toContain('final_answer_2');
    expect(texts).not.toContain('user_prompt_1');
  });

  it('should support removeAmount correctly', async () => {
    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 2,
      removeAmount: 1,
    });
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      createContent('model', 'model_response_3'),
    ];
    const llmRequest = createMockLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents.length).toBe(4);
    expect(llmRequest.contents[0].parts?.[0]?.text).toBe('user_prompt_2');
    expect(llmRequest.contents[3].parts?.[0]?.text).toBe('model_response_3');
  });

  it('should support higher removeAmount', async () => {
    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 3,
      removeAmount: 2,
    });
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      createContent('model', 'model_response_3'),
      createContent('user', 'user_prompt_4'),
      createContent('model', 'model_response_4'),
      createContent('user', 'user_prompt_5'),
      createContent('model', 'model_response_5'),
    ];
    const llmRequest = createMockLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createMockContext(),
      llmRequest,
    });

    // Keeps last 3 invocations
    expect(llmRequest.contents.length).toBe(6);
    expect(llmRequest.contents[0].parts?.[0]?.text).toBe('user_prompt_3');
    expect(llmRequest.contents[5].parts?.[0]?.text).toBe('model_response_5');
  });

  it('should throw an error when removeAmount is less than 1', () => {
    expect(() => {
      new ContextFilterPlugin({numInvocationsToKeep: 1, removeAmount: 0});
    }).toThrow('removeAmount must be at least 1');

    expect(() => {
      new ContextFilterPlugin({numInvocationsToKeep: 1, removeAmount: -1});
    }).toThrow('removeAmount must be at least 1');
  });

  it('should support positional constructor parameters', async () => {
    const plugin = new ContextFilterPlugin(
      1,
      (contents) => contents.filter((c) => c.role === 'model'),
      'custom_named_filter',
      1,
    );

    expect(plugin.name).toBe('custom_named_filter');
    expect(plugin.numInvocationsToKeep).toBe(1);
    expect(plugin.removeAmount).toBe(1);

    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ];
    const llmRequest = createMockLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents.length).toBe(1);
    expect(llmRequest.contents[0].parts?.[0]?.text).toBe('model_response_2');
  });

  it('should support isContextFilterPlugin brand-symbol guard', () => {
    const plugin = new ContextFilterPlugin();
    expect(isContextFilterPlugin(plugin)).toBe(true);
    expect(isContextFilterPlugin({})).toBe(false);
    expect(isContextFilterPlugin(null)).toBe(false);
    expect(isContextFilterPlugin(undefined)).toBe(false);
    expect(
      isContextFilterPlugin({
        [Symbol.for('google.adk.contextFilterPlugin')]: true,
      }),
    ).toBe(true);
    expect(
      isContextFilterPlugin({
        [Symbol.for('google.adk.contextFilterPlugin')]: false,
      }),
    ).toBe(false);
  });

  it('should work seamlessly when registered in PluginManager', async () => {
    const pluginManager = new PluginManager();
    const filterPlugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    pluginManager.registerPlugin(filterPlugin);

    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ];
    const llmRequest = createMockLlmRequest(contents);

    await pluginManager.runBeforeModelCallback({
      callbackContext: createMockContext(),
      llmRequest,
    });

    expect(llmRequest.contents.length).toBe(2);
    expect(llmRequest.contents[0].parts?.[0]?.text).toBe('user_prompt_2');
    expect(llmRequest.contents[1].parts?.[0]?.text).toBe('model_response_2');
  });

  it('should filter context in an end-to-end InMemoryRunner simulation across multiple turns', async () => {
    const mockLlm = new MockLlm();
    const agent = new LlmAgent({
      name: 'test_agent',
      model: mockLlm,
      instruction: 'Test agent',
    });
    const filterPlugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const runner = new InMemoryRunner({
      agent,
      plugins: [filterPlugin],
    });

    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'user-1',
    });

    // Turn 1
    for await (const _ of runner.runAsync({
      userId: 'user-1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Message 1'}]},
    })) {
      // consume generator
    }

    // Turn 2
    for await (const _ of runner.runAsync({
      userId: 'user-1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Message 2'}]},
    })) {
      // consume generator
    }

    // In Turn 2, with numInvocationsToKeep = 1, only Message 2 should be sent to the model (Message 1 trimmed)
    expect(mockLlm.lastRequest).toBeDefined();
    const texts = mockLlm.lastRequest?.contents.flatMap(
      (c) =>
        c.parts?.map((p) => p.text).filter((t): t is string => Boolean(t)) ??
        [],
    );
    expect(texts).toContain('Message 2');
    expect(texts).not.toContain('Message 1');
  });

  it('should sanitize PII with customFilter in an end-to-end InMemoryRunner simulation', async () => {
    const mockLlm = new MockLlm();
    const agent = new LlmAgent({
      name: 'test_agent',
      model: mockLlm,
      instruction: 'Test agent',
    });
    const piiRedactorPlugin = new ContextFilterPlugin({
      customFilter: (contents) =>
        contents.map((c) => ({
          ...c,
          parts: c.parts?.map((p) => ({
            ...p,
            text: p.text
              ? p.text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]')
              : p.text,
          })),
        })),
    });
    const runner = new InMemoryRunner({
      agent,
      plugins: [piiRedactorPlugin],
    });

    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'user-1',
    });

    for await (const _ of runner.runAsync({
      userId: 'user-1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'My SSN is 123-45-6789'}]},
    })) {
      // consume generator
    }

    expect(mockLlm.lastRequest).toBeDefined();
    const promptText = mockLlm.lastRequest?.contents[0]?.parts?.[0]?.text;
    expect(promptText).toBe('My SSN is [REDACTED_SSN]');
    expect(promptText).not.toContain('123-45-6789');
  });
});
