/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApiError,
  FinishReason,
  Language,
  Outcome,
  Part,
  Type,
} from '@google/genai';
import {SpanStatusCode, trace} from '@opentelemetry/api';
import type {AnyValue} from '@opentelemetry/api-logs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  BaseAgent,
  BaseTool,
  Event,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Session,
  ToolErrorType,
  ToolExecutionError,
  createEventActions,
} from '@google/adk';
import {
  ContentCapturingMode,
  USER_CONTENT_ELIDED,
  buildCompletionLogAttributes,
  buildCompletionSpanAttributes,
  choiceBody,
  extractToolDefinitions,
  getContentCapturingMode,
  getTelemetryConfig,
  guessGeminiSystemName,
  resolveErrorType,
  resolveGenAiProviderName,
  resolveGenAiSystemName,
  resolveInferenceSystemName,
  resolveSchemaVersion,
  setOperationDetailsRequestAttributes,
  setOperationDetailsResponseAttributes,
  shouldUseExperimentalGenAiSemconv,
  systemMessageBody,
  toFinishReason,
  toInputMessage,
  toOutputMessage,
  toPart,
  toSystemInstructions,
  traceAgentInvocation,
  traceCallLlm,
  traceMergedToolCalls,
  traceToolCall,
  userMessageBody,
} from '../../src/telemetry/tracing.js';

vi.hoisted(() => {
  vi.resetModules();
});
vi.mock('@opentelemetry/api');

describe('Telemetry Tracing Functions', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSpan: any;
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
    };

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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('traceAgentInvocation', () => {
    it('should set correct attributes for agent invocation', () => {
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);

      // Act
      traceAgentInvocation({
        agent: mockAgent,
        invocationContext: mockInvocationContext,
      });

      // Assert
      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.description': 'A test agent',
        'gen_ai.agent.name': 'test-agent',
        'gen_ai.conversation.id': 'test-session-id',
      });
    });
  });

  describe('traceToolCall', () => {
    it('should set correct attributes for tool call', () => {
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
      const args = {param1: 'value1', param2: 123};

      // Act
      traceToolCall({
        tool: mockTool,
        args,
        functionResponseEvent: mockEvent,
        invocationContext: mockInvocationContext,
      });

      // Assert
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

    it('should handle tool call without function response', () => {
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
      const eventWithoutResponse = {
        id: 'test-event-id',
        invocationId: 'test-invocation-id',
        actions: createEventActions({skipSummarization: false}),
        timestamp: Date.now(),
        content: {parts: []},
      } as Event;

      // Act
      traceToolCall({
        tool: mockTool,
        args: {},
        functionResponseEvent: eventWithoutResponse,
        invocationContext: mockInvocationContext,
      });

      // Assert
      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.tool.call.id': '<not specified>',
        'gcp.vertex.agent.event_id': 'test-event-id',
        'gcp.vertex.agent.tool_response':
          expect.stringContaining('not specified'),
      });
    });

    it('records a thrown ADK error using its explicit error type', () => {
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
      const error = new ToolExecutionError(
        'sensitive tool error details',
        ToolErrorType.BAD_REQUEST,
      );

      traceToolCall({
        tool: mockTool,
        args: {},
        error,
        invocationContext: mockInvocationContext,
      });

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

    it('records a GenAI API error using its HTTP status', () => {
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
      const error = new ApiError({status: 429, message: 'rate limited'});

      traceToolCall({
        tool: mockTool,
        args: {},
        error,
        invocationContext: mockInvocationContext,
      });

      expect(resolveErrorType(error)).toBe('429');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('error.type', '429');
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: '429',
      });
    });

    it('uses the error class name as the fallback error type', () => {
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
      const error = new TypeError('invalid tool arguments');

      traceToolCall({
        tool: mockTool,
        args: {},
        error,
        invocationContext: mockInvocationContext,
      });

      expect(resolveErrorType(error)).toBe('TypeError');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'error.type',
        'TypeError',
      );
    });

    it('marks a typed error response without recording an exception', () => {
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);

      traceToolCall({
        tool: mockTool,
        args: {},
        functionResponseEvent: mockEvent,
        errorType: 'MCP_TOOL_ERROR',
        invocationContext: mockInvocationContext,
      });

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

  describe('traceMergedToolCalls', () => {
    it('should set correct attributes for merged tool calls', () => {
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
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

      // Act
      traceMergedToolCalls({
        responseEventId: 'merged-event-id',
        functionResponseEvent: mockEventWithJson as unknown as Event,
        invocationContext: mockInvocationContext,
      });

      // Assert - setAttributes is called without tool_response
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

      // tool_response is set separately via setAttribute
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'gcp.vertex.agent.tool_response',
        expect.any(String),
      );
    });
  });

  describe('traceCallLlm', () => {
    it('should set correct attributes for LLM call', () => {
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);

      // Act
      traceCallLlm({
        invocationContext: mockInvocationContext,
        eventId: 'test-event-id',
        llmRequest: mockLlmRequest,
        llmResponse: mockLlmResponse,
      });

      // Assert
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
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
      const requestWithoutConfig = {...mockLlmRequest, config: undefined};

      // Act
      traceCallLlm({
        invocationContext: mockInvocationContext,
        eventId: 'test-event-id',
        llmRequest: requestWithoutConfig,
        llmResponse: mockLlmResponse,
      });

      // Assert
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
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
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

      // Act
      traceCallLlm({
        invocationContext: mockInvocationContext,
        eventId: 'test-event-id',
        llmRequest: requestWithSchema,
        llmResponse: mockLlmResponse,
      });

      // Assert
      const attributes = mockSpan.setAttributes.mock.calls[0][0];
      const tracedRequest = JSON.parse(
        attributes['gcp.vertex.agent.llm_request'],
      );
      expect(tracedRequest.config).not.toHaveProperty('responseSchema');
      expect(tracedRequest.config).toEqual({topP: 0.8, maxOutputTokens: 100});
    });

    it('should not serialize credential-bearing httpOptions fields', () => {
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
      const httpOptions = {
        baseUrl: 'https://example.test',
        headers: {Authorization: 'Bearer sentinel-secret-token'},
        extraBody: {apiKey: 'sentinel-secret-token'},
      };
      const llmRequest = {
        ...mockLlmRequest,
        config: {temperature: 0.1, httpOptions},
      };

      // Act
      traceCallLlm({
        invocationContext: mockInvocationContext,
        eventId: 'test-event-id',
        llmRequest,
        llmResponse: mockLlmResponse,
      });

      // Assert
      const serialized: string =
        mockSpan.setAttributes.mock.calls[0][0]['gcp.vertex.agent.llm_request'];
      expect(serialized).not.toContain('sentinel-secret-token');
      expect(serialized).not.toContain('Authorization');

      const traced = JSON.parse(serialized);
      expect(traced.config.httpOptions).toEqual({
        baseUrl: 'https://example.test',
      });
      expect(traced.config.temperature).toBe(0.1);

      // The config the SDK will actually send must be untouched.
      expect(llmRequest.config.httpOptions).toBe(httpOptions);
      expect(httpOptions.headers).toEqual({
        Authorization: 'Bearer sentinel-secret-token',
      });
      expect(httpOptions.extraBody).toEqual({apiKey: 'sentinel-secret-token'});
    });
  });

  describe('resolveSchemaVersion and shouldUseExperimentalGenAiSemconv', () => {
    it('defaults to schema version 2 and experimental semconv', () => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '');
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', '');
      expect(resolveSchemaVersion()).toBe(2);
      expect(shouldUseExperimentalGenAiSemconv()).toBe(true);
    });

    it('resolves schema version 1 for 1 and otel_semconv_1_36', () => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', '');
      expect(resolveSchemaVersion()).toBe(1);
      expect(shouldUseExperimentalGenAiSemconv()).toBe(false);

      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', 'otel_semconv_1_36');
      expect(resolveSchemaVersion()).toBe(1);
      expect(shouldUseExperimentalGenAiSemconv()).toBe(false);
    });

    it('resolves schema version 2 for 2, otel_semconv_1_44, and unknown values', () => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '2');
      expect(resolveSchemaVersion()).toBe(2);

      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', 'otel_semconv_1_44');
      expect(resolveSchemaVersion()).toBe(2);

      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', 'invalid_version');
      expect(resolveSchemaVersion()).toBe(2);
    });

    it('overrides to experimental semconv when OTEL_SEMCONV_STABILITY_OPT_IN includes gen_ai_latest_experimental', () => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');
      vi.stubEnv(
        'OTEL_SEMCONV_STABILITY_OPT_IN',
        'http, gen_ai_latest_experimental',
      );
      const config = getTelemetryConfig();
      expect(config.schemaVersion).toBe(1);
      expect(config.shouldUseExperimentalGenAiSemconv).toBe(true);
    });

    it('falls back safely to browser defaults when globalThis.process is undefined', () => {
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
      const savedProcess = globalThis.process;
      Reflect.deleteProperty(globalThis, 'process');
      try {
        expect(resolveSchemaVersion()).toBe(2);
        expect(shouldUseExperimentalGenAiSemconv()).toBe(true);
        expect(getContentCapturingMode()).toBe(ContentCapturingMode.NO_CONTENT);
        expect(guessGeminiSystemName()).toBe('gemini');
        expect(getTelemetryConfig()).toEqual({
          schemaVersion: 2,
          shouldUseExperimentalGenAiSemconv: true,
          captureMessageContent: ContentCapturingMode.NO_CONTENT,
          shouldAddContentToLogs: false,
          shouldAddContentToExperimentalSpans: false,
        });
        expect(() =>
          traceCallLlm({
            invocationContext: mockInvocationContext,
            eventId: 'browser-event-id',
            llmRequest: mockLlmRequest,
            llmResponse: mockLlmResponse,
          }),
        ).not.toThrow();
      } finally {
        globalThis.process = savedProcess;
      }
    });
  });

  describe('getContentCapturingMode', () => {
    it('resolves all content capturing modes case-insensitively', () => {
      vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'false');
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.NO_CONTENT);

      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'NO_CONTENT',
      );
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.NO_CONTENT);

      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'no_content',
      );
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.NO_CONTENT);

      vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'true');
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.EVENT_ONLY);

      vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'True');
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.EVENT_ONLY);

      vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', '1');
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.EVENT_ONLY);

      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'SPAN_AND_EVENT',
      );
      expect(getContentCapturingMode()).toBe(
        ContentCapturingMode.SPAN_AND_EVENT,
      );

      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'span_and_event',
      );
      expect(getContentCapturingMode()).toBe(
        ContentCapturingMode.SPAN_AND_EVENT,
      );

      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'SPAN_ONLY',
      );
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.SPAN_ONLY);

      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'span_only',
      );
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.SPAN_ONLY);

      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'EVENT_ONLY',
      );
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.EVENT_ONLY);

      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'event_only',
      );
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.EVENT_ONLY);

      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'BOGUS_VALUE',
      );
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.NO_CONTENT);
    });
  });

  describe('system and provider name resolution', () => {
    it('guesses Gemini system name from GOOGLE_GENAI_USE_VERTEXAI env var', () => {
      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
      expect(guessGeminiSystemName()).toBe('vertex_ai');
      expect(resolveGenAiSystemName('gemini-2.5-flash')).toBe('vertex_ai');
      expect(resolveGenAiProviderName('gemini-2.5-flash')).toBe(
        'gcp.vertex_ai',
      );
      expect(resolveGenAiSystemName('gemini/gemini-2.0-flash')).toBe(
        'vertex_ai',
      );
      expect(resolveGenAiProviderName('gemini/gemini-2.0-flash')).toBe(
        'gcp.vertex_ai',
      );

      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', '1');
      expect(guessGeminiSystemName()).toBe('vertex_ai');

      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'false');
      expect(guessGeminiSystemName()).toBe('gemini');
      expect(resolveGenAiSystemName('gemini-2.5-flash')).toBe('gemini');
      expect(resolveGenAiProviderName('gemini-2.5-flash')).toBe('gcp.gemini');
      expect(resolveGenAiSystemName('gemini/gemini-2.0-flash')).toBe('gemini');
      expect(resolveGenAiProviderName('gemini/gemini-2.0-flash')).toBe(
        'gcp.gemini',
      );
    });

    it('resolves Anthropic, provider-prefixed, and resource-path model names', () => {
      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'false');
      expect(resolveGenAiSystemName('claude-sonnet-4-5')).toBe('anthropic');
      expect(resolveGenAiProviderName('claude-sonnet-4-5')).toBe('anthropic');
      expect(resolveGenAiSystemName('anthropic/claude-sonnet-4-5')).toBe(
        'anthropic',
      );
      expect(resolveGenAiProviderName('anthropic/claude-sonnet-4-5')).toBe(
        'anthropic',
      );
      expect(
        resolveGenAiSystemName(
          'projects/p/locations/l/publishers/anthropic/models/claude-sonnet-4-5',
        ),
      ).toBe('anthropic');
      expect(resolveGenAiSystemName('openai/gpt-4o')).toBe('openai');
      expect(resolveGenAiProviderName('openai/gpt-4o')).toBe('openai');

      expect(
        resolveGenAiSystemName(
          'projects/p/locations/l/publishers/meta/models/llama-3',
        ),
      ).toBe('gemini');
      expect(
        resolveGenAiSystemName('projects/p/locations/l/endpoints/123456'),
      ).toBe('gemini');
      expect(resolveGenAiSystemName('tunedModels/my-tuned-model')).toBe(
        'gemini',
      );
    });

    it('resolves inference system name from response modelVersion or agent model', () => {
      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'false');
      const agent = new LlmAgent({name: 'root', model: 'claude-sonnet-4-5'});
      const ctx = {agent} as unknown as InvocationContext;

      expect(resolveInferenceSystemName(ctx, {})).toBe('anthropic');
      expect(
        resolveInferenceSystemName(ctx, {modelVersion: 'gemini-2.5-flash-001'}),
      ).toBe('gemini');
    });
  });

  describe('experimental semconv helpers (v2)', () => {
    it('converts all part types in toPart', () => {
      expect(toPart({text: 'hello'})).toEqual({
        type: 'text',
        content: 'hello',
      });

      expect(toPart({text: 'thinking...', thought: true})).toEqual({
        type: 'text',
        content: 'thinking...',
      });

      expect(
        toPart({functionCall: {id: 'call-1', name: 'my_tool', args: {x: 1}}}),
      ).toEqual({
        type: 'tool_call',
        id: 'call-1',
        name: 'my_tool',
        arguments: {x: 1},
      });
      expect(
        toPart({functionCall: {name: 'my_tool', args: {x: 1}}}, 2),
      ).toEqual({
        type: 'tool_call',
        id: 'my_tool_2',
        name: 'my_tool',
        arguments: {x: 1},
      });
      expect(toPart({functionCall: {args: {x: 1}}}, 3)).toEqual({
        type: 'tool_call',
        id: '3',
        name: '',
        arguments: {x: 1},
      });

      expect(
        toPart({
          functionResponse: {
            id: 'call-1',
            name: 'my_tool',
            response: {ok: true},
          },
        }),
      ).toEqual({
        type: 'tool_call_response',
        id: 'call-1',
        response: {ok: true},
      });
      expect(
        toPart(
          {
            functionResponse: {
              name: 'my_tool',
              response: {ok: true},
            },
          },
          4,
        ),
      ).toEqual({
        type: 'tool_call_response',
        id: 'my_tool_4',
        response: {ok: true},
      });

      expect(
        toPart({
          codeExecutionResult: {
            outcome: Outcome.OUTCOME_OK,
            output: '42\n',
          },
        }),
      ).toBeUndefined();

      expect(
        toPart({
          executableCode: {
            language: Language.PYTHON,
            code: 'print(42)',
          },
        }),
      ).toBeUndefined();

      expect(
        toPart({
          fileData: {
            fileUri: 'gs://bucket/img.png',
            mimeType: 'image/png',
          },
        }),
      ).toEqual({
        type: 'file_data',
        uri: 'gs://bucket/img.png',
        mime_type: 'image/png',
      });

      expect(
        toPart({
          inlineData: {
            data: 'aGVsbG8=',
            mimeType: 'audio/wav',
          },
        }),
      ).toEqual({
        type: 'blob',
        data: 'aGVsbG8=',
        mime_type: 'audio/wav',
      });

      expect(toPart({})).toBeUndefined();
    });

    it('converts system instructions, input messages, output messages, finish reasons, and tool definitions', () => {
      expect(toSystemInstructions('be helpful')).toEqual([
        {type: 'text', content: 'be helpful'},
      ]);
      expect(toSystemInstructions({parts: [{text: 'sys part'}]})).toEqual([
        {type: 'text', content: 'sys part'},
      ]);

      expect(toInputMessage({role: 'model', parts: [{text: 'hi'}]})).toEqual({
        role: 'assistant',
        parts: [{type: 'text', content: 'hi'}],
      });
      expect(toInputMessage({role: 'user', parts: []})).toEqual({
        role: 'user',
        parts: [],
      });
      expect(toInputMessage({role: 'tool', parts: []})).toEqual({
        role: '',
        parts: [],
      });
      expect(toInputMessage({parts: []})).toEqual({
        role: '',
        parts: [],
      });
      expect(
        toInputMessage({
          role: 'user',
          parts: [
            {text: 'first'},
            {functionCall: {name: 'lookup', args: {q: 'a'}}},
            {functionResponse: {response: {ok: true}}},
          ],
        }),
      ).toEqual({
        role: 'user',
        parts: [
          {type: 'text', content: 'first'},
          {
            type: 'tool_call',
            id: 'lookup_1',
            name: 'lookup',
            arguments: {q: 'a'},
          },
          {
            type: 'tool_call_response',
            id: '2',
            response: {ok: true},
          },
        ],
      });

      expect(toFinishReason(FinishReason.STOP)).toBe('stop');
      expect(toFinishReason(FinishReason.MAX_TOKENS)).toBe('length');
      expect(toFinishReason(FinishReason.SAFETY)).toBe('safety');
      expect(toFinishReason(FinishReason.OTHER)).toBe('error');
      expect(toFinishReason(undefined)).toBe('');

      const outMsg = toOutputMessage({
        content: {role: 'model', parts: [{text: 'answer'}]},
        finishReason: FinishReason.STOP,
      });
      expect(outMsg).toEqual({
        role: 'assistant',
        parts: [{type: 'text', content: 'answer'}],
        finish_reason: 'stop',
      });
      expect(
        toOutputMessage({
          content: {role: 'model', parts: []},
          finishReason: FinishReason.STOP,
        }),
      ).toEqual({
        role: 'assistant',
        parts: [],
        finish_reason: 'stop',
      });
      expect(
        toOutputMessage({
          content: {role: 'tool', parts: [{text: 'raw'}]},
        }),
      ).toEqual({
        role: '',
        parts: [{type: 'text', content: 'raw'}],
        finish_reason: '',
      });
      expect(
        toOutputMessage({
          finishReason: FinishReason.STOP,
        }),
      ).toBeUndefined();

      const tools = extractToolDefinitions({
        model: 'gemini-2.5-flash',
        contents: [],
        config: {
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'lookup',
                  description: 'Looks up an item',
                  parametersJsonSchema: {type: 'object'},
                },
                {
                  name: 'no_desc',
                  parameters: {type: Type.OBJECT},
                  parametersJsonSchema: {type: 'string'},
                },
              ],
            },
            {googleSearch: {}},
          ],
        },
        liveConnectConfig: {},
        toolsDict: {},
      });
      expect(tools).toEqual([
        {
          type: 'function',
          name: 'lookup',
          description: 'Looks up an item',
          parameters: {type: 'object'},
        },
        {
          type: 'function',
          name: 'no_desc',
          description: null,
          parameters: {type: Type.OBJECT},
        },
        {name: 'google_search', type: 'google_search'},
      ]);
    });
  });

  describe('stable semconv helpers (v1)', () => {
    it('formats systemMessageBody, userMessageBody, and choiceBody with and without content', () => {
      const withContentConfig = {
        schemaVersion: 1,
        shouldUseExperimentalGenAiSemconv: false,
        captureMessageContent: ContentCapturingMode.EVENT_ONLY,
        shouldAddContentToLogs: true,
        shouldAddContentToExperimentalSpans: false,
      };
      const noContentConfig = {
        ...withContentConfig,
        captureMessageContent: ContentCapturingMode.NO_CONTENT,
        shouldAddContentToLogs: false,
      };

      const req: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {systemInstruction: 'inst 1'},
        liveConnectConfig: {},
        toolsDict: {},
      };
      expect(systemMessageBody(req, withContentConfig)).toEqual({
        content: 'inst 1',
      });
      expect(systemMessageBody(req, noContentConfig)).toEqual({
        content: USER_CONTENT_ELIDED,
      });

      const emptySysReq: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {},
        liveConnectConfig: {},
        toolsDict: {},
      };
      expect(systemMessageBody(emptySysReq, withContentConfig)).toEqual({
        content: null,
      });
      expect(systemMessageBody(emptySysReq, noContentConfig)).toEqual({
        content: USER_CONTENT_ELIDED,
      });

      const contentSysReq: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {
          systemInstruction: {
            role: 'user',
            parts: [{text: 'You are helpful.'}],
          },
        },
        liveConnectConfig: {},
        toolsDict: {},
      };
      expect(systemMessageBody(contentSysReq, withContentConfig)).toEqual({
        content: {
          role: 'user',
          parts: [{text: 'You are helpful.'}],
        },
      });

      const partArraySysReq: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {
          systemInstruction: [{text: 'part 1'}, {text: 'part 2'}] as Part[],
        },
        liveConnectConfig: {},
        toolsDict: {},
      };
      expect(systemMessageBody(partArraySysReq, withContentConfig)).toEqual({
        content: [{text: 'part 1'}, {text: 'part 2'}],
      });

      const userContent = {
        role: 'user',
        parts: [{text: 'hello'}],
      };
      expect(userMessageBody(userContent, withContentConfig)).toEqual({
        content: {
          role: 'user',
          parts: [{text: 'hello'}],
        },
      });
      expect(userMessageBody(userContent, noContentConfig)).toEqual({
        content: USER_CONTENT_ELIDED,
      });

      const response: LlmResponse = {
        content: {
          role: 'model',
          parts: [
            {text: 'reply text'},
            {functionCall: {id: 'call-1', name: 'fn', args: {a: 1}}},
          ],
        },
        finishReason: FinishReason.STOP,
      };
      expect(choiceBody(response, withContentConfig)).toEqual({
        content: {
          role: 'model',
          parts: [
            {text: 'reply text'},
            {function_call: {id: 'call-1', name: 'fn', args: {a: 1}}},
          ],
        },
        finish_reason: FinishReason.STOP,
        index: 0,
      });
      expect(choiceBody(response, noContentConfig)).toEqual({
        content: USER_CONTENT_ELIDED,
        finish_reason: FinishReason.STOP,
        index: 0,
      });
      expect(
        choiceBody({finishReason: FinishReason.OTHER}, withContentConfig),
      ).toEqual({
        content: null,
        finish_reason: FinishReason.OTHER,
        index: 0,
      });
    });
  });

  describe('buildCompletionLogAttributes and buildCompletionSpanAttributes', () => {
    it('builds structured log attributes and pre-serialized span attributes', () => {
      const req: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [{role: 'user', parts: [{text: 'hi'}]}],
        config: {systemInstruction: 'be helpful'},
        liveConnectConfig: {},
        toolsDict: {},
      };
      const res: LlmResponse = {
        content: {role: 'model', parts: [{text: 'hello'}]},
        finishReason: FinishReason.STOP,
      };

      const operationDetailsAttrs: Record<string, AnyValue> = {};
      const operationDetailsCommonAttrs: Record<string, AnyValue> = {
        'gen_ai.agent.name': 'test-agent',
      };
      setOperationDetailsRequestAttributes(operationDetailsAttrs, req, true);
      setOperationDetailsResponseAttributes(
        res,
        operationDetailsAttrs,
        operationDetailsCommonAttrs,
      );

      const fullConfig = {
        schemaVersion: 2,
        shouldUseExperimentalGenAiSemconv: true,
        captureMessageContent: ContentCapturingMode.SPAN_AND_EVENT,
        shouldAddContentToLogs: true,
        shouldAddContentToExperimentalSpans: true,
      };

      const logAttrs = buildCompletionLogAttributes(
        fullConfig,
        operationDetailsAttrs,
        operationDetailsCommonAttrs,
      );
      expect(logAttrs['gen_ai.system_instructions']).toEqual([
        {type: 'text', content: 'be helpful'},
      ]);
      expect(logAttrs['gen_ai.input.messages']).toEqual([
        {role: 'user', parts: [{type: 'text', content: 'hi'}]},
      ]);
      expect(logAttrs['gen_ai.output.messages']).toEqual([
        {
          role: 'assistant',
          parts: [{type: 'text', content: 'hello'}],
          finish_reason: 'stop',
        },
      ]);

      const spanAttrs = buildCompletionSpanAttributes(
        fullConfig,
        operationDetailsAttrs,
      );
      expect(spanAttrs['gen_ai.system_instructions']).toEqual([
        {type: 'text', content: 'be helpful'},
      ]);
      expect(spanAttrs['gen_ai.input.messages']).toEqual([
        {role: 'user', parts: [{type: 'text', content: 'hi'}]},
      ]);
      expect(spanAttrs['gen_ai.output.messages']).toEqual([
        {
          role: 'assistant',
          parts: [{type: 'text', content: 'hello'}],
          finish_reason: 'stop',
        },
      ]);
    });
  });
});
