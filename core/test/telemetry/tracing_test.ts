/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {traceAgentInvocation, traceToolCall, traceMergedToolCalls, traceCallLlm} from '../../src/telemetry/tracing.js';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {BaseTool} from '../../src/tools/base_tool.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {Event} from '../../src/events/event.js';
import {createEventActions} from '../../src/events/event_actions.js';
import {Session} from '../../src/sessions/session.js';
import {trace} from '@opentelemetry/api';

// Mock OpenTelemetry API
vi.mock('@opentelemetry/api');

describe('Telemetry Tracing Functions', () => {
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
      actions: createEventActions({ skipSummarization: false }),
      timestamp: Date.now(),
      content: {
        parts: [
          {
            functionResponse: {
              id: 'test-call-id',
              response: { result: 'test-result' },
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
      content: { parts: [{ text: 'test-response' }] },
    } as LlmResponse;
  });

  afterEach(() => {
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
      const args = { param1: 'value1', param2: 123 };

      // Act
      traceToolCall({
        tool: mockTool,
        args,
        functionResponseEvent: mockEvent,
      });

      // Assert
      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.description': 'A test tool',
        'gen_ai.tool.name': 'test-tool',
        'gen_ai.tool.type': 'FunctionTool',
        'gcp.vertex.agent.llm_request': '{}',
        'gcp.vertex.agent.llm_response': '{}',
        'gcp.vertex.agent.tool_call_args': expect.stringContaining('param1'),
      });

      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.tool.call.id': 'test-call-id',
        'gcp.vertex.agent.event_id': 'test-event-id',
        'gcp.vertex.agent.tool_response': expect.stringContaining('test-result'),
      });
    });

    it('should handle tool call without function response', () => {
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
      const eventWithoutResponse = {
        id: 'test-event-id',
        invocationId: 'test-invocation-id',
        actions: createEventActions({ skipSummarization: false }),
        timestamp: Date.now(),
        content: { parts: [] },
      } as Event;

      // Act
      traceToolCall({
        tool: mockTool,
        args: {},
        functionResponseEvent: eventWithoutResponse,
      });

      // Assert
      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.tool.call.id': '<not specified>',
        'gcp.vertex.agent.event_id': 'test-event-id',
        'gcp.vertex.agent.tool_response': expect.stringContaining('not specified'),
      });
    });
  });

  describe('traceMergedToolCalls', () => {
    it('should set correct attributes for merged tool calls', () => {
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
      const mockEventWithJson = {
        id: 'merged-event-id',
        invocationId: 'test-invocation-id',
        actions: createEventActions({ skipSummarization: false }),
        timestamp: Date.now(),
        content: {
          parts: [{
            text: 'merged response data'
          }]
        },
        model_dumps_json: vi.fn().mockReturnValue('{"merged": "data"}'),
      };

      // Act
      traceMergedToolCalls({
        responseEventId: 'merged-event-id',
        functionResponseEvent: mockEventWithJson as any,
      });

      // Assert - setAttributes is called without tool_response
      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': '(merged tools)',
        'gen_ai.tool.description': '(merged tools)',
        'gen_ai.tool.call.id': 'merged-event-id',
        'gcp.vertex.agent.tool_call_args': 'N/A',
        'gcp.vertex.agent.event_id': 'merged-event-id',
        'gcp.vertex.agent.llm_request': '{}',
        'gcp.vertex.agent.llm_response': '{}',
      });
      
      // tool_response is set separately via setAttribute
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'gcp.vertex.agent.tool_response',
        expect.any(String)
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
        'gcp.vertex.agent.invocation_id': 'test-invocation-id',
        'gcp.vertex.agent.session_id': 'test-session-id',
        'gcp.vertex.agent.event_id': 'test-event-id',
        'gcp.vertex.agent.llm_request': expect.stringContaining('test-model'),
      });

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.request.top_p', 0.8);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.request.max_tokens', 100);
    });

    it('should handle LLM call without config', () => {
      // Arrange
      vi.mocked(trace.getActiveSpan).mockReturnValue(mockSpan);
      const requestWithoutConfig = { ...mockLlmRequest, config: undefined };

      // Act
      traceCallLlm({
        invocationContext: mockInvocationContext,
        eventId: 'test-event-id',
        llmRequest: requestWithoutConfig,
        llmResponse: mockLlmResponse,
      });

      // Assert
      expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('gen_ai.request.top_p', expect.anything());
      expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('gen_ai.request.max_tokens', expect.anything());
    });
  });
});