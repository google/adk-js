/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseAgent,
  BaseLlm,
  type BaseLlmConnection,
  BaseTool,
  Context,
  createEvent,
  type CreateEventParams,
  Event,
  FunctionTool,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LoggingPlugin,
  type LoggingPluginOptions,
  ReflectAndRetryToolPlugin,
  toolResultClassification,
  type ToolResultClassification,
  type ToolResultClassifier,
} from '@google/adk';
import {Content, FinishReason} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {resetLogger, setLogger} from '../../src/utils/logger.js';

function makeMockLogger() {
  const infoCalls: string[] = [];
  const warnCalls: string[] = [];
  const mockLogger = {
    setLogLevel: () => {},
    log: () => {},
    debug: () => {},
    info: (...args: unknown[]) => {
      infoCalls.push(args.map((a) => String(a)).join(' '));
    },
    warn: (...args: unknown[]) => {
      warnCalls.push(args.map((a) => String(a)).join(' '));
    },
    error: () => {},
  };
  return {mockLogger, infoCalls, warnCalls};
}

class ScriptedLlm extends BaseLlm {
  private index = 0;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'scripted'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield this.responses[this.index++] ?? {
      content: {role: 'model', parts: [{text: 'done'}]},
    };
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not used in this test.');
  }
}

const MCP_ERROR_RESULT: Record<string, unknown> = {
  content: [{type: 'text', text: 'permission denied'}],
  isError: true,
};

function makeNodeEvent(
  fields: CreateEventParams & {messageAsOutput?: boolean} = {},
): Event {
  const {messageAsOutput, ...rest} = fields;
  return createEvent({
    author: 'step',
    nodeInfo: {path: 'wf@1/step@2', messageAsOutput},
    ...rest,
  });
}

async function createRetryAnswer(
  tool: BaseTool,
  toolContext: Context,
  error: Error,
): Promise<Record<string, unknown>> {
  const response = await new ReflectAndRetryToolPlugin({
    maxRetries: 3,
  }).onToolErrorCallback({
    tool,
    toolArgs: {},
    toolContext,
    error,
  });
  return response ?? {};
}

const classifyStatusField: ToolResultClassifier = ({result}) => {
  if (
    typeof result === 'object' &&
    result !== null &&
    'status' in result &&
    result.status === 'ERROR'
  ) {
    const reason =
      'reason' in result && typeof result.reason === 'string'
        ? result.reason
        : null;
    return toolResultClassification({status: 'ERROR', errorMessage: reason});
  }
  return null;
};

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
    invocationId: 'inv-1',
    functionCallId: 'fc-1',
    state: {
      get: () => undefined,
      set: () => {},
    },
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
  let warnCalls: string[];

  beforeEach(() => {
    const {
      mockLogger,
      infoCalls: calls,
      warnCalls: warnings,
    } = makeMockLogger();
    infoCalls = calls;
    warnCalls = warnings;
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

  it('should accept LoggingPluginOptions object', () => {
    const options: LoggingPluginOptions = {
      name: 'options-name',
      toolResultClassifier: classifyStatusField,
    };
    const plugin = new LoggingPlugin(options);
    expect(plugin.name).toBe('options-name');
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
    const longInstruction = 'a'.repeat(200) + 'Z'.repeat(50);
    const reqWithLongInstruction: LlmRequest = {
      ...mockLlmRequest,
      config: {systemInstruction: longInstruction},
    };

    await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest: reqWithLongInstruction,
    });

    const out = infoCalls.join('\n');
    expect(out).toContain(`System Instruction: '${'a'.repeat(200)}...'`);
    expect(out).not.toContain('Z');
  });

  it('beforeModelCallback keeps system instruction at 200-character budget', async () => {
    const plugin = new LoggingPlugin();
    const exactInstruction = 'a'.repeat(200);
    const reqWithExactInstruction: LlmRequest = {
      ...mockLlmRequest,
      config: {systemInstruction: exactInstruction},
    };

    await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest: reqWithExactInstruction,
    });

    expect(infoCalls.join('\n')).toContain(
      `System Instruction: '${exactInstruction}'`,
    );
  });

  it('beforeModelCallback formats Content system instruction', async () => {
    const plugin = new LoggingPlugin();
    const reqWithContentInstruction: LlmRequest = {
      ...mockLlmRequest,
      config: {
        systemInstruction: {
          role: 'system',
          parts: [{text: 'Stay concise.'}],
        },
      },
    };

    const result = await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest: reqWithContentInstruction,
    });

    expect(result).toBeUndefined();
    expect(infoCalls.join('\n')).toContain('Stay concise.');
  });

  it('beforeModelCallback formats array system instruction', async () => {
    const plugin = new LoggingPlugin();
    const reqWithArrayInstruction: LlmRequest = {
      ...mockLlmRequest,
      config: {
        systemInstruction: [{text: 'Stay concise.'}, {text: 'Cite sources.'}],
      },
    };

    const result = await plugin.beforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest: reqWithArrayInstruction,
    });

    expect(result).toBeUndefined();
    const out = infoCalls.join('\n');
    expect(out).toContain('Stay concise.');
    expect(out).toContain('Cite sources.');
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
      content: {parts: [{text: 'unreachable-text'}]},
      errorCode: '500',
      errorMessage: 'Internal server error',
    };

    await plugin.afterModelCallback({
      callbackContext: mockCallbackContext,
      llmResponse: errorResponse,
    });

    const out = infoCalls.join('\n');
    expect(out).toContain('ERROR - Code: 500');
    expect(out).toContain('Error Message: Internal server error');
    expect(out).not.toContain('unreachable-text');
    expect(out).not.toContain('Content:');
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

  it('afterModelCallback logs finish reason on final response', async () => {
    const plugin = new LoggingPlugin();
    const responseWithFinishReason: LlmResponse = {
      content: {parts: [{text: 'hello'}]},
      finishReason: FinishReason.STOP,
    };

    await plugin.afterModelCallback({
      callbackContext: mockCallbackContext,
      llmResponse: responseWithFinishReason,
    });

    const out = infoCalls.join('\n');
    expect(out).toContain('Finish Reason: STOP');
    expect(out).not.toContain('FinishReason.');
  });

  it('afterModelCallback logs termination of a stream once on the final response', async () => {
    const plugin = new LoggingPlugin();
    const chunk: LlmResponse = {
      content: {parts: [{text: 'partial-text'}]},
      partial: true,
      errorCode: 'MAX_TOKENS',
      errorMessage: 'cut off',
      finishReason: FinishReason.MAX_TOKENS,
    };
    const finalResponse: LlmResponse = {
      ...chunk,
      partial: false,
    };

    await plugin.afterModelCallback({
      callbackContext: mockCallbackContext,
      llmResponse: chunk,
    });
    const chunkOut = infoCalls.join('\n');
    infoCalls.length = 0;

    await plugin.afterModelCallback({
      callbackContext: mockCallbackContext,
      llmResponse: finalResponse,
    });
    const finalOut = infoCalls.join('\n');

    expect(chunkOut).toContain("Content: text: 'partial-text'");
    expect(chunkOut).toContain('Partial: true');
    expect(chunkOut).not.toContain('ERROR - Code');
    expect(chunkOut).not.toContain('Finish Reason');
    expect(finalOut).toContain('ERROR - Code: MAX_TOKENS');
    expect(finalOut).toContain('Error Message: cut off');
    expect(finalOut).toContain('Finish Reason: MAX_TOKENS');
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

  it('onEventCallback logs node path and output', async () => {
    const plugin = new LoggingPlugin();

    await plugin.onEventCallback({
      invocationContext: mockInvocationContext,
      event: makeNodeEvent({output: {answer: 42}}),
    });

    const out = infoCalls.join('\n');
    expect(out).toContain('Node Path: wf@1/step@2');
    expect(out).toContain('Node Output: {"answer":42}');
    expect(out).not.toContain('Node Error');
  });

  it('onEventCallback quotes string node output', async () => {
    const plugin = new LoggingPlugin();

    await plugin.onEventCallback({
      invocationContext: mockInvocationContext,
      event: makeNodeEvent({output: ''}),
    });

    expect(infoCalls.join('\n')).toContain("Node Output: ''");
  });

  it('onEventCallback skips output when messageAsOutput is true', async () => {
    const plugin = new LoggingPlugin();

    await plugin.onEventCallback({
      invocationContext: mockInvocationContext,
      event: makeNodeEvent({
        content: {parts: [{text: 'the answer'}]},
        output: 'the answer',
        messageAsOutput: true,
      }),
    });

    const out = infoCalls.join('\n');
    expect(out).toContain('Node Path: wf@1/step@2');
    expect(out).not.toContain('Node Output');
  });

  it('onEventCallback logs node error alongside output', async () => {
    const plugin = new LoggingPlugin();

    await plugin.onEventCallback({
      invocationContext: mockInvocationContext,
      event: makeNodeEvent({
        errorCode: 'ValueError',
        errorMessage: 'invalid input',
        output: {processed: 3},
      }),
    });

    const out = infoCalls.join('\n');
    expect(out).toContain('Node Error: [ValueError] invalid input');
    expect(out).toContain('Node Output: {"processed":3}');
  });

  it('onEventCallback logs node error without message', async () => {
    const plugin = new LoggingPlugin();

    await plugin.onEventCallback({
      invocationContext: mockInvocationContext,
      event: makeNodeEvent({errorCode: 'ValueError'}),
    });

    expect(infoCalls.join('\n')).toContain('Node Error: [ValueError]\u001b[0m');
  });

  it('onEventCallback skips node output and error on partial event', async () => {
    const plugin = new LoggingPlugin();

    await plugin.onEventCallback({
      invocationContext: mockInvocationContext,
      event: makeNodeEvent({
        partial: true,
        output: {processed: 3},
        errorCode: 'ValueError',
        errorMessage: 'invalid input',
      }),
    });

    const out = infoCalls.join('\n');
    expect(out).toContain('Node Path: wf@1/step@2');
    expect(out).not.toContain('Node Output');
    expect(out).not.toContain('Node Error');
  });

  it.each([
    'MAX_TOKENS',
    'SAFETY',
    'MODEL_ARMOR',
    FinishReason.MAX_TOKENS,
  ] as const)(
    'onEventCallback does not log model termination %s as node error',
    async (errorCode) => {
      const plugin = new LoggingPlugin();

      await plugin.onEventCallback({
        invocationContext: mockInvocationContext,
        event: makeNodeEvent({errorCode, errorMessage: 'model stopped'}),
      });

      const out = infoCalls.join('\n');
      expect(out).toContain('Node Path: wf@1/step@2');
      expect(out).not.toContain('Node Error');
    },
  );

  it('onEventCallback logs no node lines outside a workflow', async () => {
    const plugin = new LoggingPlugin();

    await plugin.onEventCallback({
      invocationContext: mockInvocationContext,
      event: createEvent({
        author: 'agent',
        output: {processed: 3},
        errorCode: 'ValueError',
        errorMessage: 'invalid input',
      }),
    });

    expect(infoCalls.join('\n')).not.toContain('Node ');
  });

  it('onEventCallback truncates long node output', async () => {
    const plugin = new LoggingPlugin();

    await plugin.onEventCallback({
      invocationContext: mockInvocationContext,
      event: makeNodeEvent({output: 'a'.repeat(400)}),
    });

    expect(infoCalls.join('\n')).toContain(
      `Node Output: '${'a'.repeat(299)}...\u001b[0m`,
    );
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

  it('beforeToolCallback truncates long arguments', async () => {
    const plugin = new LoggingPlugin();
    const toolArgs = {payload: 'a'.repeat(400)};
    const serialized = JSON.stringify(toolArgs);

    const result = await plugin.beforeToolCallback({
      tool: mockTool,
      toolArgs,
      toolContext: mockToolContext,
    });

    const out = infoCalls.join('\n');
    expect(result).toBeUndefined();
    expect(out).toContain(`Arguments: ${serialized.slice(0, 300)}...}`);
    expect(out).not.toContain(serialized);
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

  it('afterToolCallback logs result with error-like keys as completed', async () => {
    const plugin = new LoggingPlugin();

    const result = await plugin.afterToolCallback({
      tool: mockTool,
      toolArgs: {},
      toolContext: mockToolContext,
      result: {error: 'none', error_details: 'none'},
    });

    const out = infoCalls.join('\n');
    expect(result).toBeUndefined();
    expect(out).toContain('🔧 TOOL COMPLETED');
    expect(out).not.toContain('TOOL ERROR');
  });

  it('afterToolCallback logs retry answer as tool error', async () => {
    const plugin = new LoggingPlugin();
    const lookupTool = {name: 'lookup'} as BaseTool;
    const answer = await createRetryAnswer(
      lookupTool,
      mockToolContext,
      new Error('quota exceeded'),
    );

    const result = await plugin.afterToolCallback({
      tool: lookupTool,
      toolArgs: {q: 'x'},
      toolContext: mockToolContext,
      result: answer,
    });

    const out = infoCalls.join('\n');
    expect(result).toBeUndefined();
    expect(out).toContain('🔧 TOOL ERROR');
    expect(out).toContain('Tool Name: lookup');
    expect(out).toContain('Function Call ID: fc-1');
    expect(out).toContain('Arguments: {"q":"x"}');
    expect(out).toContain('Error: quota exceeded');
    expect(out).not.toContain('TOOL COMPLETED');
  });

  it('afterToolCallback logs MCP error result as tool error', async () => {
    const plugin = new LoggingPlugin();

    await plugin.afterToolCallback({
      tool: {name: 'mcpTool'} as BaseTool,
      toolArgs: {},
      toolContext: mockToolContext,
      result: MCP_ERROR_RESULT,
    });

    const out = infoCalls.join('\n');
    expect(out).toContain('🔧 TOOL ERROR');
    expect(out).toContain(
      'Error: Tool returned an MCP result with isError=true.',
    );
    expect(out).not.toContain('TOOL COMPLETED');
  });

  it('afterToolCallback logs classified error', async () => {
    const plugin = new LoggingPlugin({
      toolResultClassifier: classifyStatusField,
    });

    await plugin.afterToolCallback({
      tool: {name: 'appTool'} as BaseTool,
      toolArgs: {},
      toolContext: mockToolContext,
      result: {status: 'ERROR', reason: 'row not found'},
    });

    const outWithReason = infoCalls.join('\n');
    expect(outWithReason).toContain('🔧 TOOL ERROR');
    expect(outWithReason).toContain('Error: row not found');
    expect(outWithReason).not.toContain('TOOL COMPLETED');

    infoCalls.length = 0;
    await plugin.afterToolCallback({
      tool: {name: 'appTool'} as BaseTool,
      toolArgs: {},
      toolContext: mockToolContext,
      result: {status: 'ERROR'},
    });

    const outDefaultMessage = infoCalls.join('\n');
    expect(outDefaultMessage).toContain('🔧 TOOL ERROR');
    expect(outDefaultMessage).toContain(
      'Error: toolResultClassifier classified the tool result as an error.',
    );
    expect(outDefaultMessage).not.toContain('TOOL COMPLETED');
  });

  it('classifier OK verdict overrides MCP rule', async () => {
    const recordedResults: unknown[] = [];
    const plugin = new LoggingPlugin({
      toolResultClassifier: ({result}): ToolResultClassification => {
        recordedResults.push(result);
        return toolResultClassification({status: 'OK'});
      },
    });

    await plugin.afterToolCallback({
      tool: {name: 'mcpTool'} as BaseTool,
      toolArgs: {},
      toolContext: mockToolContext,
      result: MCP_ERROR_RESULT,
    });

    const out = infoCalls.join('\n');
    expect(recordedResults).toEqual([MCP_ERROR_RESULT]);
    expect(out).toContain('🔧 TOOL COMPLETED');
    expect(out).not.toContain('TOOL ERROR');
  });

  it('classifier cannot hide retry answer', async () => {
    const recordedResults: unknown[] = [];
    const plugin = new LoggingPlugin({
      toolResultClassifier: ({result}) => {
        recordedResults.push(result);
        return toolResultClassification({status: 'OK'});
      },
    });
    const lookupTool = {name: 'lookup'} as BaseTool;
    const answer = await createRetryAnswer(
      lookupTool,
      mockToolContext,
      new Error('quota exceeded'),
    );

    await plugin.afterToolCallback({
      tool: lookupTool,
      toolArgs: {},
      toolContext: mockToolContext,
      result: answer,
    });

    const out = infoCalls.join('\n');
    expect(recordedResults).toEqual([]);
    expect(out).toContain('Error: quota exceeded');
    expect(out).not.toContain('TOOL COMPLETED');
  });

  it('failing classifier falls back to built-in rule without leaking result in warning', async () => {
    const plugin = new LoggingPlugin({
      toolResultClassifier: ({result}) => {
        throw new Error(`cannot classify ${JSON.stringify(result)}`);
      },
    });
    const result = {...MCP_ERROR_RESULT, secret: 'sentinel-result-7c1d'};

    await plugin.afterToolCallback({
      tool: {name: 'appTool'} as BaseTool,
      toolArgs: {},
      toolContext: mockToolContext,
      result,
    });

    const out = infoCalls.join('\n');
    const warnings = warnCalls.join('\n');
    expect(out).toContain(
      'Error: Tool returned an MCP result with isError=true.',
    );
    expect(warnings).toContain(
      'toolResultClassifier failed or returned an unusable verdict for tool appTool',
    );
    expect(warnings).not.toContain('sentinel-result-7c1d');
  });

  it('classifier returning awaitable logs warning and falls back to built-in rule', async () => {
    const awaitableClassifier = (() =>
      Promise.resolve(
        toolResultClassification({status: 'OK'}),
      )) as unknown as ToolResultClassifier;
    const plugin = new LoggingPlugin({
      toolResultClassifier: awaitableClassifier,
    });

    await plugin.afterToolCallback({
      tool: {name: 'appTool'} as BaseTool,
      toolArgs: {},
      toolContext: mockToolContext,
      result: MCP_ERROR_RESULT,
    });

    const out = infoCalls.join('\n');
    const warnings = warnCalls.join('\n');
    expect(out).toContain(
      'Error: Tool returned an MCP result with isError=true.',
    );
    expect(warnings).toContain(
      'toolResultClassifier returned an awaitable for tool appTool; it must be synchronous. Applying the built-in rule instead.',
    );
  });

  it.each([
    ['non-function', 'not a function'],
    ['async function', async () => null],
    ['multi-argument function', (_a: unknown, _b: unknown) => null],
  ])('constructor rejects %s classifier', (_label, classifier) => {
    expect(
      () =>
        new LoggingPlugin({
          toolResultClassifier: classifier as unknown as ToolResultClassifier,
        }),
    ).toThrow(RangeError);
  });

  it('toolResultClassification validates status and errorMessage', () => {
    expect(toolResultClassification({status: 'OK'})).toEqual({
      status: 'OK',
      errorMessage: null,
    });
    expect(() => toolResultClassification({status: 'INVALID' as 'OK'})).toThrow(
      RangeError,
    );
    expect(() =>
      toolResultClassification({
        status: 'ERROR',
        errorMessage: 123 as unknown as string,
      }),
    ).toThrow(RangeError);
  });

  it('answer to a logged tool error is not logged again', async () => {
    const plugin = new LoggingPlugin();
    const lookupTool = {name: 'lookup'} as BaseTool;
    const error = new Error('quota exceeded');

    await plugin.onToolErrorCallback({
      tool: lookupTool,
      toolArgs: {},
      toolContext: mockToolContext,
      error,
    });
    const answer = await createRetryAnswer(lookupTool, mockToolContext, error);
    await plugin.afterToolCallback({
      tool: lookupTool,
      toolArgs: {},
      toolContext: mockToolContext,
      result: answer,
    });

    const out = infoCalls.join('\n');
    expect(infoCalls.filter((m) => m.includes('🔧 TOOL ERROR'))).toHaveLength(
      1,
    );
    expect(out).toContain('Error: quota exceeded');
    expect(out).not.toContain('TOOL COMPLETED');
  });

  it('logged tool error does not skip another call', async () => {
    const plugin = new LoggingPlugin();
    const lookupTool = {name: 'lookup'} as BaseTool;
    const otherCall = {
      agentName: 'test-agent',
      invocationId: 'inv-1',
      functionCallId: 'fc-2',
    } as unknown as Context;

    await plugin.onToolErrorCallback({
      tool: lookupTool,
      toolArgs: {},
      toolContext: mockToolContext,
      error: new Error('boom'),
    });
    await plugin.afterToolCallback({
      tool: lookupTool,
      toolArgs: {},
      toolContext: otherCall,
      result: {rows: 1},
    });

    const out = infoCalls.join('\n');
    expect(out).toContain('🔧 TOOL COMPLETED');
    expect(out).toContain('Function Call ID: fc-2');
  });

  it('plugin registered after the answering plugin logs the answer', async () => {
    const first = new LoggingPlugin('first');
    const second = new LoggingPlugin('second');
    const lookupTool = {name: 'lookup'} as BaseTool;
    const error = new Error('quota exceeded');

    await first.onToolErrorCallback({
      tool: lookupTool,
      toolArgs: {},
      toolContext: mockToolContext,
      error,
    });
    const answer = await createRetryAnswer(lookupTool, mockToolContext, error);
    for (const loggingPlugin of [first, second]) {
      await loggingPlugin.afterToolCallback({
        tool: lookupTool,
        toolArgs: {},
        toolContext: mockToolContext,
        result: answer,
      });
    }

    const out = infoCalls.join('\n');
    expect(
      infoCalls.filter((m) => m.includes('[first] 🔧 TOOL ERROR')),
    ).toHaveLength(1);
    expect(
      infoCalls.filter((m) => m.includes('[second] 🔧 TOOL ERROR')),
    ).toHaveLength(1);
    expect(out).not.toContain('TOOL COMPLETED');
  });

  it.each([false, true])(
    'logs raised error answered by retry plugin once (loggingFirst=%s)',
    async (loggingFirst) => {
      const raisingTool = new FunctionTool({
        name: 'raisingTool',
        description: 'Always fails.',
        execute: () => {
          throw new Error('quota exceeded');
        },
      });
      const loggingPlugin = new LoggingPlugin();
      const retryPlugin = new ReflectAndRetryToolPlugin({maxRetries: 3});
      const agent = new LlmAgent({
        name: 'agent',
        model: new ScriptedLlm([
          {
            content: {
              role: 'model',
              parts: [{functionCall: {name: 'raisingTool', args: {}}}],
            },
          },
          {
            content: {
              role: 'model',
              parts: [{text: 'done'}],
            },
          },
        ]),
        tools: [raisingTool],
      });
      const runner = new InMemoryRunner({
        app: new App({
          name: 'test-app',
          rootAgent: agent,
          plugins: loggingFirst
            ? [loggingPlugin, retryPlugin]
            : [retryPlugin, loggingPlugin],
        }),
      });
      const session = await runner.sessionService.createSession({
        appName: 'test-app',
        userId: 'user-1',
      });

      for await (const _event of runner.runAsync({
        userId: 'user-1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'go'}]},
      })) {
        // Consume all runner events.
      }

      const out = infoCalls.join('\n');
      expect(infoCalls.filter((m) => m.includes('🔧 TOOL ERROR'))).toHaveLength(
        1,
      );
      expect(out).toMatch(/Error: .*quota exceeded/);
      expect(out).not.toContain('TOOL COMPLETED');
    },
  );

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
