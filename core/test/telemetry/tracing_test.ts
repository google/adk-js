/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ApiError, Type} from '@google/genai';
import {type Context, SpanStatusCode, trace} from '@opentelemetry/api';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  BaseAgent,
  BaseTool,
  createEventActions,
  Event,
  InvocationContext,
  LlmRequest,
  LlmResponse,
  Session,
  ToolErrorType,
  ToolExecutionError,
} from '@google/adk';
import {
  recordAgentInvocation,
  recordCallLlmResponse,
  recordMergedToolCalls,
  recordToolExecution,
} from '../../src/telemetry/api/instrumentation.js';

vi.hoisted(() => {
  vi.resetModules();
});
vi.mock('@opentelemetry/api', () => {
  const mockTracer = {
    startSpan: vi.fn(),
    startActiveSpan: vi.fn(),
  };
  return {
    SpanStatusCode: {
      UNSET: 0,
      OK: 1,
      ERROR: 2,
    },
    context: {
      active: vi.fn(() => ({})),
      with: vi.fn((_ctx: Context, fn: () => unknown) => fn()),
      bind: vi.fn((_ctx: Context, fn: unknown) => fn),
    },
    trace: {
      getTracer: vi.fn(() => mockTracer),
      getActiveSpan: vi.fn(),
      setSpan: vi.fn((ctx: Context) => ctx),
    },
  };
});

describe('Telemetry Instrumentation Functions', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSpan: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockTracer: any;
  let mockAgent: BaseAgent;
  let mockInvocationContext: InvocationContext;
  let mockTool: BaseTool;
  let mockEvent: Event;
  let mockLlmRequest: LlmRequest;
  let mockLlmResponse: LlmResponse;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSpan = {
      setAttributes: vi.fn(),
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };

    mockTracer = trace.getTracer('gcp.vertex.agent');
    vi.mocked(mockTracer.startSpan).mockReturnValue(mockSpan);
    vi.mocked(mockTracer.startActiveSpan).mockImplementation(
      (_name: string, fn: (span: unknown) => unknown) => fn(mockSpan),
    );
    vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);

    mockAgent = {
      name: 'test-agent',
      description: 'A test agent',
    } as BaseAgent;

    mockInvocationContext = {
      invocationId: 'test-invocation-id',
      session: {
        id: 'test-session-id',
      } as Session,
      agent: mockAgent,
    } as InvocationContext;

    mockTool = {
      name: 'test-tool',
      description: 'A test tool',
      constructor: {
        name: 'FunctionTool',
      },
    } as BaseTool;

    mockEvent = {
      id: 'test-event-id',
      invocationId: 'test-invocation-id',
      actions: createEventActions({skipSummarization: false}),
      timestamp: Date.now(),
      content: {
        parts: [
          {
            functionResponse: {
              id: 'test-call-id',
              response: {result: 'test-result'},
            },
          },
        ],
      },
    } as Event;

    mockLlmRequest = {
      model: 'test-model',
      contents: [],
      config: {
        topP: 0.8,
        maxOutputTokens: 100,
      },
      liveConnectConfig: {},
      toolsDict: {},
    } as LlmRequest;

    mockLlmResponse = {
      content: {parts: [{text: 'test-response'}]},
    } as LlmResponse;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('recordAgentInvocation', () => {
    it('should set correct attributes for agent invocation', async () => {
      for await (const _ of recordAgentInvocation(
        {agent: mockAgent},
        async function* (scope) {
          scope.recordInvocation(mockInvocationContext);
          yield mockEvent;
        },
      )) {
        // drain
      }

      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.description': 'A test agent',
        'gen_ai.agent.name': 'test-agent',
        'gen_ai.conversation.id': 'test-session-id',
      });
      expect(mockSpan.end).toHaveBeenCalledOnce();
    });
  });

  describe('recordToolExecution', () => {
    it('should set correct attributes for tool call', async () => {
      const args = {param1: 'value1', param2: 123};

      await recordToolExecution(
        {toolName: mockTool.name, invocationContext: mockInvocationContext},
        async (scope) => {
          scope.recordSuccess({
            tool: mockTool,
            args,
            functionResponseEvent: mockEvent,
            rawResult: {result: 'test-result'},
          });
        },
      );

      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.system': 'gcp.vertex.agent',
        'gen_ai.tool.description': 'A test tool',
        'gen_ai.tool.name': 'test-tool',
        'gen_ai.tool.type': 'FunctionTool',
        'gcp.vertex.agent.invocation_id': 'test-invocation-id',
        'gcp.vertex.agent.llm_request': '{}',
        'gcp.vertex.agent.llm_response': '{}',
        'gcp.vertex.agent.tool_call_args': expect.stringContaining('param1'),
      });

      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.tool.call.id': 'test-call-id',
        'gcp.vertex.agent.event_id': 'test-event-id',
        'gcp.vertex.agent.tool_response':
          expect.stringContaining('test-result'),
      });
    });

    it('should handle tool call without function response', async () => {
      const eventWithoutResponse = {
        id: 'test-event-id',
        invocationId: 'test-invocation-id',
        actions: createEventActions({skipSummarization: false}),
        timestamp: Date.now(),
        content: {parts: []},
      } as Event;

      await recordToolExecution(
        {toolName: mockTool.name, invocationContext: mockInvocationContext},
        async (scope) => {
          scope.recordSuccess({
            tool: mockTool,
            args: {},
            functionResponseEvent: eventWithoutResponse,
            rawResult: undefined,
          });
        },
      );

      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.tool.call.id': '<not specified>',
        'gcp.vertex.agent.event_id': 'test-event-id',
        'gcp.vertex.agent.tool_response':
          expect.stringContaining('not specified'),
      });
    });

    it('records a thrown ADK error using its explicit error type', async () => {
      const error = new ToolExecutionError(
        'sensitive tool error details',
        ToolErrorType.BAD_REQUEST,
      );

      await recordToolExecution(
        {toolName: mockTool.name, invocationContext: mockInvocationContext},
        async (scope) => {
          scope.recordError({
            tool: mockTool,
            args: {},
            error,
          });
        },
      );

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'error.type',
        ToolErrorType.BAD_REQUEST,
      );
      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: ToolErrorType.BAD_REQUEST,
      });
      expect(mockSpan.setStatus).not.toHaveBeenCalledWith(
        expect.objectContaining({message: error.message}),
      );
    });

    it('records a GenAI API error using its HTTP status', async () => {
      const error = new ApiError({status: 429, message: 'rate limited'});

      await recordToolExecution(
        {toolName: mockTool.name, invocationContext: mockInvocationContext},
        async (scope) => {
          scope.recordError({
            tool: mockTool,
            args: {},
            error,
          });
        },
      );

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('error.type', '429');
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: '429',
      });
    });

    it('uses the error class name as the fallback error type', async () => {
      const error = new TypeError('invalid tool arguments');

      await recordToolExecution(
        {toolName: mockTool.name, invocationContext: mockInvocationContext},
        async (scope) => {
          scope.recordError({
            tool: mockTool,
            args: {},
            error,
          });
        },
      );

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'error.type',
        'TypeError',
      );
    });

    it('marks a typed error response without recording an exception', async () => {
      await recordToolExecution(
        {toolName: mockTool.name, invocationContext: mockInvocationContext},
        async (scope) => {
          scope.recordSuccess({
            tool: mockTool,
            args: {},
            functionResponseEvent: mockEvent,
            rawResult: {
              error: 'sensitive details',
              errorType: 'MCP_TOOL_ERROR',
            },
          });
        },
      );

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'error.type',
        'MCP_TOOL_ERROR',
      );
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'MCP_TOOL_ERROR',
      });
      expect(mockSpan.recordException).not.toHaveBeenCalled();
    });
  });

  describe('recordMergedToolCalls', () => {
    it('should set correct attributes for merged tool calls', () => {
      const mockEventWithJson = {
        id: 'merged-event-id',
        invocationId: 'test-invocation-id',
        actions: createEventActions({skipSummarization: false}),
        timestamp: Date.now(),
        content: {
          parts: [
            {
              text: 'merged response data',
            },
          ],
        },
        model_dumps_json: vi.fn().mockReturnValue('{"merged": "data"}'),
      };

      recordMergedToolCalls({
        responseEventId: 'merged-event-id',
        functionResponseEvent: mockEventWithJson as unknown as Event,
        invocationContext: mockInvocationContext,
      });

      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.system': 'gcp.vertex.agent',
        'gen_ai.tool.name': '(merged tools)',
        'gen_ai.tool.description': '(merged tools)',
        'gen_ai.tool.call.id': 'merged-event-id',
        'gcp.vertex.agent.invocation_id': 'test-invocation-id',
        'gcp.vertex.agent.tool_call_args': 'N/A',
        'gcp.vertex.agent.event_id': 'merged-event-id',
        'gcp.vertex.agent.llm_request': '{}',
        'gcp.vertex.agent.llm_response': '{}',
      });

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'gcp.vertex.agent.tool_response',
        expect.any(String),
      );
    });
  });

  describe('recordCallLlmResponse', () => {
    it('should set correct attributes for LLM call', () => {
      recordCallLlmResponse({
        invocationContext: mockInvocationContext,
        eventId: 'test-event-id',
        llmRequest: mockLlmRequest,
        llmResponse: mockLlmResponse,
      });

      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.system': 'gcp.vertex.agent',
        'gen_ai.request.model': 'test-model',
        'gen_ai.agent.name': 'test-agent',
        'gcp.vertex.agent.invocation_id': 'test-invocation-id',
        'gcp.vertex.agent.session_id': 'test-session-id',
        'gcp.vertex.agent.event_id': 'test-event-id',
        'gcp.vertex.agent.llm_request': expect.stringContaining('test-model'),
      });

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'gen_ai.request.top_p',
        0.8,
      );
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'gen_ai.request.max_tokens',
        100,
      );
    });

    it('should handle LLM call without config', () => {
      const requestWithoutConfig = {...mockLlmRequest, config: undefined};

      recordCallLlmResponse({
        invocationContext: mockInvocationContext,
        eventId: 'test-event-id',
        llmRequest: requestWithoutConfig,
        llmResponse: mockLlmResponse,
      });

      expect(mockSpan.setAttribute).not.toHaveBeenCalledWith(
        'gen_ai.request.top_p',
        expect.anything(),
      );
      expect(mockSpan.setAttribute).not.toHaveBeenCalledWith(
        'gen_ai.request.max_tokens',
        expect.anything(),
      );
    });

    it('should omit responseSchema from the traced request config', () => {
      const requestWithSchema = {
        ...mockLlmRequest,
        config: {
          ...mockLlmRequest.config,
          responseSchema: {
            type: Type.OBJECT,
            properties: {answer: {type: Type.STRING}},
          },
        },
      };

      recordCallLlmResponse({
        invocationContext: mockInvocationContext,
        eventId: 'test-event-id',
        llmRequest: requestWithSchema,
        llmResponse: mockLlmResponse,
      });

      const attributes = mockSpan.setAttributes.mock.calls[0][0];
      const tracedRequest = JSON.parse(
        attributes['gcp.vertex.agent.llm_request'],
      );
      expect(tracedRequest.config).not.toHaveProperty('responseSchema');
      expect(tracedRequest.config).toEqual({topP: 0.8, maxOutputTokens: 100});
    });

    it('should not serialize credential-bearing httpOptions fields', () => {
      const httpOptions = {
        baseUrl: 'https://example.test',
        headers: {Authorization: 'Bearer sentinel-secret-token'},
        extraBody: {apiKey: 'sentinel-secret-token'},
      };
      const llmRequest = {
        ...mockLlmRequest,
        config: {temperature: 0.1, httpOptions},
      };

      recordCallLlmResponse({
        invocationContext: mockInvocationContext,
        eventId: 'test-event-id',
        llmRequest,
        llmResponse: mockLlmResponse,
      });

      const serialized: string =
        mockSpan.setAttributes.mock.calls[0][0]['gcp.vertex.agent.llm_request'];
      expect(serialized).not.toContain('sentinel-secret-token');
      expect(serialized).not.toContain('Authorization');

      const traced = JSON.parse(serialized);
      expect(traced.config.httpOptions).toEqual({
        baseUrl: 'https://example.test',
      });
      expect(traced.config.temperature).toBe(0.1);

      expect(llmRequest.config.httpOptions).toBe(httpOptions);
      expect(httpOptions.headers).toEqual({
        Authorization: 'Bearer sentinel-secret-token',
      });
      expect(httpOptions.extraBody).toEqual({apiKey: 'sentinel-secret-token'});
    });
  });
});
