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
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  createSession,
  Event,
  FunctionTool,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  Runner,
  StreamingMode,
  version,
  Workflow,
} from '@google/adk';
import {ApiError, Content, FinishReason} from '@google/genai';
import {context, SpanStatusCode, trace} from '@opentelemetry/api';
import {logs} from '@opentelemetry/api-logs';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
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
  vi,
} from 'vitest';
import {
  finishInferenceSpan,
  otelLogger,
  startInferenceSpan,
  traceCallLlm,
  traceInferenceResult,
  traceMergedToolCalls,
  tracer,
  traceSendData,
  traceToolCall,
} from '../../src/telemetry/tracing.js';

const CAPTURE_ENV = 'ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS';
const INVOCATION_ID = 'invocation-1';
const EVENT_ID = 'event-1';

const exporter = new InMemorySpanExporter();
const logExporter = new InMemoryLogRecordExporter();
const contextManager = new AsyncLocalStorageContextManager();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const loggerProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({exporter: logExporter})],
});

let originalCaptureEnv: string | undefined;

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  await loggerProvider.shutdown();
  logs.disable();
  trace.disable();
  context.disable();
  contextManager.disable();
});

beforeEach(() => {
  exporter.reset();
  logExporter.reset();
  originalCaptureEnv = process.env[CAPTURE_ENV];
  process.env[CAPTURE_ENV] = 'true';
});

afterEach(() => {
  vi.unstubAllEnvs();
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

function getFinishedSpan(name: string): ReadableSpan {
  const span = exporter.getFinishedSpans().find((s) => s.name === name);
  if (!span) {
    throw new Error(`Expected finished span "${name}" to exist`);
  }
  return span;
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

describe('when no LoggerProvider is registered', () => {
  it('does not throw and still exports the generate_content span', async () => {
    const invocationContext = createInvocationContext();
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [{role: 'user', parts: [{text: 'hello'}]}],
      config: {systemInstruction: 'be helpful'},
      liveConnectConfig: {},
      toolsDict: {},
    };
    const modelResponseEvent = createEvent({
      id: EVENT_ID,
      invocationId: INVOCATION_ID,
      author: 'test-agent',
    });

    const gcSpan = startInferenceSpan({
      llmRequest,
      invocationContext,
      modelResponseEvent,
    });
    traceInferenceResult({
      invocationContext,
      generateContentSpan: gcSpan,
      llmResponse: {
        content: {role: 'model', parts: [{text: 'world'}]},
        finishReason: FinishReason.STOP,
      },
    });
    finishInferenceSpan({
      generateContentSpan: gcSpan,
      invocationContext,
    });

    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(exporter.getFinishedSpans()[0].name).toBe(
      'generate_content gemini-2.5-flash',
    );
    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);

    exporter.reset();
    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'session-no-logger',
    });
    const runner = new Runner({
      appName: 'test-app',
      agent: new LlmAgent({
        name: 'no_logger_agent',
        model: new FakeTestLlm('gemini-2.5-flash', [
          {
            content: {role: 'model', parts: [{text: 'ok'}]},
            finishReason: FinishReason.STOP,
          },
        ]),
      }),
      sessionService,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'test-user',
      sessionId: 'session-no-logger',
      newMessage: {role: 'user', parts: [{text: 'hi'}]},
    })) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);
  });
});

class FakeTestLlm extends BaseLlm {
  private readonly turns: LlmResponse[][];
  private turnIndex = 0;
  private readonly errorToThrow?: Error;

  constructor(
    model: string,
    responsesOrTurns: LlmResponse[] | LlmResponse[][],
    errorToThrow?: Error,
  ) {
    super({model});
    if (responsesOrTurns.length > 0 && Array.isArray(responsesOrTurns[0])) {
      this.turns = responsesOrTurns as LlmResponse[][];
    } else {
      this.turns = [responsesOrTurns as LlmResponse[]];
    }
    this.errorToThrow = errorToThrow;
  }

  override async *generateContentAsync(): AsyncGenerator<
    LlmResponse,
    void,
    void
  > {
    const responses = this.turns[this.turnIndex] ?? [];
    this.turnIndex += 1;
    for (const response of responses) {
      yield response;
    }
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('connect is not used in FakeTestLlm');
  }
}

describe('exported span attributes', () => {
  beforeAll(() => {
    logs.setGlobalLoggerProvider(loggerProvider);
  });
  describe('traceToolCall', () => {
    beforeEach(() => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');
    });

    it('sets gen_ai.agent.name and no gen_ai.system', () => {
      const span = recordSpan('execute_tool test_tool', () =>
        traceToolCall({
          tool: createTestTool(),
          args: {a: 1},
          functionResponseEvent: createFunctionResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(span.attributes['gen_ai.agent.name']).toBe('test-agent');
      expect(span.attributes).not.toHaveProperty('gen_ai.system');
    });

    it('does not set gcp.vertex.agent.invocation_id', () => {
      const span = recordSpan('execute_tool test_tool', () =>
        traceToolCall({
          tool: createTestTool(),
          args: {a: 1},
          functionResponseEvent: createFunctionResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(span.attributes).not.toHaveProperty(
        'gcp.vertex.agent.invocation_id',
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
        'gen_ai.agent.name': 'test-agent',
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
      expect(span.attributes['gen_ai.tool.call.id']).toBe('call-1');
      expect(span.attributes['gcp.vertex.agent.event_id']).toBe(EVENT_ID);
      expect(span.attributes['gen_ai.agent.name']).toBe('test-agent');
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
    beforeEach(() => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');
    });

    it('sets neither gen_ai.system nor gcp.vertex.agent.invocation_id', () => {
      const span = recordSpan('execute_tool (merged)', () =>
        traceMergedToolCalls({
          responseEventId: 'merged-event-id',
          functionResponseEvent: createFunctionResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(span.attributes).not.toHaveProperty('gen_ai.system');
      expect(span.attributes).not.toHaveProperty(
        'gcp.vertex.agent.invocation_id',
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
    beforeEach(() => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');
    });

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

  describe('inference span and log records', () => {
    function runInferenceLifecycle(options?: {
      model?: string;
      userId?: string;
      llmRequest?: Partial<LlmRequest>;
      llmResponse?: LlmResponse;
      error?: unknown;
    }) {
      const invocationContext = createInvocationContext();
      if (options?.userId !== undefined) {
        invocationContext.session.userId = options.userId;
      }
      const model = options?.model ?? 'gemini-2.5-flash';
      const llmRequest: LlmRequest = {
        model,
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
        config: {
          systemInstruction: 'be helpful',
          temperature: 0.7,
          topP: 0.9,
          topK: 40,
          maxOutputTokens: 256,
          candidateCount: 1,
          stopSequences: ['STOP'],
          frequencyPenalty: 0.1,
          presencePenalty: 0.2,
          seed: 42,
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'test_tool',
                  description: 'A test tool',
                  parametersJsonSchema: {type: 'object'},
                },
              ],
            },
          ],
        },
        liveConnectConfig: {},
        toolsDict: {},
        ...options?.llmRequest,
      };
      const modelResponseEvent = createEvent({
        id: EVENT_ID,
        invocationId: INVOCATION_ID,
        author: 'test-agent',
      });
      const llmResponse: LlmResponse = options?.llmResponse ?? {
        modelVersion: 'gemini-2.5-flash-001',
        content: {role: 'model', parts: [{text: 'world'}]},
        finishReason: FinishReason.STOP,
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          cachedContentTokenCount: 2,
          thoughtsTokenCount: 3,
          toolUsePromptTokenCount: 4,
          totalTokenCount: 24,
        },
      };

      tracer.startActiveSpan('call_llm', (callLlmSpan) => {
        const gcSpan = startInferenceSpan({
          llmRequest,
          invocationContext,
          modelResponseEvent,
        });
        if (!options?.error) {
          traceInferenceResult({
            invocationContext,
            generateContentSpan: gcSpan,
            llmResponse,
          });
          finishInferenceSpan({
            generateContentSpan: gcSpan,
            invocationContext,
          });
        } else {
          finishInferenceSpan({
            generateContentSpan: gcSpan,
            invocationContext,
            error: options.error,
          });
        }
        callLlmSpan.end();
      });
    }

    it('emits v2 span and gen_ai.client.inference.operation.details log record with SPAN_AND_EVENT', () => {
      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'false');
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'SPAN_AND_EVENT',
      );

      let spanWasOpenDuringLogExport = false;
      const exportSpy = vi
        .spyOn(logExporter, 'export')
        .mockImplementation((records, resultCallback) => {
          spanWasOpenDuringLogExport = !exporter
            .getFinishedSpans()
            .some((s) => s.name === 'generate_content gemini-2.5-flash');
          logExporter.getFinishedLogRecords().push(...records);
          resultCallback({code: 0});
        });

      try {
        runInferenceLifecycle();
      } finally {
        exportSpy.mockRestore();
      }

      expect(spanWasOpenDuringLogExport).toBe(true);

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(2);
      const gcSpan = getFinishedSpan('generate_content gemini-2.5-flash');
      const callLlmSpan = getFinishedSpan('call_llm');
      expect(gcSpan.parentSpanContext?.spanId).toBe(
        callLlmSpan.spanContext().spanId,
      );

      expect(gcSpan.attributes['gen_ai.operation.name']).toBe(
        'generate_content',
      );
      expect(gcSpan.attributes['gen_ai.provider.name']).toBe('gcp.gemini');
      expect(gcSpan.attributes['gen_ai.request.model']).toBe(
        'gemini-2.5-flash',
      );
      expect(gcSpan.attributes['gen_ai.request.top_p']).toBe(0.9);
      expect(gcSpan.attributes['gen_ai.request.max_tokens']).toBe(256);
      expect(gcSpan.attributes['gen_ai.response.finish_reasons']).toEqual([
        'stop',
      ]);
      expect(gcSpan.attributes['gen_ai.usage.input_tokens']).toBe(14);
      expect(gcSpan.attributes['gen_ai.usage.output_tokens']).toBe(8);
      expect(gcSpan.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(2);
      expect(gcSpan.attributes['gen_ai.usage.reasoning.output_tokens']).toBe(3);
      expect(gcSpan.attributes['gen_ai.conversation.id']).toBe('session-1');
      expect(gcSpan.attributes['gen_ai.agent.name']).toBe('test-agent');
      expect(gcSpan.attributes).not.toHaveProperty('user.id');

      expect(
        JSON.parse(gcSpan.attributes['gen_ai.system_instructions'] as string),
      ).toEqual([{type: 'text', content: 'be helpful'}]);
      expect(
        JSON.parse(gcSpan.attributes['gen_ai.input.messages'] as string),
      ).toEqual([{role: 'user', parts: [{type: 'text', content: 'hello'}]}]);
      expect(
        JSON.parse(gcSpan.attributes['gen_ai.output.messages'] as string),
      ).toEqual([
        {
          role: 'assistant',
          parts: [{type: 'text', content: 'world'}],
          finish_reason: 'stop',
        },
      ]);
      expect(
        JSON.parse(gcSpan.attributes['gen_ai.tool.definitions'] as string),
      ).toEqual([
        {
          type: 'function',
          name: 'test_tool',
          description: 'A test tool',
          parameters: {type: 'object'},
        },
      ]);

      const logRecords = logExporter.getFinishedLogRecords();
      expect(logRecords).toHaveLength(1);
      const record = logRecords[0];
      expect(record.eventName).toBe(
        'gen_ai.client.inference.operation.details',
      );
      expect(record.body).toBeUndefined();
      expect(record.instrumentationScope.name).toBe('gcp.vertex.agent');
      expect(record.instrumentationScope.version).toBe(version);
      expect(record.instrumentationScope.schemaUrl).toBe(
        'https://opentelemetry.io/schemas/1.36.0',
      );
      expect(record.spanContext?.spanId).toBe(gcSpan.spanContext().spanId);
      expect(record.spanContext?.traceId).toBe(gcSpan.spanContext().traceId);
      expect(record.attributes['user.id']).toBe('test-user');
      expect(record.attributes['gen_ai.system_instructions']).toEqual([
        {type: 'text', content: 'be helpful'},
      ]);
      expect(record.attributes['gen_ai.input.messages']).toEqual([
        {role: 'user', parts: [{type: 'text', content: 'hello'}]},
      ]);
      expect(record.attributes['gen_ai.output.messages']).toEqual([
        {
          role: 'assistant',
          parts: [{type: 'text', content: 'world'}],
          finish_reason: 'stop',
        },
      ]);
      expect(record.attributes['gen_ai.tool.definitions']).toEqual([
        {
          type: 'function',
          name: 'test_tool',
          description: 'A test tool',
          parameters: {type: 'object'},
        },
      ]);
    });

    it('omits message content in v2 log record and span when mode is NO_CONTENT (default)', () => {
      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'false');

      runInferenceLifecycle();

      const gcSpan = getFinishedSpan('generate_content gemini-2.5-flash');
      expect(gcSpan.attributes).not.toHaveProperty('gen_ai.input.messages');
      expect(gcSpan.attributes).not.toHaveProperty('gen_ai.output.messages');
      expect(gcSpan.attributes).not.toHaveProperty(
        'gen_ai.system_instructions',
      );
      expect(
        JSON.parse(gcSpan.attributes['gen_ai.tool.definitions'] as string),
      ).toEqual([
        {
          type: 'function',
          name: 'test_tool',
          description: 'A test tool',
          parameters: null,
        },
      ]);

      const logRecords = logExporter.getFinishedLogRecords();
      expect(logRecords).toHaveLength(1);
      const record = logRecords[0];
      expect(record.eventName).toBe(
        'gen_ai.client.inference.operation.details',
      );
      expect(record.body).toBeUndefined();
      expect(record.attributes['gen_ai.provider.name']).toBe('gcp.gemini');
      expect(record.attributes['gen_ai.agent.name']).toBe('test-agent');
      expect(record.attributes['gen_ai.conversation.id']).toBe('session-1');
      expect(record.attributes['gcp.vertex.agent.event_id']).toBe(EVENT_ID);
      expect(record.attributes['gcp.vertex.agent.invocation_id']).toBe(
        INVOCATION_ID,
      );
      expect(record.attributes['gen_ai.response.finish_reasons']).toEqual([
        'stop',
      ]);
      expect(record.attributes['gen_ai.usage.input_tokens']).toBe(14);
      expect(record.attributes['gen_ai.usage.output_tokens']).toBe(8);
      expect(record.attributes).not.toHaveProperty('user.id');
      expect(record.attributes).not.toHaveProperty('gen_ai.input.messages');
      expect(record.attributes).not.toHaveProperty('gen_ai.output.messages');
      expect(record.attributes).not.toHaveProperty(
        'gen_ai.system_instructions',
      );
      expect(record.attributes['gen_ai.tool.definitions']).toEqual([
        {
          type: 'function',
          name: 'test_tool',
          description: 'A test tool',
          parameters: null,
        },
      ]);
    });

    it('captures messages only on the span when mode is SPAN_ONLY', () => {
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'SPAN_ONLY',
      );

      runInferenceLifecycle();

      const gcSpan = getFinishedSpan('generate_content gemini-2.5-flash');
      expect(
        JSON.parse(gcSpan.attributes['gen_ai.input.messages'] as string),
      ).toEqual([{role: 'user', parts: [{type: 'text', content: 'hello'}]}]);
      const logRecords = logExporter.getFinishedLogRecords();
      expect(logRecords).toHaveLength(1);
      expect(logRecords[0].attributes).not.toHaveProperty(
        'gen_ai.input.messages',
      );
      expect(logRecords[0].attributes).not.toHaveProperty('user.id');
    });

    it('captures messages only on the log record when mode is EVENT_ONLY and omits user.id when session.userId is empty', () => {
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'EVENT_ONLY',
      );

      runInferenceLifecycle({userId: ''});

      const gcSpan = getFinishedSpan('generate_content gemini-2.5-flash');
      expect(gcSpan.attributes).not.toHaveProperty('gen_ai.input.messages');
      expect(gcSpan.attributes).not.toHaveProperty('gen_ai.output.messages');

      const logRecords = logExporter.getFinishedLogRecords();
      expect(logRecords).toHaveLength(1);
      expect(logRecords[0].attributes['gen_ai.input.messages']).toEqual([
        {role: 'user', parts: [{type: 'text', content: 'hello'}]},
      ]);
      expect(logRecords[0].attributes).not.toHaveProperty('user.id');
    });

    it('emits v1 log records (system, user, choice) when ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN=1', () => {
      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'false');
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');
      vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'true');

      runInferenceLifecycle();

      const gcSpan = getFinishedSpan('generate_content gemini-2.5-flash');
      expect(gcSpan.attributes['gen_ai.system']).toBe('gemini');
      expect(gcSpan.attributes).not.toHaveProperty('gen_ai.provider.name');

      const logRecords = logExporter.getFinishedLogRecords();
      expect(logRecords).toHaveLength(3);
      expect(logRecords.map((r) => r.eventName)).toEqual([
        'gen_ai.system.message',
        'gen_ai.user.message',
        'gen_ai.choice',
      ]);

      expect(logRecords[0].body).toEqual({
        content: 'be helpful',
      });
      expect(logRecords[0].attributes['gen_ai.system']).toBe('gemini');
      expect(logRecords[0].spanContext?.spanId).toBe(
        gcSpan.spanContext().spanId,
      );

      expect(logRecords[1].body).toEqual({
        content: {role: 'user', parts: [{text: 'hello'}]},
      });
      expect(logRecords[1].attributes['user.id']).toBe('test-user');

      expect(logRecords[2].body).toEqual({
        index: 0,
        finish_reason: FinishReason.STOP,
        content: {role: 'model', parts: [{text: 'world'}]},
      });
    });

    it('elides v1 message content when capture is false', () => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', 'otel_semconv_1_36');
      vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'false');

      runInferenceLifecycle();

      const logRecords = logExporter.getFinishedLogRecords();
      expect(logRecords).toHaveLength(3);
      expect(logRecords[0].body).toEqual({content: '<elided>'});
      expect(logRecords[1].body).toEqual({content: '<elided>'});
      expect(logRecords[1].attributes).not.toHaveProperty('user.id');
      expect(logRecords[2].body).toEqual({
        content: '<elided>',
        index: 0,
        finish_reason: FinishReason.STOP,
      });
    });

    it('uses experimental semconv without gen_ai.provider.name when v1 is paired with OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental', () => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental');
      vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'true');

      runInferenceLifecycle();

      const gcSpan = getFinishedSpan('generate_content gemini-2.5-flash');
      expect(gcSpan.attributes).not.toHaveProperty('gen_ai.provider.name');

      const logRecords = logExporter.getFinishedLogRecords();
      expect(logRecords).toHaveLength(1);
      expect(logRecords[0].eventName).toBe(
        'gen_ai.client.inference.operation.details',
      );
    });

    it('marks the span ERROR without error.type and still emits v2 log record when inference fails', () => {
      const apiError = new ApiError({
        status: 503,
        message: 'service unavailable',
      });
      runInferenceLifecycle({error: apiError});

      const gcSpan = getFinishedSpan('generate_content gemini-2.5-flash');
      expect(gcSpan.attributes).not.toHaveProperty('error.type');
      expect(gcSpan.status.code).toBe(SpanStatusCode.ERROR);
      expect(gcSpan.status.message).toBe('503');
      expect(gcSpan.events.some((e) => e.name === 'exception')).toBe(true);

      const logRecords = logExporter.getFinishedLogRecords();
      expect(logRecords).toHaveLength(1);
      expect(logRecords[0].eventName).toBe(
        'gen_ai.client.inference.operation.details',
      );
      expect(logRecords[0].spanContext?.spanId).toBe(
        gcSpan.spanContext().spanId,
      );
    });

    it('concatenates streamed chunks under v2 and ignores chunks after a reported finish reason', async () => {
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'SPAN_AND_EVENT',
      );

      const fakeLlm = new FakeTestLlm('gemini-2.5-flash', [
        {
          content: {role: 'model', parts: [{text: 'hel'}]},
          partial: true,
        },
        {
          content: {role: 'model', parts: [{text: 'lo'}]},
          partial: true,
          finishReason: FinishReason.FINISH_REASON_UNSPECIFIED,
        },
        {
          modelVersion: 'gemini-2.5-flash-001',
          content: {role: 'model', parts: [{text: '!'}]},
          partial: true,
          finishReason: FinishReason.STOP,
          usageMetadata: {
            promptTokenCount: 8,
            candidatesTokenCount: 4,
            totalTokenCount: 12,
          },
        },
        {
          modelVersion: 'gemini-2.5-flash-001',
          content: {role: 'model', parts: [{text: 'hello!'}]},
          partial: false,
          finishReason: FinishReason.STOP,
        },
      ]);

      const sessionService = new InMemorySessionService();
      await sessionService.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'session-stream',
      });
      const runner = new Runner({
        appName: 'test-app',
        agent: new LlmAgent({
          name: 'stream_agent',
          description: 'Streaming agent',
          instruction: 'respond briefly',
          model: fakeLlm,
        }),
        sessionService,
      });

      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'test-user',
        sessionId: 'session-stream',
        newMessage: {role: 'user', parts: [{text: 'hi'}]},
        runConfig: {streamingMode: StreamingMode.SSE},
      })) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThanOrEqual(2);

      const gcSpans = exporter
        .getFinishedSpans()
        .filter((s) => s.name === 'generate_content gemini-2.5-flash');
      expect(gcSpans).toHaveLength(1);
      expect(gcSpans[0].attributes['gen_ai.usage.input_tokens']).toBe(8);
      expect(gcSpans[0].attributes['gen_ai.usage.output_tokens']).toBe(4);

      const logRecords = logExporter.getFinishedLogRecords();
      expect(logRecords).toHaveLength(1);
      expect(logRecords[0].eventName).toBe(
        'gen_ai.client.inference.operation.details',
      );
      expect(logRecords[0].spanContext?.spanId).toBe(
        gcSpans[0].spanContext().spanId,
      );
      expect(logRecords[0].attributes['gen_ai.output.messages']).toEqual([
        {
          role: 'assistant',
          parts: [{type: 'text', content: 'hel'}],
          finish_reason: '',
        },
        {
          role: 'assistant',
          parts: [{type: 'text', content: 'lo'}],
          finish_reason: '',
        },
        {
          role: 'assistant',
          parts: [{type: 'text', content: '!'}],
          finish_reason: 'stop',
        },
      ]);
    });

    it('emits one gen_ai.choice per streamed chunk up to finishReason under v1 and stops after it', async () => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'EVENT_ONLY',
      );

      const fakeLlm = new FakeTestLlm('gemini-2.5-flash', [
        {
          content: {role: 'model', parts: [{text: 'chunk-1'}]},
          partial: true,
        },
        {
          content: {role: 'model', parts: [{text: 'chunk-2'}]},
          partial: true,
          finishReason: FinishReason.STOP,
        },
        {
          content: {role: 'model', parts: [{text: 'chunk-1chunk-2'}]},
          partial: false,
          finishReason: FinishReason.STOP,
        },
      ]);

      const sessionService = new InMemorySessionService();
      await sessionService.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'session-stream-v1',
      });
      const runner = new Runner({
        appName: 'test-app',
        agent: new LlmAgent({
          name: 'stream_v1_agent',
          instruction: 'be concise',
          model: fakeLlm,
        }),
        sessionService,
      });

      for await (const _event of runner.runAsync({
        userId: 'test-user',
        sessionId: 'session-stream-v1',
        newMessage: {role: 'user', parts: [{text: 'hi'}]},
        runConfig: {streamingMode: StreamingMode.SSE},
      })) {
        // Consume all events
      }

      const choiceRecords = logExporter
        .getFinishedLogRecords()
        .filter((r) => r.eventName === 'gen_ai.choice');
      expect(choiceRecords).toHaveLength(2);
      expect(choiceRecords[0].body).toEqual({
        index: 0,
        content: {role: 'model', parts: [{text: 'chunk-1'}]},
      });
      expect(choiceRecords[1].body).toEqual({
        index: 0,
        finish_reason: FinishReason.STOP,
        content: {role: 'model', parts: [{text: 'chunk-2'}]},
      });
    });

    it('emits no generate_content span and no log records when beforeModelCallback short-circuits', async () => {
      const fakeLlm = new FakeTestLlm('gemini-2.5-flash', [
        {
          content: {role: 'model', parts: [{text: 'from model'}]},
          finishReason: FinishReason.STOP,
        },
      ]);

      const sessionService = new InMemorySessionService();
      await sessionService.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'session-short-circuit',
      });
      const runner = new Runner({
        appName: 'test-app',
        agent: new LlmAgent({
          name: 'short_circuit_agent',
          model: fakeLlm,
          beforeModelCallback: () => ({
            content: {role: 'model', parts: [{text: 'short-circuited'}]},
          }),
        }),
        sessionService,
      });

      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'test-user',
        sessionId: 'session-short-circuit',
        newMessage: {role: 'user', parts: [{text: 'hi'}]},
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].content?.parts?.[0]?.text).toBe('short-circuited');
      expect(
        exporter
          .getFinishedSpans()
          .some((s) => s.name.startsWith('generate_content')),
      ).toBe(false);
      expect(logExporter.getFinishedLogRecords()).toHaveLength(0);
    });

    it('parents generate_content under call_llm and execute_tool under invoke_agent across a 2-turn tool call under v1', async () => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');
      const fakeLlm = new FakeTestLlm('gemini-2.5-flash', [
        [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call-1',
                    name: 'test_tool',
                    args: {},
                  },
                },
              ],
            },
            finishReason: FinishReason.STOP,
          },
        ],
        [
          {
            content: {role: 'model', parts: [{text: 'tool completed'}]},
            finishReason: FinishReason.STOP,
          },
        ],
      ]);

      const sessionService = new InMemorySessionService();
      await sessionService.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'session-tool-turns',
      });
      const runner = new Runner({
        appName: 'test-app',
        agent: new LlmAgent({
          name: 'tool_agent',
          model: fakeLlm,
          tools: [createTestTool()],
        }),
        sessionService,
      });

      for await (const _event of runner.runAsync({
        userId: 'test-user',
        sessionId: 'session-tool-turns',
        newMessage: {role: 'user', parts: [{text: 'run tool'}]},
      })) {
        // Consume all events
      }

      const callLlmSpans = exporter
        .getFinishedSpans()
        .filter((s) => s.name === 'call_llm');
      const gcSpans = exporter
        .getFinishedSpans()
        .filter((s) => s.name === 'generate_content gemini-2.5-flash');
      const toolSpans = exporter
        .getFinishedSpans()
        .filter((s) => s.name === 'execute_tool test_tool');

      expect(callLlmSpans).toHaveLength(2);
      expect(gcSpans).toHaveLength(2);
      expect(toolSpans).toHaveLength(1);

      const callLlmSpanIds = new Set(
        callLlmSpans.map((s) => s.spanContext().spanId),
      );
      const gcSpanIds = new Set(gcSpans.map((s) => s.spanContext().spanId));

      for (const gcSpan of gcSpans) {
        expect(callLlmSpanIds.has(gcSpan.parentSpanContext?.spanId ?? '')).toBe(
          true,
        );
      }
      const agentSpan = getFinishedSpan('invoke_agent tool_agent');
      expect(toolSpans[0].parentSpanContext?.spanId).toBe(
        agentSpan.spanContext().spanId,
      );
      for (const callLlmSpan of callLlmSpans) {
        expect(callLlmSpan.parentSpanContext?.spanId).toBe(
          agentSpan.spanContext().spanId,
        );
      }
      expect(gcSpanIds.has(toolSpans[0].parentSpanContext?.spanId ?? '')).toBe(
        false,
      );

      const gcSpanOrder = gcSpans.map((s) => s.spanContext().spanId);
      expect(
        logExporter
          .getFinishedLogRecords()
          .map((r) => [
            gcSpanOrder.indexOf(r.spanContext?.spanId ?? ''),
            r.eventName,
          ]),
      ).toEqual([
        [0, 'gen_ai.system.message'],
        [0, 'gen_ai.user.message'],
        [0, 'gen_ai.choice'],
        [1, 'gen_ai.system.message'],
        [1, 'gen_ai.user.message'],
        [1, 'gen_ai.user.message'],
        [1, 'gen_ai.user.message'],
        [1, 'gen_ai.choice'],
      ]);
    });

    it('records error on generate_content span and emits log record when LlmAgent model throws', async () => {
      const failingLlm = new FakeTestLlm(
        'gemini-2.5-flash',
        [],
        new TypeError('network failure'),
      );
      const sessionService = new InMemorySessionService();
      await sessionService.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'session-err',
      });
      const runner = new Runner({
        appName: 'test-app',
        agent: new LlmAgent({
          name: 'err_agent',
          model: failingLlm,
        }),
        sessionService,
      });

      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'test-user',
        sessionId: 'session-err',
        newMessage: {role: 'user', parts: [{text: 'hi'}]},
      })) {
        events.push(event);
      }
      expect(events).toHaveLength(1);
      expect(events[0].errorMessage).toBe('network failure');

      const gcSpans = exporter
        .getFinishedSpans()
        .filter((s) => s.name === 'generate_content gemini-2.5-flash');
      expect(gcSpans).toHaveLength(1);
      expect(gcSpans[0].attributes).not.toHaveProperty('error.type');
      expect(gcSpans[0].status).toEqual({
        code: SpanStatusCode.ERROR,
        message: 'TypeError',
      });
      expect(gcSpans[0].events.some((e) => e.name === 'exception')).toBe(true);

      const logRecords = logExporter.getFinishedLogRecords();
      expect(logRecords).toHaveLength(1);
      expect(logRecords[0].eventName).toBe(
        'gen_ai.client.inference.operation.details',
      );
    });

    it('does not mark generate_content span as error when afterModelCallback throws after model stream finishes', async () => {
      const fakeLlm = new FakeTestLlm('gemini-2.5-flash', [
        {
          content: {role: 'model', parts: [{text: 'response without finish'}]},
        },
      ]);
      const sessionService = new InMemorySessionService();
      await sessionService.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'session-after-cb-err',
      });
      const runner = new Runner({
        appName: 'test-app',
        agent: new LlmAgent({
          name: 'after_cb_err_agent',
          model: fakeLlm,
          afterModelCallback: () => {
            throw new Error('afterModelCallback boom');
          },
        }),
        sessionService,
      });

      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'test-user',
        sessionId: 'session-after-cb-err',
        newMessage: {role: 'user', parts: [{text: 'hi'}]},
      })) {
        events.push(event);
      }
      expect(events).toHaveLength(1);
      expect(events[0].errorMessage).toBe('afterModelCallback boom');

      const gcSpans = exporter
        .getFinishedSpans()
        .filter((s) => s.name === 'generate_content gemini-2.5-flash');
      expect(gcSpans).toHaveLength(1);
      expect(gcSpans[0].status.code).toBe(SpanStatusCode.UNSET);
      expect(gcSpans[0].attributes).not.toHaveProperty('error.type');
    });

    it('skips attribute and payload construction when neither span recording nor logger is enabled', () => {
      const realStartSpan = tracer.startSpan.bind(tracer);
      const startSpanSpy = vi
        .spyOn(tracer, 'startSpan')
        .mockImplementation((name, options, ctx) => {
          const span = realStartSpan(name, options, ctx);
          vi.spyOn(span, 'isRecording').mockReturnValue(false);
          return span;
        });
      const enabledSpy = vi.spyOn(otelLogger, 'enabled').mockReturnValue(false);

      try {
        const invocationContext = createInvocationContext();
        const gcSpan = startInferenceSpan({
          llmRequest: {
            model: 'gemini-2.5-flash',
            contents: [{role: 'user', parts: [{text: 'hello'}]}],
            liveConnectConfig: {},
            toolsDict: {},
          },
          invocationContext,
        });

        expect(gcSpan.operationDetailsAttributes).toEqual({});

        traceInferenceResult({
          invocationContext,
          generateContentSpan: gcSpan,
          llmResponse: {
            content: {role: 'model', parts: [{text: 'world'}]},
            finishReason: FinishReason.STOP,
          },
        });

        expect(gcSpan.operationDetailsAttributes).toEqual({});

        finishInferenceSpan({
          generateContentSpan: gcSpan,
          invocationContext,
        });

        expect(logExporter.getFinishedLogRecords()).toHaveLength(0);
      } finally {
        startSpanSpy.mockRestore();
        enabledSpy.mockRestore();
      }
    });

    it('catches unexpected errors thrown while inspecting request or response payloads', () => {
      const invocationContext = createInvocationContext();
      const hostileRequest = {
        model: 'gemini-2.5-flash',
        get contents(): never {
          throw new Error('hostile contents getter');
        },
        liveConnectConfig: {},
        toolsDict: {},
      } as unknown as LlmRequest;

      const gcSpan = startInferenceSpan({
        llmRequest: hostileRequest,
        invocationContext,
      });

      const hostileResponse = {
        get content(): never {
          throw new Error('hostile content getter');
        },
        finishReason: FinishReason.STOP,
      } as unknown as LlmResponse;

      expect(() =>
        traceInferenceResult({
          invocationContext,
          generateContentSpan: gcSpan,
          llmResponse: hostileResponse,
        }),
      ).not.toThrow();

      expect(() =>
        finishInferenceSpan({
          generateContentSpan: gcSpan,
          invocationContext,
        }),
      ).not.toThrow();

      const gcSpans = exporter
        .getFinishedSpans()
        .filter((s) => s.name === 'generate_content gemini-2.5-flash');
      expect(gcSpans).toHaveLength(1);
    });

    it('runs LlmAgent and emits generate_content span and log record when globalThis.process is undefined (browser runtime)', async () => {
      const fakeLlm = new FakeTestLlm('gemini-2.5-flash', [
        {
          content: {role: 'model', parts: [{text: 'browser reply'}]},
          finishReason: FinishReason.STOP,
        },
      ]);
      const sessionService = new InMemorySessionService();
      await sessionService.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'session-browser',
      });
      const runner = new Runner({
        appName: 'test-app',
        agent: new LlmAgent({
          name: 'browser_agent',
          model: fakeLlm,
        }),
        sessionService,
      });

      const savedProcess = globalThis.process;
      Reflect.deleteProperty(globalThis, 'process');
      const events: Event[] = [];
      try {
        for await (const event of runner.runAsync({
          userId: 'test-user',
          sessionId: 'session-browser',
          newMessage: {role: 'user', parts: [{text: 'hello from browser'}]},
        })) {
          events.push(event);
        }
      } finally {
        globalThis.process = savedProcess;
      }

      expect(events).toHaveLength(1);
      expect(events[0].errorCode).toBeUndefined();
      expect(events[0].content?.parts?.[0]?.text).toBe('browser reply');

      const gcSpans = exporter
        .getFinishedSpans()
        .filter((s) => s.name === 'generate_content gemini-2.5-flash');
      expect(gcSpans).toHaveLength(1);
      expect(gcSpans[0].attributes['gen_ai.provider.name']).toBe('gcp.gemini');

      const logRecords = logExporter.getFinishedLogRecords();
      expect(logRecords).toHaveLength(1);
      expect(logRecords[0].eventName).toBe(
        'gen_ai.client.inference.operation.details',
      );
      expect(logRecords[0].attributes['gen_ai.provider.name']).toBe(
        'gcp.gemini',
      );
    });
  });
});

const SECRET = 'secret-token-1';

function createToolResponseEvent(response: Record<string, unknown>): Event {
  return createEvent({
    id: EVENT_ID,
    invocationId: INVOCATION_ID,
    author: 'test-agent',
    content: {
      parts: [
        {
          functionResponse: {id: 'call-1', name: 'test_tool', response},
        },
      ],
    },
  });
}

function createCredentialResponseEvent(): Event {
  return createToolResponseEvent({
    status: 'connected',
    credential: {
      authType: 'oauth2',
      oauth2: {clientId: 'client-1', accessToken: SECRET},
    },
  });
}

function createCyclicResponseEvent(): Event {
  const response: Record<string, unknown> = {status: 'connected'};
  response['self'] = response;
  return createToolResponseEvent(response);
}

class StoredCredential {
  readonly authType = 'oauth2';
  readonly oauth2 = {clientId: 'client-1', accessToken: SECRET};
}

function createClassInstanceResponseEvent(): Event {
  return createToolResponseEvent({
    status: 'connected',
    credential: new StoredCredential(),
  });
}

/** Runs one turn of `agent` in a new session and returns its events. */
async function runTurn(
  agent: LlmAgent,
  sessionId: string,
  options: {stopAfterFirstEvent?: boolean} = {},
): Promise<Event[]> {
  const sessionService = new InMemorySessionService();
  await sessionService.createSession({
    appName: 'test-app',
    userId: 'test-user',
    sessionId,
  });
  const runner = new Runner({appName: 'test-app', agent, sessionService});
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'test-user',
    sessionId,
    newMessage: {role: 'user', parts: [{text: 'run tool'}]},
  })) {
    events.push(event);
    if (options.stopAfterFirstEvent) {
      break;
    }
  }
  return events;
}

function createToolCallingLlm(): FakeTestLlm {
  return new FakeTestLlm('gemini-2.5-flash', [
    [
      {
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'call-1', name: 'test_tool', args: {}}}],
        },
        finishReason: FinishReason.STOP,
      },
    ],
    [
      {
        content: {role: 'model', parts: [{text: 'tool completed'}]},
        finishReason: FinishReason.STOP,
      },
    ],
  ]);
}

describe('schema v2 span attributes', () => {
  describe('traceToolCall', () => {
    it('records no gcp.vertex.agent placeholders', () => {
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
        'gen_ai.agent.name': 'test-agent',
        'gen_ai.tool.call.id': 'call-1',
        'gcp.vertex.agent.event_id': EVENT_ID,
      });
    });

    it.each(['SPAN_ONLY', 'SPAN_AND_EVENT'])(
      'records the tool call arguments and result with %s capture',
      (mode) => {
        vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', mode);

        const span = recordSpan('execute_tool test_tool', () =>
          traceToolCall({
            tool: createTestTool(),
            args: {a: 1},
            functionResponseEvent: createFunctionResponseEvent(),
            invocationContext: createInvocationContext(),
          }),
        );

        expect(span.attributes['gen_ai.tool.call.arguments']).toBe('{"a":1}');
        expect(span.attributes['gen_ai.tool.call.result']).toBe(
          '{"result":"ok"}',
        );
      },
    );

    it.each(['NO_CONTENT', 'EVENT_ONLY'])(
      'records no tool call content with %s capture',
      (mode) => {
        vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', mode);

        const span = recordSpan('execute_tool test_tool', () =>
          traceToolCall({
            tool: createTestTool(),
            args: {a: 1},
            functionResponseEvent: createFunctionResponseEvent(),
            invocationContext: createInvocationContext(),
          }),
        );

        expect(span.attributes).not.toHaveProperty(
          'gen_ai.tool.call.arguments',
        );
        expect(span.attributes).not.toHaveProperty('gen_ai.tool.call.result');
      },
    );

    it('records no result when the tool returned no response', () => {
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'SPAN_ONLY',
      );

      const span = recordSpan('execute_tool test_tool', () =>
        traceToolCall({
          tool: createTestTool(),
          args: {a: 1},
          error: new TypeError('tool failed'),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(span.attributes['gen_ai.tool.call.arguments']).toBe('{"a":1}');
      expect(span.attributes).not.toHaveProperty('gen_ai.tool.call.result');
      expect(span.attributes['error.type']).toBe('TypeError');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });

    it('removes credential secrets from the tool call result', () => {
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'SPAN_ONLY',
      );

      const span = recordSpan('execute_tool test_tool', () =>
        traceToolCall({
          tool: createTestTool(),
          args: {},
          functionResponseEvent: createCredentialResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      const result = span.attributes['gen_ai.tool.call.result'];
      expect(result).not.toContain(SECRET);
      expect(JSON.parse(String(result))).toEqual({
        status: 'connected',
        credential: {authType: 'oauth2', oauth2: {clientId: 'client-1'}},
      });
    });
  });

  it('removes credential secrets from the schema v1 tool response', () => {
    vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');

    const span = recordSpan('execute_tool test_tool', () =>
      traceToolCall({
        tool: createTestTool(),
        args: {},
        functionResponseEvent: createCredentialResponseEvent(),
        invocationContext: createInvocationContext(),
      }),
    );

    const response = span.attributes['gcp.vertex.agent.tool_response'];
    expect(response).not.toContain(SECRET);
    expect(response).toContain('client-1');
  });

  it('records only the function responses, redacted, on the schema v1 merged span', () => {
    vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');

    const span = recordSpan('execute_tool (merged)', () =>
      traceMergedToolCalls({
        responseEventId: 'merged-event-id',
        functionResponseEvent: createCredentialResponseEvent(),
        invocationContext: createInvocationContext(),
      }),
    );

    expect(
      JSON.parse(String(span.attributes['gcp.vertex.agent.tool_response'])),
    ).toEqual([
      {
        id: 'call-1',
        name: 'test_tool',
        response: {
          status: 'connected',
          credential: {authType: 'oauth2', oauth2: {clientId: 'client-1'}},
        },
      },
    ]);
  });

  describe('tool results that cannot be redacted as plain JSON', () => {
    it('records a cyclic tool call result as not serializable', () => {
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'SPAN_ONLY',
      );

      const span = recordSpan('execute_tool test_tool', () =>
        traceToolCall({
          tool: createTestTool(),
          args: {},
          functionResponseEvent: createCyclicResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(span.attributes['gen_ai.tool.call.result']).toBe(
        '<not serializable>',
      );
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
    });

    it('records a cyclic schema v1 tool response as not serializable', () => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');

      const span = recordSpan('execute_tool test_tool', () =>
        traceToolCall({
          tool: createTestTool(),
          args: {},
          functionResponseEvent: createCyclicResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(span.attributes['gcp.vertex.agent.tool_response']).toBe(
        '<not serializable>',
      );
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
    });

    it('records cyclic merged responses as not serializable', () => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');

      const span = recordSpan('execute_tool (merged)', () =>
        traceMergedToolCalls({
          responseEventId: 'merged-event-id',
          functionResponseEvent: createCyclicResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(span.attributes['gcp.vertex.agent.tool_response']).toBe(
        '<not serializable>',
      );
    });

    it('records cyclic merged responses as {} when span content is off', () => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');
      vi.stubEnv('ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS', 'false');

      const span = recordSpan('execute_tool (merged)', () =>
        traceMergedToolCalls({
          responseEventId: 'merged-event-id',
          functionResponseEvent: createCyclicResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(span.attributes['gcp.vertex.agent.tool_response']).toBe('{}');
    });

    it('removes credential secrets held by a class instance from the tool call result', () => {
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
        'SPAN_ONLY',
      );

      const span = recordSpan('execute_tool test_tool', () =>
        traceToolCall({
          tool: createTestTool(),
          args: {},
          functionResponseEvent: createClassInstanceResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      expect(
        JSON.parse(String(span.attributes['gen_ai.tool.call.result'])),
      ).toEqual({
        status: 'connected',
        credential: {authType: 'oauth2', oauth2: {clientId: 'client-1'}},
      });
    });

    it('removes credential secrets held by a class instance from the schema v1 tool response', () => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');

      const span = recordSpan('execute_tool test_tool', () =>
        traceToolCall({
          tool: createTestTool(),
          args: {},
          functionResponseEvent: createClassInstanceResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      const response = span.attributes['gcp.vertex.agent.tool_response'];
      expect(response).not.toContain(SECRET);
      expect(response).toContain('client-1');
    });

    it('removes credential secrets held by a class instance from merged responses', () => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');

      const span = recordSpan('execute_tool (merged)', () =>
        traceMergedToolCalls({
          responseEventId: 'merged-event-id',
          functionResponseEvent: createClassInstanceResponseEvent(),
          invocationContext: createInvocationContext(),
        }),
      );

      const response = span.attributes['gcp.vertex.agent.tool_response'];
      expect(response).not.toContain(SECRET);
      expect(response).toContain('client-1');
    });
  });

  it('records only the identifiers on the merged span', () => {
    const span = recordSpan('execute_tool (merged)', () =>
      traceMergedToolCalls({
        responseEventId: 'merged-event-id',
        functionResponseEvent: createFunctionResponseEvent(),
        invocationContext: createInvocationContext(),
      }),
    );

    expect(span.attributes).toEqual({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': '(merged tools)',
      'gen_ai.tool.description': '(merged tools)',
      'gen_ai.tool.call.id': 'merged-event-id',
      'gcp.vertex.agent.event_id': 'merged-event-id',
    });
  });

  it('makes traceCallLlm a no-op', () => {
    const span = recordSpan('some_span', () =>
      traceCallLlm({
        invocationContext: createInvocationContext(),
        eventId: EVENT_ID,
        llmRequest: createTestLlmRequest(),
        llmResponse: {finishReason: FinishReason.STOP},
      }),
    );

    expect(span.attributes).toEqual({});
  });
});

describe('span tree of a runner turn', () => {
  it('parents generate_content and execute_tool under invoke_agent under v2', async () => {
    await runTurn(
      new LlmAgent({
        name: 'tool_agent',
        model: createToolCallingLlm(),
        tools: [createTestTool()],
      }),
      'session-v2-tree',
    );

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual([
      'execute_tool test_tool',
      'generate_content gemini-2.5-flash',
      'generate_content gemini-2.5-flash',
      'invoke_agent tool_agent',
      'invoke_workflow tool_agent',
    ]);
    const root = getFinishedSpan('invoke_workflow tool_agent');
    expect(root.parentSpanContext).toBeUndefined();
    expect(root.attributes).toEqual({
      'gen_ai.operation.name': 'invoke_workflow',
      'gen_ai.conversation.id': 'session-v2-tree',
      'gen_ai.workflow.name': 'tool_agent',
    });
    const agentSpan = getFinishedSpan('invoke_agent tool_agent');
    expect(agentSpan.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    for (const span of spans.filter(
      (s) => s.name !== 'invoke_agent tool_agent' && s !== root,
    )) {
      expect(span.parentSpanContext?.spanId).toBe(
        agentSpan.spanContext().spanId,
      );
    }

    const logRecords = logExporter.getFinishedLogRecords();
    expect(logRecords).toHaveLength(2);
    expect(logRecords.map((r) => r.spanContext?.spanId)).toEqual(
      spans
        .filter((s) => s.name === 'generate_content gemini-2.5-flash')
        .map((s) => s.spanContext().spanId),
    );
  });

  it('records the emitted function response event id on execute_tool', async () => {
    const events = await runTurn(
      new LlmAgent({
        name: 'tool_agent',
        model: createToolCallingLlm(),
        tools: [createTestTool()],
      }),
      'session-tool-event',
    );

    const functionResponseEvent = events.find((event) =>
      event.content?.parts?.some((part) => part.functionResponse),
    );
    expect(functionResponseEvent).toBeDefined();
    expect(
      getFinishedSpan('execute_tool test_tool').attributes[
        'gcp.vertex.agent.event_id'
      ],
    ).toBe(functionResponseEvent?.id);
  });

  it.each([
    {schema: '1', root: 'invocation'},
    {schema: '2', root: 'invoke_workflow failing_agent'},
  ])(
    'marks invoke_agent and the $root root ERROR when an error escapes',
    async ({schema, root}) => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', schema);
      const agent = new LlmAgent({
        name: 'failing_agent',
        model: createToolCallingLlm(),
        beforeAgentCallback: () => {
          throw new RangeError(`callback failed with ${SECRET}`);
        },
      });

      await expect(runTurn(agent, `session-error-v${schema}`)).rejects.toThrow(
        RangeError,
      );

      for (const name of [root, 'invoke_agent failing_agent']) {
        const span = getFinishedSpan(name);
        expect(span.status).toEqual({
          code: SpanStatusCode.ERROR,
          message: 'RangeError',
        });
        expect(span.events.some((e) => e.name === 'exception')).toBe(true);
      }
    },
  );

  it('does not mark the root ERROR when the consumer stops early', async () => {
    await runTurn(
      new LlmAgent({
        name: 'tool_agent',
        model: createToolCallingLlm(),
        tools: [createTestTool()],
      }),
      'session-early-stop',
      {stopAfterFirstEvent: true},
    );

    expect(getFinishedSpan('invoke_workflow tool_agent').status.code).toBe(
      SpanStatusCode.UNSET,
    );
  });

  it('records the call_llm attributes under v1 when a before-model callback answers', async () => {
    vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');
    const events = await runTurn(
      new LlmAgent({
        name: 'short_circuit_agent',
        model: createToolCallingLlm(),
        beforeModelCallback: () => ({
          content: {role: 'model', parts: [{text: 'short-circuited'}]},
        }),
      }),
      'session-callback-v1',
    );

    expect(events).toHaveLength(1);
    expect(getFinishedSpan('call_llm').attributes).toMatchObject({
      'gen_ai.system': 'gcp.vertex.agent',
      'gcp.vertex.agent.event_id': events[0].id,
    });
  });

  it('runs a transferred agent as a sibling of the transferring agent', async () => {
    vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');
    const model = new FakeTestLlm('gemini-2.5-flash', [
      [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'transfer_to_agent',
                  args: {agent_name: 'specialist'},
                },
              },
            ],
          },
          finishReason: FinishReason.STOP,
        },
      ],
      [
        {
          content: {role: 'model', parts: [{text: 'done'}]},
          finishReason: FinishReason.STOP,
        },
      ],
    ]);
    await runTurn(
      new LlmAgent({
        name: 'coordinator',
        model,
        subAgents: [new LlmAgent({name: 'specialist', model})],
      }),
      'session-transfer',
    );

    const root = getFinishedSpan('invocation');
    for (const name of [
      'invoke_agent coordinator',
      'invoke_agent specialist',
    ]) {
      expect(getFinishedSpan(name).parentSpanContext?.spanId).toBe(
        root.spanContext().spanId,
      );
    }
  });

  it('runs an agent transferred to inside a nested workflow under that workflow', async () => {
    const model = new FakeTestLlm('gemini-2.5-flash', [
      [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'transfer_to_agent',
                  args: {agent_name: 'specialist'},
                },
              },
            ],
          },
          finishReason: FinishReason.STOP,
        },
      ],
      [
        {
          content: {role: 'model', parts: [{text: 'done'}]},
          finishReason: FinishReason.STOP,
        },
      ],
    ]);
    const nested = new Workflow({
      name: 'inner_workflow',
      edges: [
        [
          'START',
          new LlmAgent({
            name: 'coordinator',
            model,
            subAgents: [new LlmAgent({name: 'specialist', model})],
          }),
        ],
      ],
    });
    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'session-nested-transfer',
    });
    const runner = new Runner({
      appName: 'test-app',
      agent: new Workflow({name: 'outer_workflow', edges: [['START', nested]]}),
      sessionService,
    });
    for await (const _event of runner.runAsync({
      userId: 'test-user',
      sessionId: 'session-nested-transfer',
      newMessage: {role: 'user', parts: [{text: 'run tool'}]},
    })) {
      // Consume all events
    }

    const nestedSpan = getFinishedSpan('invoke_workflow inner_workflow');
    for (const name of [
      'invoke_agent coordinator',
      'invoke_agent specialist',
    ]) {
      expect(getFinishedSpan(name).parentSpanContext?.spanId).toBe(
        nestedSpan.spanContext().spanId,
      );
    }
  });
});
