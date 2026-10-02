/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Asserts the span attributes each tracing helper emits, against a real
 * `InMemorySpanExporter`. `tracing_test.ts` covers the same helpers through a
 * mocked span, so it pins the call shape; this file pins the exported span.
 */

import {
  createEvent,
  createSession,
  Event,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
} from '@google/adk';
import {Content} from '@google/genai';
import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  traceCallLlm,
  traceMergedToolCalls,
  tracer,
  traceSendData,
  traceToolCall,
} from '../../src/telemetry/tracing.js';

const CAPTURE_ENV = 'ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS';
const INVOCATION_ID = 'invocation-1';
const EVENT_ID = 'event-1';

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

let originalCaptureEnv: string | undefined;

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  contextManager.disable();
});

beforeEach(() => {
  exporter.reset();
  originalCaptureEnv = process.env[CAPTURE_ENV];
  process.env[CAPTURE_ENV] = 'true';
});

afterEach(() => {
  if (originalCaptureEnv === undefined) {
    delete process.env[CAPTURE_ENV];
  } else {
    process.env[CAPTURE_ENV] = originalCaptureEnv;
  }
});

/** Runs `record` inside a real span and returns the exported span. */
function recordSpan(name: string, record: () => void): ReadableSpan {
  tracer.startActiveSpan(name, (span) => {
    record();
    span.end();
  });
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  return spans[0];
}

function createTestTool(): FunctionTool<undefined> {
  return new FunctionTool({
    name: 'test_tool',
    description: 'A test tool',
    execute: () => ({result: 'ok'}),
  });
}

function createInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: INVOCATION_ID,
    agent: new LlmAgent({name: 'test-agent', description: 'A test agent'}),
    session: createSession({
      id: 'session-1',
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function createFunctionResponseEvent(): Event {
  return createEvent({
    id: EVENT_ID,
    invocationId: INVOCATION_ID,
    author: 'test-agent',
    content: {
      parts: [
        {
          functionResponse: {
            id: 'call-1',
            name: 'test_tool',
            response: {result: 'ok'},
          },
        },
      ],
    },
  });
}

function createTestLlmRequest(contents: Content[] = []): LlmRequest {
  return {
    model: 'test-model',
    contents,
    config: {
      temperature: 0.5,
      responseSchema: {type: 'OBJECT', properties: {answer: {type: 'STRING'}}},
    },
    liveConnectConfig: {},
    toolsDict: {},
  };
}

describe('exported span attributes', () => {
  describe('traceToolCall', () => {
    it('sets gen_ai.system', () => {
      const span = recordSpan('execute_tool test_tool', () =>
        traceToolCall({
          tool: createTestTool(),
          args: {a: 1},
          functionResponseEvent: createFunctionResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(span.attributes['gen_ai.system']).toBe('gcp.vertex.agent');
    });

    it('sets gcp.vertex.agent.invocation_id when the invocation context is given', () => {
      const span = recordSpan('execute_tool test_tool', () =>
        traceToolCall({
          tool: createTestTool(),
          args: {a: 1},
          functionResponseEvent: createFunctionResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(span.attributes['gcp.vertex.agent.invocation_id']).toBe(
        INVOCATION_ID,
      );
    });

    it('records exactly the documented tool attribute set', () => {
      const span = recordSpan('execute_tool test_tool', () =>
        traceToolCall({
          tool: createTestTool(),
          args: {a: 1},
          functionResponseEvent: createFunctionResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(span.attributes).toEqual({
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.description': 'A test tool',
        'gen_ai.tool.name': 'test_tool',
        'gen_ai.tool.type': 'FunctionTool',
        'gen_ai.tool.call.id': 'call-1',
        'gen_ai.system': 'gcp.vertex.agent',
        'gcp.vertex.agent.invocation_id': INVOCATION_ID,
        'gcp.vertex.agent.event_id': EVENT_ID,
        'gcp.vertex.agent.llm_request': '{}',
        'gcp.vertex.agent.llm_response': '{}',
        'gcp.vertex.agent.tool_call_args': '{"a":1}',
        'gcp.vertex.agent.tool_response': '{"result":"ok"}',
      });
    });

    it('keeps the identifying attributes when message content capture is off', () => {
      process.env[CAPTURE_ENV] = 'false';

      const span = recordSpan('execute_tool test_tool', () =>
        traceToolCall({
          tool: createTestTool(),
          args: {a: 1},
          functionResponseEvent: createFunctionResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(span.attributes['gcp.vertex.agent.tool_call_args']).toBe('{}');
      expect(span.attributes['gcp.vertex.agent.tool_response']).toBe('{}');
      expect(span.attributes['gen_ai.system']).toBe('gcp.vertex.agent');
      expect(span.attributes['gcp.vertex.agent.invocation_id']).toBe(
        INVOCATION_ID,
      );
    });

    it('sets the tool call arguments, response and event id', () => {
      const span = recordSpan('execute_tool test_tool', () =>
        traceToolCall({
          tool: createTestTool(),
          args: {city: 'Paris'},
          functionResponseEvent: createFunctionResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(span.attributes['gcp.vertex.agent.tool_call_args']).toBe(
        '{"city":"Paris"}',
      );
      expect(span.attributes['gcp.vertex.agent.tool_response']).toBe(
        '{"result":"ok"}',
      );
      expect(span.attributes['gcp.vertex.agent.event_id']).toBe(EVENT_ID);
      expect(span.attributes['gcp.vertex.agent.llm_request']).toBe('{}');
      expect(span.attributes['gcp.vertex.agent.llm_response']).toBe('{}');
    });
  });

  describe('traceMergedToolCalls', () => {
    it('sets gen_ai.system and gcp.vertex.agent.invocation_id', () => {
      const span = recordSpan('execute_tool (merged)', () =>
        traceMergedToolCalls({
          responseEventId: 'merged-event-id',
          functionResponseEvent: createFunctionResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(span.attributes['gen_ai.system']).toBe('gcp.vertex.agent');
      expect(span.attributes['gcp.vertex.agent.invocation_id']).toBe(
        INVOCATION_ID,
      );
    });

    it('records the merged placeholders alongside the identifiers', () => {
      const span = recordSpan('execute_tool (merged)', () =>
        traceMergedToolCalls({
          responseEventId: 'merged-event-id',
          functionResponseEvent: createFunctionResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(span.attributes['gen_ai.tool.name']).toBe('(merged tools)');
      expect(span.attributes['gcp.vertex.agent.event_id']).toBe(
        'merged-event-id',
      );
      expect(span.attributes['gcp.vertex.agent.tool_call_args']).toBe('N/A');
      expect(span.attributes['gcp.vertex.agent.llm_request']).toBe('{}');
      expect(span.attributes['gcp.vertex.agent.llm_response']).toBe('{}');
    });
  });

  describe('traceCallLlm', () => {
    it('sets the core llm attributes', () => {
      const llmResponse: LlmResponse = {
        content: {role: 'model', parts: [{text: 'hello'}]},
      };

      const span = recordSpan('call_llm', () =>
        traceCallLlm({
          invocationContext: createInvocationContext(),
          eventId: EVENT_ID,
          llmRequest: createTestLlmRequest(),
          llmResponse,
        }),
      );

      expect(span.attributes['gen_ai.system']).toBe('gcp.vertex.agent');
      expect(span.attributes['gen_ai.request.model']).toBe('test-model');
      expect(span.attributes['gcp.vertex.agent.invocation_id']).toBe(
        INVOCATION_ID,
      );
      expect(span.attributes['gcp.vertex.agent.event_id']).toBe(EVENT_ID);
      expect(span.attributes['gcp.vertex.agent.llm_request']).toContain(
        'test-model',
      );
      expect(span.attributes['gcp.vertex.agent.llm_response']).toBe(
        JSON.stringify(llmResponse),
      );
    });

    it('drops responseSchema from the serialized request', () => {
      const span = recordSpan('call_llm', () =>
        traceCallLlm({
          invocationContext: createInvocationContext(),
          eventId: EVENT_ID,
          llmRequest: createTestLlmRequest(),
          llmResponse: {},
        }),
      );

      const serialized = span.attributes['gcp.vertex.agent.llm_request'];
      if (typeof serialized !== 'string') {
        expect.fail('llm_request attribute is not a string');
      }
      const request = JSON.parse(serialized) as {
        config: Record<string, unknown>;
      };
      expect(request.config).not.toHaveProperty('responseSchema');
      expect(request.config.temperature).toBe(0.5);
    });

    it('strips inlineData parts from the serialized request', () => {
      const contents: Content[] = [
        {
          role: 'user',
          parts: [
            {text: 'describe this'},
            {inlineData: {mimeType: 'image/png', data: 'AAAA'}},
          ],
        },
      ];

      const span = recordSpan('call_llm', () =>
        traceCallLlm({
          invocationContext: createInvocationContext(),
          eventId: EVENT_ID,
          llmRequest: createTestLlmRequest(contents),
          llmResponse: {},
        }),
      );

      const serialized = span.attributes['gcp.vertex.agent.llm_request'];
      if (typeof serialized !== 'string') {
        expect.fail('llm_request attribute is not a string');
      }
      const request = JSON.parse(serialized) as {contents: Content[]};
      expect(request.contents).toEqual([
        {role: 'user', parts: [{text: 'describe this'}]},
      ]);
    });
  });

  describe('traceSendData', () => {
    it('sets invocation_id, event_id and the serialized content list', () => {
      const data: Content[] = [{role: 'user', parts: [{text: 'hi'}]}];

      const span = recordSpan('send_data', () =>
        traceSendData({
          invocationContext: createInvocationContext(),
          eventId: EVENT_ID,
          data,
        }),
      );

      expect(span.attributes['gcp.vertex.agent.invocation_id']).toBe(
        INVOCATION_ID,
      );
      expect(span.attributes['gcp.vertex.agent.event_id']).toBe(EVENT_ID);

      const serialized = span.attributes['gcp.vertex.agent.data'];
      if (typeof serialized !== 'string') {
        expect.fail('data attribute is not a string');
      }
      expect(JSON.parse(serialized)).toEqual(data);
    });
  });

  describe('tracer', () => {
    it('is named gcp.vertex.agent', () => {
      const span = recordSpan('any_span', () => {});

      expect(span.instrumentationScope.name).toBe('gcp.vertex.agent');
    });
  });
});
