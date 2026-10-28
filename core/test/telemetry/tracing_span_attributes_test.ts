/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Asserts the span attributes each instrumentation helper emits, against a real
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
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  recordCallLlm,
  recordCallLlmResponse,
  recordInvocation,
  recordMergedToolCalls,
  recordSendData,
  recordToolExecution,
} from '../../src/telemetry/api/instrumentation.js';

const CAPTURE_ENV = 'ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS';
const INVOCATION_ID = 'invocation-1';
const EVENT_ID = 'event-1';

let exporter: InMemorySpanExporter;
let contextManager: AsyncLocalStorageContextManager;
let provider: BasicTracerProvider;
let originalCaptureEnv: string | undefined;

beforeEach(() => {
  trace.disable();
  context.disable();
  exporter = new InMemorySpanExporter();
  contextManager = new AsyncLocalStorageContextManager().enable();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
  originalCaptureEnv = process.env[CAPTURE_ENV];
  process.env[CAPTURE_ENV] = 'true';
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  contextManager.disable();
  if (originalCaptureEnv === undefined) {
    delete process.env[CAPTURE_ENV];
  } else {
    process.env[CAPTURE_ENV] = originalCaptureEnv;
  }
});

function singleSpan(): ReadableSpan {
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
  describe('recordToolExecution', () => {
    it('sets the tool call arguments, response and event id when legacy span content capture is enabled', async () => {
      const tool = createTestTool();
      await recordToolExecution(
        {toolName: tool.name, invocationContext: createInvocationContext()},
        async (scope) => {
          scope.recordSuccess({
            tool,
            args: {city: 'Paris'},
            functionResponseEvent: createFunctionResponseEvent(),
            rawResult: {result: 'ok'},
          });
        },
      );
      const span = singleSpan();

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

    it('records <not specified> placeholders when tool call id and response are undefined', async () => {
      const emptyEvent = createEvent({
        id: EVENT_ID,
        invocationId: INVOCATION_ID,
        author: 'test-agent',
        content: {parts: []},
      });
      const tool = createTestTool();

      await recordToolExecution(
        {toolName: tool.name, invocationContext: createInvocationContext()},
        async (scope) => {
          scope.recordSuccess({
            tool,
            args: {},
            functionResponseEvent: emptyEvent,
            rawResult: undefined,
          });
        },
      );
      const span = singleSpan();

      expect(span.attributes['gen_ai.tool.call.id']).toBe('<not specified>');
      expect(span.attributes['gcp.vertex.agent.tool_response']).toBe(
        '{"result":"<not specified>"}',
      );
    });
  });

  describe('recordMergedToolCalls', () => {
    it('sets gen_ai.system and gcp.vertex.agent.invocation_id', () => {
      recordMergedToolCalls({
        responseEventId: 'merged-event-id',
        functionResponseEvent: createFunctionResponseEvent(),
        invocationContext: createInvocationContext(),
      });
      const span = singleSpan();

      expect(span.attributes['gen_ai.system']).toBe('gcp.vertex.agent');
      expect(span.attributes['gcp.vertex.agent.invocation_id']).toBe(
        INVOCATION_ID,
      );
    });

    it('records the merged placeholders alongside the identifiers', () => {
      recordMergedToolCalls({
        responseEventId: 'merged-event-id',
        functionResponseEvent: createFunctionResponseEvent(),
        invocationContext: createInvocationContext(),
      });
      const span = singleSpan();

      expect(span.attributes['gen_ai.tool.name']).toBe('(merged tools)');
      expect(span.attributes['gcp.vertex.agent.event_id']).toBe(
        'merged-event-id',
      );
      expect(span.attributes['gcp.vertex.agent.tool_call_args']).toBe('N/A');
      expect(span.attributes['gcp.vertex.agent.llm_request']).toBe('{}');
      expect(span.attributes['gcp.vertex.agent.llm_response']).toBe('{}');
    });
  });

  describe('recordCallLlm', () => {
    it('drops responseSchema from the serialized request', async () => {
      for await (const _ of recordCallLlm(async function* () {
        recordCallLlmResponse({
          invocationContext: createInvocationContext(),
          eventId: EVENT_ID,
          llmRequest: createTestLlmRequest(),
          llmResponse: {},
        });
        yield undefined;
      })) {
        // drain
      }
      const span = singleSpan();

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

    it('strips inlineData parts from the serialized request', async () => {
      const contents: Content[] = [
        {
          role: 'user',
          parts: [
            {text: 'describe this'},
            {inlineData: {mimeType: 'image/png', data: 'AAAA'}},
          ],
        },
      ];

      for await (const _ of recordCallLlm(async function* () {
        recordCallLlmResponse({
          invocationContext: createInvocationContext(),
          eventId: EVENT_ID,
          llmRequest: createTestLlmRequest(contents),
          llmResponse: {},
        });
        yield undefined;
      })) {
        // drain
      }
      const span = singleSpan();

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

  describe('recordSendData', () => {
    it('sets invocation_id, event_id and the serialized content list', async () => {
      const data: Content[] = [{role: 'user', parts: [{text: 'hi'}]}];

      await recordSendData(
        {
          invocationContext: createInvocationContext(),
          eventId: EVENT_ID,
          data,
        },
        async () => {},
      );
      const span = singleSpan();

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

  describe('instrumentation scope', () => {
    it('is named gcp.vertex.agent', async () => {
      for await (const _ of recordInvocation(async function* () {})) {
        // drain
      }
      const span = singleSpan();

      expect(span.instrumentationScope.name).toBe('gcp.vertex.agent');
    });

    it('routes spans to a newly registered provider after trace.disable()', async () => {
      for await (const _ of recordInvocation(async function* () {})) {
        // drain
      }
      expect(exporter.getFinishedSpans()).toHaveLength(1);

      trace.disable();

      const secondExporter = new InMemorySpanExporter();
      const secondProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(secondExporter)],
      });
      trace.setGlobalTracerProvider(secondProvider);
      try {
        for await (const _ of recordInvocation(async function* () {})) {
          // drain
        }
        expect(exporter.getFinishedSpans()).toHaveLength(1);
        expect(secondExporter.getFinishedSpans()).toHaveLength(1);
      } finally {
        await secondProvider.shutdown();
      }
    });
  });
});
