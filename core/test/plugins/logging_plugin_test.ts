/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseTool,
  Context,
  createEvent,
  Event,
  InvocationContext,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {Content} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {LoggingPlugin} from '../../src/plugins/logging_plugin.js';
import {resetLogger, setLogger} from '../../src/utils/logger.js';

function makeMockLogger() {
  const infoCalls: string[] = [];
  const mockLogger = {
    setLogLevel: () => {},
    log: () => {},
    debug: () => {},
    info: (...args: unknown[]) => {
      infoCalls.push(args.map((a) => String(a)).join(' '));
    },
    warn: () => {},
    error: () => {},
  };
  return {mockLogger, infoCalls};
}

describe('LoggingPlugin', () => {
  const mockAgent = {name: 'test_agent'} as BaseAgent;
  const mockSession = {
    id: 'session-1',
    state: new Map(),
  } as unknown as InvocationContext['session'];
  const mockInvocationContext = {
    invocationId: 'inv-1',
    session: mockSession,
    userId: 'user-1',
    appName: 'test-app',
    agent: mockAgent,
    branch: undefined,
  } as unknown as InvocationContext;

  const mockCallbackContext = {
    agentName: 'test_agent',
    invocationId: 'inv-1',
    invocationContext: mockInvocationContext,
  } as unknown as Context;

  const mockTool = {name: 'my_tool'} as BaseTool;
  const mockToolContext = {
    agentName: 'test_agent',
    functionCallId: 'fc-1',
  } as unknown as Context;

  const mockLlmRequest = {
    model: 'gemini-2.0-flash',
  } as LlmRequest;

  const mockLlmResponse = {
    content: {parts: [{text: 'response text'}]},
  } as LlmResponse;

  const mockEvent: Event = createEvent({
    id: 'event-1',
    author: 'test_agent',
    content: {role: 'model', parts: [{text: 'hello'}]},
  });

  let infoCalls: string[];

  beforeEach(() => {
    const {mockLogger, infoCalls: calls} = makeMockLogger();
    infoCalls = calls;
    setLogger(mockLogger);
  });

  afterEach(() => {
    resetLogger();
  });

  it('should initialize with default name "logging_plugin"', () => {
    const plugin = new LoggingPlugin();
    expect(plugin.name).toBe('logging_plugin');
  });

  it('should accept custom name', () => {
    const plugin = new LoggingPlugin('custom_name');
    expect(plugin.name).toBe('custom_name');
  });

  it('onUserMessageCallback should log and return undefined', async () => {
    const plugin = new LoggingPlugin();
    const userMessage: Content = {parts: [{text: 'hello world'}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage,
    });

    expect(result).toBeUndefined();
    expect(infoCalls.some((m) => m.includes('USER MESSAGE RECEIVED'))).toBe(
      true,
    );
    expect(infoCalls.some((m) => m.includes('inv-1'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('session-1'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('user-1'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('test-app'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('hello world'))).toBe(true);
  });

  it('onUserMessageCallback should log branch when present', async () => {
    const plugin = new LoggingPlugin();
    const ctxWithBranch = {
      ...mockInvocationContext,
      branch: 'my-branch',
    } as unknown as InvocationContext;

    await plugin.onUserMessageCallback({
      invocationContext: ctxWithBranch,
      userMessage: {parts: [{text: 'msg'}]},
    });

    expect(infoCalls.some((m) => m.includes('my-branch'))).toBe(true);
  });

  it('beforeRunCallback should log and return undefined', async () => {
    const plugin = new LoggingPlugin();

    const result = await plugin.beforeRunCallback({
      invocationContext: mockInvocationContext,
    });

    expect(result).toBeUndefined();
    expect(infoCalls.some((m) => m.includes('INVOCATION STARTING'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('inv-1'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('test_agent'))).toBe(true);
  });

  it('onEventCallback should log event info and return undefined', async () => {
    const plugin = new LoggingPlugin();

    const result = await plugin.onEventCallback({
      invocationContext: mockInvocationContext,
      event: mockEvent,
    });

    expect(result).toBeUndefined();
    expect(infoCalls.some((m) => m.includes('EVENT YIELDED'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('test_agent'))).toBe(true);
  });

  it('onEventCallback should log function calls when present', async () => {
    const plugin = new LoggingPlugin();
    const eventWithFuncCall = createEvent({
      author: 'model',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'my_func', args: {}}}],
      },
    });

    await plugin.onEventCallback({
      invocationContext: mockInvocationContext,
      event: eventWithFuncCall,
    });

    expect(infoCalls.some((m) => m.includes('my_func'))).toBe(true);
  });

  it('onEventCallback should log function responses when present', async () => {
    const plugin = new LoggingPlugin();
    const eventWithFuncResp = createEvent({
      author: 'tool',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'my_func',
              response: {result: 'ok'},
            },
          },
        ],
      },
    });

    await plugin.onEventCallback({
      invocationContext: mockInvocationContext,
      event: eventWithFuncResp,
    });

    expect(infoCalls.some((m) => m.includes('my_func'))).toBe(true);
  });

  it('onEventCallback should log long running tool ids when present', async () => {
    const plugin = new LoggingPlugin();
    const eventWithLongRunning: Event = createEvent({
      author: 'model',
      content: {role: 'model', parts: [{text: 'running'}]},
      longRunningToolIds: ['tool-123'],
    });

    await plugin.onEventCallback({
      invocationContext: mockInvocationContext,
      event: eventWithLongRunning,
    });

    expect(infoCalls.some((m) => m.includes('tool-123'))).toBe(true);
  });

  it('afterRunCallback should log and return undefined', async () => {
    const plugin = new LoggingPlugin();

    const result = await plugin.afterRunCallback({
      invocationContext: mockInvocationContext,
    });

    expect(result).toBeUndefined();
    expect(infoCalls.some((m) => m.includes('INVOCATION COMPLETED'))).toBe(
      true,
    );
    expect(infoCalls.some((m) => m.includes('inv-1'))).toBe(true);
  });

  it('beforeAgentCallback should log and return undefined', async () => {
    const plugin = new LoggingPlugin();

    const result = await plugin.beforeAgentCallback({
      agent: mockAgent,
      callbackContext: mockCallbackContext,
    });

    expect(result).toBeUndefined();
    expect(infoCalls.some((m) => m.includes('AGENT STARTING'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('test_agent'))).toBe(true);
  });

  it('beforeAgentCallback should log branch when present', async () => {
    const plugin = new LoggingPlugin();
    const ctxWithBranch = {
      ...mockCallbackContext,
      invocationContext: {...mockInvocationContext, branch: 'agent-branch'},
    } as unknown as Context;

    await plugin.beforeAgentCallback({
      agent: mockAgent,
      callbackContext: ctxWithBranch,
    });

    expect(infoCalls.some((m) => m.includes('agent-branch'))).toBe(true);
  });

  it('afterAgentCallback should log and return undefined', async () => {
    const plugin = new LoggingPlugin();

    const result = await plugin.afterAgentCallback({
      agent: mockAgent,
      callbackContext: mockCallbackContext,
    });

    expect(result).toBeUndefined();
    expect(infoCalls.some((m) => m.includes('AGENT COMPLETED'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('test_agent'))).toBe(true);
  });

  it('beforeModelCallback should log and return undefined', async () => {
    const plugin = new LoggingPlugin();

    const result = await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest: mockLlmRequest,
    });

    expect(result).toBeUndefined();
    expect(infoCalls.some((m) => m.includes('LLM REQUEST'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('gemini-2.0-flash'))).toBe(true);
  });

  it('beforeModelCallback should log system instruction when present', async () => {
    const plugin = new LoggingPlugin();
    const reqWithInstruction: LlmRequest = {
      ...mockLlmRequest,
      config: {systemInstruction: 'You are a helpful assistant.'},
    };

    await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest: reqWithInstruction,
    });

    expect(
      infoCalls.some((m) => m.includes('You are a helpful assistant.')),
    ).toBe(true);
  });

  it('beforeModelCallback should truncate long system instruction', async () => {
    const plugin = new LoggingPlugin();
    const longInstruction = 'A'.repeat(300);
    const reqWithLongInstruction: LlmRequest = {
      ...mockLlmRequest,
      config: {systemInstruction: longInstruction},
    };

    await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest: reqWithLongInstruction,
    });

    expect(infoCalls.some((m) => m.includes('...'))).toBe(true);
  });

  it('beforeModelCallback should log available tools when present', async () => {
    const plugin = new LoggingPlugin();
    const reqWithTools: LlmRequest = {
      ...mockLlmRequest,
      toolsDict: {my_tool: mockTool},
    };

    await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest: reqWithTools,
    });

    expect(infoCalls.some((m) => m.includes('my_tool'))).toBe(true);
  });

  it('afterModelCallback should log and return undefined', async () => {
    const plugin = new LoggingPlugin();

    const result = await plugin.afterModelCallback({
      callbackContext: mockCallbackContext,
      llmResponse: mockLlmResponse,
    });

    expect(result).toBeUndefined();
    expect(infoCalls.some((m) => m.includes('LLM RESPONSE'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('response text'))).toBe(true);
  });

  it('afterModelCallback should log error when errorCode is present', async () => {
    const plugin = new LoggingPlugin();
    const errorResponse: LlmResponse = {
      errorCode: '500',
      errorMessage: 'Internal server error',
    };

    await plugin.afterModelCallback({
      callbackContext: mockCallbackContext,
      llmResponse: errorResponse,
    });

    expect(infoCalls.some((m) => m.includes('ERROR'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('500'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('Internal server error'))).toBe(
      true,
    );
  });

  it('afterModelCallback should log partial and turnComplete flags', async () => {
    const plugin = new LoggingPlugin();
    const partialResponse: LlmResponse = {
      content: {parts: [{text: 'partial'}]},
      partial: true,
      turnComplete: false,
    };

    await plugin.afterModelCallback({
      callbackContext: mockCallbackContext,
      llmResponse: partialResponse,
    });

    expect(infoCalls.some((m) => m.includes('Partial'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('Turn Complete'))).toBe(true);
  });

  it('afterModelCallback should log usage metadata when present', async () => {
    const plugin = new LoggingPlugin();
    const responseWithUsage: LlmResponse = {
      content: {parts: [{text: 'hello'}]},
      usageMetadata: {promptTokenCount: 10, candidatesTokenCount: 20},
    };

    await plugin.afterModelCallback({
      callbackContext: mockCallbackContext,
      llmResponse: responseWithUsage,
    });

    expect(infoCalls.some((m) => m.includes('Token Usage'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('10'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('20'))).toBe(true);
  });

  it('beforeToolCallback should log and return undefined', async () => {
    const plugin = new LoggingPlugin();

    const result = await plugin.beforeToolCallback({
      tool: mockTool,
      toolArgs: {query: 'test'},
      toolContext: mockToolContext,
    });

    expect(result).toBeUndefined();
    expect(infoCalls.some((m) => m.includes('TOOL STARTING'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('my_tool'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('fc-1'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('query'))).toBe(true);
  });

  it('afterToolCallback should log and return undefined', async () => {
    const plugin = new LoggingPlugin();

    const result = await plugin.afterToolCallback({
      tool: mockTool,
      toolArgs: {},
      toolContext: mockToolContext,
      result: {output: 'some result'},
    });

    expect(result).toBeUndefined();
    expect(infoCalls.some((m) => m.includes('TOOL COMPLETED'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('my_tool'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('some result'))).toBe(true);
  });

  it('onModelErrorCallback should log and return undefined', async () => {
    const plugin = new LoggingPlugin();
    const error = new Error('model failure');

    const result = await plugin.onModelErrorCallback({
      callbackContext: mockCallbackContext,
      llmRequest: mockLlmRequest,
      error,
    });

    expect(result).toBeUndefined();
    expect(infoCalls.some((m) => m.includes('LLM ERROR'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('model failure'))).toBe(true);
  });

  it('onToolErrorCallback should log and return undefined', async () => {
    const plugin = new LoggingPlugin();
    const error = new Error('tool failure');

    const result = await plugin.onToolErrorCallback({
      tool: mockTool,
      toolArgs: {key: 'val'},
      toolContext: mockToolContext,
      error,
    });

    expect(result).toBeUndefined();
    expect(infoCalls.some((m) => m.includes('TOOL ERROR'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('my_tool'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('tool failure'))).toBe(true);
  });

  it('should format content with no parts as "None"', async () => {
    const plugin = new LoggingPlugin();

    await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage: {} as Content,
    });

    expect(infoCalls.some((m) => m.includes('None'))).toBe(true);
  });

  it('should format content with functionCall part', async () => {
    const plugin = new LoggingPlugin();
    const eventWithFuncCall = createEvent({
      author: 'model',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'search_tool', args: {}}}],
      },
    });

    await plugin.onEventCallback({
      invocationContext: mockInvocationContext,
      event: eventWithFuncCall,
    });

    expect(
      infoCalls.some((m) => m.includes('function_call: search_tool')),
    ).toBe(true);
  });

  it('should format content with functionResponse part', async () => {
    const plugin = new LoggingPlugin();
    const eventWithFuncResp = createEvent({
      author: 'tool',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'search_tool',
              response: {result: 'found'},
            },
          },
        ],
      },
    });

    await plugin.onEventCallback({
      invocationContext: mockInvocationContext,
      event: eventWithFuncResp,
    });

    expect(
      infoCalls.some((m) => m.includes('function_response: search_tool')),
    ).toBe(true);
  });

  it('should truncate long text content', async () => {
    const plugin = new LoggingPlugin();
    const longText = 'B'.repeat(300);

    await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage: {parts: [{text: longText}]},
    });

    expect(infoCalls.some((m) => m.includes('...'))).toBe(true);
  });
});
