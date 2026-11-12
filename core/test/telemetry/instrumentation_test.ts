/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApiError,
  Content,
  FinishReason,
  GenerateContentResponseUsageMetadata,
  Type,
} from '@google/genai';
import {
  type Attributes,
  context,
  metrics,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import {type Logger, logs, SeverityNumber} from '@opentelemetry/api-logs';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  DataPointType,
  MeterProvider,
  type MetricData,
  MetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
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
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  createSession,
  Event,
  FunctionNode,
  FunctionTool,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  runWithAgentEngineContext,
  type TelemetryConfig,
  ToolErrorType,
  ToolExecutionError,
  Workflow,
} from '@google/adk';
import {createCompactedEvent} from '../../src/events/compacted_event.js';
import {ContextCompactionTrigger} from '../../src/plugins/base_plugin.js';
import {
  instrumentMcpFetch,
  type McpFetch,
  recordAgentInvocation,
  recordCompaction,
  recordInference,
  recordInvocation,
  recordMergedToolCalls,
  recordNodeInvocation,
  recordSendData,
  recordSkillActivity,
  recordToolExecution,
  recordWorkflowInvocation,
  type ToolExecutionScope,
} from '../../src/telemetry/api/instrumentation.js';
import {logger} from '../../src/utils/logger.js';
import {version} from '../../src/version.js';

const CAPTURE_ENV = 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT';
const INFERENCE_EVENT = 'gen_ai.client.inference.operation.details';
const INVOCATION_ID = 'invocation-1';
const SESSION_ID = 'session-1';
const USER_ID = 'user-1';
const EVENT_ID = 'event-1';
const MODEL = 'gemini-flash-latest';

const USAGE: GenerateContentResponseUsageMetadata = {
  promptTokenCount: 100,
  toolUsePromptTokenCount: 3,
  cachedContentTokenCount: 40,
  candidatesTokenCount: 20,
  thoughtsTokenCount: 5,
};

const spanExporter = new InMemorySpanExporter();
const logExporter = new InMemoryLogRecordExporter();
const contextManager = new AsyncLocalStorageContextManager();
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
const loggerProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({exporter: logExporter})],
});

/** Reads metrics on demand, each collection holding only what is new. */
class DeltaMetricReader extends MetricReader {
  constructor() {
    super({
      aggregationTemporalitySelector: () => AggregationTemporality.DELTA,
    });
  }

  protected override async onForceFlush(): Promise<void> {}

  protected override async onShutdown(): Promise<void> {}
}

const metricReader = new DeltaMetricReader();
const meterProvider = new MeterProvider({readers: [metricReader]});

// The providers are registered only after the instrumentation module has been
// imported, as an application that sets up OpenTelemetry after ADK would.
beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(tracerProvider);
  logs.setGlobalLoggerProvider(loggerProvider);
  metrics.setGlobalMeterProvider(meterProvider);
});

afterAll(async () => {
  await tracerProvider.shutdown();
  await loggerProvider.shutdown();
  await meterProvider.shutdown();
  trace.disable();
  logs.disable();
  metrics.disable();
  context.disable();
  contextManager.disable();
});

beforeEach(async () => {
  spanExporter.reset();
  logExporter.reset();
  await metricReader.collect();
  vi.stubEnv(CAPTURE_ENV, undefined);
  vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY', undefined);
  vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', undefined);
  vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', undefined);
  vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', undefined);
  vi.stubEnv('ADK_TELEMETRY_IGNORE_RUN_CONFIG', undefined);
  vi.stubEnv('ADK_CAPTURE_MCP_HTTP_BODIES', undefined);
  vi.stubEnv(
    'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_REQUEST',
    undefined,
  );
  vi.stubEnv(
    'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_RESPONSE',
    undefined,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function spansNamed(name: string): ReadableSpan[] {
  return spanExporter.getFinishedSpans().filter((span) => span.name === name);
}

function onlySpan(name: string): ReadableSpan {
  const spans = spansNamed(name);
  expect(spans).toHaveLength(1);
  return spans[0];
}

function inferenceLogs(): ReadableLogRecord[] {
  return logExporter
    .getFinishedLogRecords()
    .filter((record) => record.eventName === INFERENCE_EVENT);
}

function parseJsonAttribute(span: ReadableSpan, key: string): unknown {
  const value = span.attributes[key];
  if (typeof value !== 'string') {
    expect.fail(`${key} is not a JSON string attribute`);
  }
  return JSON.parse(value);
}

function createInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: INVOCATION_ID,
    agent: new LlmAgent({name: 'test_agent', description: 'A test agent'}),
    session: createSession({
      id: SESSION_ID,
      appName: 'test-app',
      userId: USER_ID,
    }),
    pluginManager: new PluginManager([]),
  });
}

function createLlmRequest(): LlmRequest {
  return {
    model: MODEL,
    contents: [{role: 'user', parts: [{text: 'hello'}]}],
    config: {
      systemInstruction: 'be brief',
      topP: 0.5,
      maxOutputTokens: 64,
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Gets the weather.',
              parameters: {
                type: Type.OBJECT,
                properties: {city: {type: Type.STRING}},
              },
            },
          ],
        },
      ],
    },
    liveConnectConfig: {},
    toolsDict: {},
  };
}

function textResponse(
  text: string,
  options: {finishReason?: FinishReason; partial?: boolean} = {},
): LlmResponse {
  return {
    content: {role: 'model', parts: [{text}]},
    usageMetadata: USAGE,
    finishReason: options.finishReason,
    partial: options.partial,
  };
}

async function* streamOf(
  responses: readonly LlmResponse[],
): AsyncGenerator<LlmResponse, void, void> {
  for (const response of responses) {
    yield response;
  }
}

function inferenceParams() {
  return {
    invocationContext: createInvocationContext(),
    llmRequest: createLlmRequest(),
    modelResponseEvent: createEvent({id: EVENT_ID, author: 'test_agent'}),
  };
}

async function drain<T>(generator: AsyncGenerator<T, void, void>) {
  const items: T[] = [];
  for await (const item of generator) {
    items.push(item);
  }
  return items;
}

describe('recordInference', () => {
  it('ends the span before the caller receives the finish-reason response', async () => {
    const seenWhenReceived: number[] = [];
    for await (const _ of recordInference(inferenceParams(), () =>
      streamOf([
        textResponse('part', {partial: true}),
        textResponse('done', {finishReason: FinishReason.STOP}),
      ]),
    )) {
      seenWhenReceived.push(spansNamed(`generate_content ${MODEL}`).length);
    }

    expect(seenWhenReceived).toEqual([0, 1]);
  });

  it('does not make the span current while the caller handles a response', async () => {
    for await (const _ of recordInference(inferenceParams(), () =>
      streamOf([textResponse('part', {partial: true})]),
    )) {
      expect(trace.getActiveSpan()).toBeUndefined();
    }
  });

  it('records the request, provider, finish reason and token usage', async () => {
    await drain(
      recordInference(inferenceParams(), () =>
        streamOf([textResponse('done', {finishReason: FinishReason.STOP})]),
      ),
    );

    expect(onlySpan(`generate_content ${MODEL}`).attributes).toMatchObject({
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.request.model': MODEL,
      'gen_ai.request.top_p': 0.5,
      'gen_ai.request.max_tokens': 64,
      'gen_ai.agent.name': 'test_agent',
      'gen_ai.conversation.id': SESSION_ID,
      'gcp.vertex.agent.event_id': EVENT_ID,
      'gcp.vertex.agent.invocation_id': INVOCATION_ID,
      'gen_ai.provider.name': 'gcp.gemini',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 103,
      'gen_ai.usage.output_tokens': 25,
      'gen_ai.usage.cache_read.input_tokens': 40,
      'gen_ai.usage.reasoning.output_tokens': 5,
    });
  });

  it('names the Vertex AI provider in enterprise mode', async () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');

    await drain(
      recordInference(inferenceParams(), () =>
        streamOf([textResponse('done', {finishReason: FinishReason.STOP})]),
      ),
    );

    expect(
      onlySpan(`generate_content ${MODEL}`).attributes['gen_ai.provider.name'],
    ).toBe('gcp.vertex_ai');
  });

  it('names the Gemini provider where there is no process global', async () => {
    // A browser or worker has no `process` global; deleting the property
    // reproduces the ReferenceError an unguarded `process` access throws.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
    Reflect.deleteProperty(globalThis, 'process');
    try {
      await drain(
        recordInference(inferenceParams(), () =>
          streamOf([textResponse('done', {finishReason: FinishReason.STOP})]),
        ),
      );
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'process', descriptor);
      }
    }

    expect(
      onlySpan(`generate_content ${MODEL}`).attributes['gen_ai.provider.name'],
    ).toBe('gcp.gemini');
  });

  it('emits exactly one log record per call, parented to the span', async () => {
    await drain(
      recordInference(inferenceParams(), () =>
        streamOf([
          textResponse('part', {partial: true}),
          textResponse('done', {finishReason: FinishReason.STOP}),
        ]),
      ),
    );

    const span = onlySpan(`generate_content ${MODEL}`);
    const records = inferenceLogs();
    expect(records).toHaveLength(1);
    expect(records[0].body).toBeUndefined();
    expect(records[0].spanContext?.spanId).toBe(span.spanContext().spanId);
    expect(records[0].attributes).toMatchObject({
      'gen_ai.agent.name': 'test_agent',
      'gen_ai.provider.name': 'gcp.gemini',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 103,
    });
  });

  it('passes responses after the finish reason through without recording them', async () => {
    const responses = await drain(
      recordInference(inferenceParams(), () =>
        streamOf([
          textResponse('done', {finishReason: FinishReason.STOP}),
          textResponse('aggregate', {finishReason: FinishReason.MAX_TOKENS}),
        ]),
      ),
    );

    expect(responses).toHaveLength(2);
    expect(inferenceLogs()).toHaveLength(1);
    expect(
      onlySpan(`generate_content ${MODEL}`).attributes[
        'gen_ai.response.finish_reasons'
      ],
    ).toEqual(['stop']);
  });

  it('ends the span and emits one record when the caller stops early', async () => {
    for await (const _ of recordInference(inferenceParams(), () =>
      streamOf([
        textResponse('one', {partial: true}),
        textResponse('two', {partial: true}),
      ]),
    )) {
      break;
    }

    const span = onlySpan(`generate_content ${MODEL}`);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(inferenceLogs()).toHaveLength(1);
  });

  it('ends the span when the stream ends without a finish reason', async () => {
    await drain(
      recordInference(inferenceParams(), () =>
        streamOf([textResponse('one', {partial: true})]),
      ),
    );

    expect(spansNamed(`generate_content ${MODEL}`)).toHaveLength(1);
    expect(inferenceLogs()).toHaveLength(1);
  });

  it('marks a model error on the span without an error.type, and emits one record', async () => {
    const error = new ApiError({status: 429, message: 'quota for user-1'});

    await expect(
      drain(
        recordInference(inferenceParams(), async function* () {
          yield* [];
          throw error;
        }),
      ),
    ).rejects.toBe(error);

    const span = onlySpan(`generate_content ${MODEL}`);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).not.toContain('user-1');
    expect(span.attributes).not.toHaveProperty('error.type');
    expect(span.attributes['gen_ai.request.model']).toBe(MODEL);
    expect(inferenceLogs()).toHaveLength(1);
    expect(inferenceLogs()[0].attributes).not.toHaveProperty('error.type');
  });

  it('opens no span when a before-model callback answers', async () => {
    class UnusedModel extends BaseLlm {
      constructor() {
        super({model: MODEL});
      }
      override async *generateContentAsync(): AsyncGenerator<
        LlmResponse,
        void
      > {
        yield* [];
        throw new Error('The model must not be called.');
      }
      override async connect(): Promise<BaseLlmConnection> {
        throw new Error('Live connections are not supported.');
      }
    }
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new UnusedModel(),
      beforeModelCallback: () => textResponse('cached'),
    });
    const runner = new InMemoryRunner({agent, appName: 'test-app'});
    const session = await runner.sessionService.createSession({
      appName: 'test-app',
      userId: USER_ID,
    });

    await drain(
      runner.runAsync({
        userId: USER_ID,
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'hello'}]},
      }),
    );

    expect(onlySpan('invoke_agent test_agent')).toBeDefined();
    expect(spansNamed(`generate_content ${MODEL}`)).toEqual([]);
    expect(inferenceLogs()).toEqual([]);
  });
});

describe('content capture', () => {
  async function recordOneCall(): Promise<{
    span: ReadableSpan;
    record: ReadableLogRecord;
  }> {
    spanExporter.reset();
    logExporter.reset();
    await drain(
      recordInference(inferenceParams(), () =>
        streamOf([textResponse('done', {finishReason: FinishReason.STOP})]),
      ),
    );
    const records = inferenceLogs();
    expect(records).toHaveLength(1);
    return {span: onlySpan(`generate_content ${MODEL}`), record: records[0]};
  }

  const CONTENT_KEYS = [
    'gen_ai.input.messages',
    'gen_ai.output.messages',
    'gen_ai.system_instructions',
  ];

  it.each([
    {value: undefined, onSpan: false, onLog: false},
    {value: 'NO_CONTENT', onSpan: false, onLog: false},
    {value: 'EVENT_ONLY', onSpan: false, onLog: true},
    {value: 'SPAN_ONLY', onSpan: true, onLog: false},
    {value: 'SPAN_AND_EVENT', onSpan: true, onLog: true},
    {value: ' span_and_event ', onSpan: true, onLog: true},
    {value: 'true', onSpan: false, onLog: true},
    {value: '1', onSpan: false, onLog: true},
    {value: 'yes', onSpan: false, onLog: false},
  ])(
    'routes message content for $value (span: $onSpan, log: $onLog)',
    async ({value, onSpan, onLog}) => {
      vi.stubEnv(CAPTURE_ENV, value);

      const {span, record} = await recordOneCall();

      for (const key of CONTENT_KEYS) {
        expect(key in span.attributes).toBe(onSpan);
        expect(key in (record.attributes ?? {})).toBe(onLog);
      }
      expect(USER_ID === record.attributes?.['user.id']).toBe(onLog);
      expect(span.attributes).not.toHaveProperty('user.id');
    },
  );

  it('keeps tool definitions without parameter schemas when content is off', async () => {
    const {span, record} = await recordOneCall();

    const withoutSchemas = [
      {
        name: 'get_weather',
        description: 'Gets the weather.',
        type: 'function',
      },
    ];
    expect(parseJsonAttribute(span, 'gen_ai.tool.definitions')).toEqual(
      withoutSchemas,
    );
    expect(record.attributes?.['gen_ai.tool.definitions']).toEqual(
      withoutSchemas,
    );
  });

  it('records messages in the GenAI semantic-convention shape', async () => {
    vi.stubEnv(CAPTURE_ENV, 'SPAN_ONLY');

    const {span} = await recordOneCall();

    expect(parseJsonAttribute(span, 'gen_ai.input.messages')).toEqual([
      {role: 'user', parts: [{content: 'hello', type: 'text'}]},
    ]);
    expect(parseJsonAttribute(span, 'gen_ai.system_instructions')).toEqual([
      {content: 'be brief', type: 'text'},
    ]);
    expect(parseJsonAttribute(span, 'gen_ai.output.messages')).toEqual([
      {
        role: 'assistant',
        parts: [{content: 'done', type: 'text'}],
        finish_reason: 'stop',
      },
    ]);
  });

  it('serializes functionResponse byte parts and replaces bigint values', async () => {
    vi.stubEnv(CAPTURE_ENV, 'SPAN_ONLY');
    const params = inferenceParams();
    params.llmRequest.contents = [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'test_function_1',
              response: {
                result: new Uint8Array([116, 101, 115, 116]),
                nonSerializableBigInt: BigInt(42),
              },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'test_function_2',
              response: {
                result: {
                  inlineData: {
                    data: Buffer.from('test_data').toString('base64'),
                    mimeType: 'application/octet-stream',
                  },
                },
              },
            },
          },
        ],
      },
    ];

    await drain(
      recordInference(params, () =>
        streamOf([textResponse('done', {finishReason: FinishReason.STOP})]),
      ),
    );

    const span = onlySpan(`generate_content ${MODEL}`);
    const messages = parseJsonAttribute(
      span,
      'gen_ai.input.messages',
    ) as Array<{
      parts: Array<{response: Record<string, unknown>}>;
    }>;
    expect(messages).toHaveLength(2);
    expect(messages[0].parts[0].response['nonSerializableBigInt']).toBe(
      '<not serializable>',
    );
    expect(
      (
        messages[1].parts[0].response['result'] as {
          inlineData: {mimeType: string};
        }
      ).inlineData.mimeType,
    ).toBe('application/octet-stream');
  });

  it('does not copy inline data bytes into the messages', async () => {
    vi.stubEnv(CAPTURE_ENV, 'SPAN_ONLY');
    const params = inferenceParams();
    params.llmRequest.contents = [
      {
        role: 'user',
        parts: [{inlineData: {mimeType: 'image/png', data: 'c2VjcmV0'}}],
      },
    ];

    await drain(
      recordInference(params, () =>
        streamOf([textResponse('done', {finishReason: FinishReason.STOP})]),
      ),
    );

    const span = onlySpan(`generate_content ${MODEL}`);
    expect(span.attributes['gen_ai.input.messages']).not.toContain('c2VjcmV0');
    expect(parseJsonAttribute(span, 'gen_ai.input.messages')).toEqual([
      {role: 'user', parts: [{mime_type: 'image/png', type: 'blob'}]},
    ]);
  });

  it('reads the environment on each call', async () => {
    vi.stubEnv(CAPTURE_ENV, 'SPAN_ONLY');
    const first = await recordOneCall();
    vi.stubEnv(CAPTURE_ENV, 'NO_CONTENT');
    const second = await recordOneCall();

    expect(first.span.attributes).toHaveProperty('gen_ai.input.messages');
    expect(second.span.attributes).not.toHaveProperty('gen_ai.input.messages');
  });

  it('records grounding only when the grounding feature is enabled', async () => {
    const grounded: LlmResponse = {
      ...textResponse('done', {finishReason: FinishReason.STOP}),
      groundingMetadata: {
        webSearchQueries: ['adk'],
        groundingChunks: [{web: {uri: 'https://a.test/1'}}],
      },
    };
    await drain(recordInference(inferenceParams(), () => streamOf([grounded])));
    expect(
      Object.keys(onlySpan(`generate_content ${MODEL}`).attributes).filter(
        (key) => key.startsWith('adk.experimental.grounding'),
      ),
    ).toEqual([]);

    spanExporter.reset();
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'grounding');
    await drain(recordInference(inferenceParams(), () => streamOf([grounded])));
    expect(onlySpan(`generate_content ${MODEL}`).attributes).toMatchObject({
      'adk.experimental.grounding.query_count': 1,
      'adk.experimental.grounding.chunk_count': 1,
    });
  });
});

describe('telemetry logger and tracer', () => {
  it('uses the ADK instrumentation scope, version and schema URL', async () => {
    await drain(
      recordInference(inferenceParams(), () =>
        streamOf([textResponse('done', {finishReason: FinishReason.STOP})]),
      ),
    );

    const [record] = inferenceLogs();
    expect(record.instrumentationScope).toEqual({
      name: 'gcp.vertex.agent',
      version,
      schemaUrl: 'https://opentelemetry.io/schemas/1.44.0',
    });
    expect(onlySpan(`generate_content ${MODEL}`).instrumentationScope).toEqual({
      name: 'gcp.vertex.agent',
      version,
      schemaUrl: 'https://opentelemetry.io/schemas/1.44.0',
    });
  });

  it('reaches a logger provider registered after earlier records were emitted', async () => {
    const lateExporter = new InMemoryLogRecordExporter();
    const lateProvider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({exporter: lateExporter})],
    });
    logs.disable();
    logs.setGlobalLoggerProvider(lateProvider);
    try {
      await drain(
        recordInference(inferenceParams(), () =>
          streamOf([textResponse('done', {finishReason: FinishReason.STOP})]),
        ),
      );
      expect(lateExporter.getFinishedLogRecords()).toHaveLength(1);
      expect(inferenceLogs()).toEqual([]);
    } finally {
      await lateProvider.shutdown();
      logs.disable();
      logs.setGlobalLoggerProvider(loggerProvider);
    }
  });

  it('routes spans to a newly registered tracer provider after trace.disable()', async () => {
    const agent = new LlmAgent({name: 'root_agent'});
    await drain(
      recordInvocation(
        {entrypoint: agent, sessionId: SESSION_ID},
        async function* () {
          yield* [];
        },
      ),
    );
    expect(spanExporter.getFinishedSpans()).toHaveLength(1);

    const lateExporter = new InMemorySpanExporter();
    const lateProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(lateExporter)],
    });
    trace.disable();
    trace.setGlobalTracerProvider(lateProvider);
    try {
      await drain(
        recordInvocation(
          {entrypoint: agent, sessionId: SESSION_ID},
          async function* () {
            yield* [];
          },
        ),
      );
      expect(spanExporter.getFinishedSpans()).toHaveLength(1);
      expect(lateExporter.getFinishedSpans()).toHaveLength(1);
    } finally {
      await lateProvider.shutdown();
      trace.disable();
      trace.setGlobalTracerProvider(tracerProvider);
    }
  });
});

describe('recordToolExecution', () => {
  function createTool(): FunctionTool<undefined> {
    return new FunctionTool({
      name: 'test_tool',
      description: 'A test tool',
      execute: () => ({result: 'ok'}),
    });
  }

  function responseEvent(response: Record<string, unknown>): Event {
    return createEvent({
      id: EVENT_ID,
      author: 'test_agent',
      content: {
        parts: [
          {functionResponse: {id: 'call-1', name: 'test_tool', response}},
        ],
      },
    });
  }

  async function runTool(
    response: Record<string, unknown>,
    rawResult: unknown = response,
  ): Promise<ReadableSpan> {
    await recordToolExecution(
      {
        tool: createTool(),
        args: {city: 'Paris'},
        invocationContext: createInvocationContext(),
      },
      async (scope) => {
        scope.recordSuccess({
          functionResponseEvent: responseEvent(response),
          rawResult,
        });
      },
    );
    return onlySpan('execute_tool test_tool');
  }

  it('records the tool, the agent and the call', async () => {
    const span = await runTool({result: 'ok'});

    expect(span.attributes).toEqual({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'test_tool',
      'gen_ai.tool.description': 'A test tool',
      'gen_ai.tool.type': 'FunctionTool',
      'gen_ai.agent.name': 'test_agent',
      'gen_ai.tool.call.id': 'call-1',
      'gcp.vertex.agent.event_id': EVENT_ID,
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records <not specified> when the event has no function response', async () => {
    vi.stubEnv(CAPTURE_ENV, 'SPAN_ONLY');
    const emptyEvent = createEvent({
      id: EVENT_ID,
      author: 'test_agent',
      content: {parts: []},
    });

    await recordToolExecution(
      {
        tool: createTool(),
        args: {},
        invocationContext: createInvocationContext(),
      },
      async (scope) => {
        scope.recordSuccess({
          functionResponseEvent: emptyEvent,
          rawResult: undefined,
        });
      },
    );

    const span = onlySpan('execute_tool test_tool');
    expect(span.attributes['gen_ai.tool.call.id']).toBe('<not specified>');
    expect(span.attributes).not.toHaveProperty('gen_ai.tool.call.result');
  });

  it('traces a tool call without a process global', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
    Reflect.deleteProperty(globalThis, 'process');
    try {
      await runTool({result: 'ok'});
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'process', descriptor);
      }
    }

    expect(onlySpan('execute_tool test_tool').attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'test_tool',
    });
  });

  it.each([
    {value: 'SPAN_ONLY', captured: true},
    {value: 'SPAN_AND_EVENT', captured: true},
    {value: 'EVENT_ONLY', captured: false},
    {value: 'NO_CONTENT', captured: false},
  ])(
    'records arguments and result only in span capture modes ($value)',
    async ({value, captured}) => {
      vi.stubEnv(CAPTURE_ENV, value);

      const span = await runTool({result: 'ok'});

      expect('gen_ai.tool.call.arguments' in span.attributes).toBe(captured);
      expect('gen_ai.tool.call.result' in span.attributes).toBe(captured);
      if (captured) {
        expect(parseJsonAttribute(span, 'gen_ai.tool.call.arguments')).toEqual({
          city: 'Paris',
        });
        expect(parseJsonAttribute(span, 'gen_ai.tool.call.result')).toEqual({
          result: 'ok',
        });
      }
    },
  );

  it('removes credential secrets from the recorded result', async () => {
    vi.stubEnv(CAPTURE_ENV, 'SPAN_ONLY');

    const span = await runTool({
      credential: {
        authType: 'oauth2',
        oauth2: {clientId: 'client-1', accessToken: 'sentinel-secret'},
      },
      actions: {requestedAuthConfigs: {a: {token: 'sentinel-secret', x: 1}}},
    });

    expect(span.attributes['gen_ai.tool.call.result']).not.toContain(
      'sentinel-secret',
    );
    expect(parseJsonAttribute(span, 'gen_ai.tool.call.result')).toEqual({
      credential: {authType: 'oauth2', oauth2: {clientId: 'client-1'}},
      actions: {requestedAuthConfigs: {a: {x: 1}}},
    });
  });

  it.each([
    {
      name: 'an ADK error by its explicit error type',
      error: new ToolExecutionError('details', ToolErrorType.BAD_REQUEST),
      errorType: ToolErrorType.BAD_REQUEST,
    },
    {
      name: 'a GenAI API error by its HTTP status',
      error: new ApiError({status: 429, message: 'rate limited'}),
      errorType: '429',
    },
    {
      name: 'any other error by its class name',
      error: new TypeError('sensitive details'),
      errorType: 'TypeError',
    },
  ])('records a thrown error: $name', async ({error, errorType}) => {
    await expect(
      recordToolExecution(
        {
          tool: createTool(),
          args: {},
          invocationContext: createInvocationContext(),
        },
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);

    const span = onlySpan('execute_tool test_tool');
    expect(span.attributes['error.type']).toBe(errorType);
    expect(span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: errorType,
    });
    expect(span.events.map((event) => event.name)).toEqual(['exception']);
  });

  it.each([
    {field: 'errorType', value: 'MCP_TOOL_ERROR'},
    {field: 'error_code', value: 'SKILL_NOT_FOUND'},
  ])(
    'records an error the tool reports in its $field without an exception',
    async ({field, value}) => {
      const response = {error: 'sensitive details', [field]: value};

      const span = await runTool(response);

      expect(span.attributes['error.type']).toBe(value);
      expect(span.status).toEqual({code: SpanStatusCode.ERROR, message: value});
      expect(span.events).toEqual([]);
    },
  );
});

describe('recordSkillActivity', () => {
  const skill = {
    frontmatter: {
      name: 'my-skill',
      description: 'A skill.',
      metadata: {adk_additional_tools: ['foo']},
    },
    instructions: 'do things',
  };

  async function runSkillTool(
    report: (scope: ReturnType<typeof recordSkillActivity>) => void = () => {},
    activity: Parameters<typeof recordSkillActivity>[0] = {
      kind: 'load',
      skillName: 'my-skill',
    },
  ): Promise<ReadableSpan> {
    const tool = new FunctionTool({
      name: 'load_skill',
      description: 'Loads.',
      execute: () => ({}),
    });
    await recordToolExecution(
      {tool, args: {}, invocationContext: createInvocationContext()},
      async () => {
        report(recordSkillActivity(activity));
      },
    );
    const [span] = spanExporter.getFinishedSpans();
    return span;
  }

  it('renames the tool span after the skill and records the skill', async () => {
    const span = await runSkillTool((scope) => scope.recordSkill(skill));

    expect(span.name).toBe('execute_tool load_skill my-skill');
    expect(span.attributes).toMatchObject({
      'gen_ai.skill.name': 'my-skill',
      'gen_ai.skill.description': 'A skill.',
      'adk.skill.additional_tools': ['foo'],
    });
  });

  it('records the requested name of a skill that could not be resolved', async () => {
    const span = await runSkillTool();

    expect(span.name).toBe('execute_tool load_skill my-skill');
    expect(span.attributes['gen_ai.skill.name']).toBe('my-skill');
    expect(span.attributes).not.toHaveProperty('gen_ai.skill.description');
  });

  it('names a resource load after the skill and the resource', async () => {
    const span = await runSkillTool((scope) => scope.recordSkill(skill), {
      kind: 'resource',
      skillName: 'my-skill',
      resourcePath: 'references/doc.md',
    });

    expect(span.name).toBe(
      'execute_tool load_skill my-skill references/doc.md',
    );
    expect(span.attributes['gen_ai.skill.resource.name']).toBe(
      'references/doc.md',
    );
    expect(span.attributes).not.toHaveProperty('adk.skill.additional_tools');
  });

  it('does nothing outside a tool call', () => {
    expect(() =>
      recordSkillActivity({kind: 'load', skillName: 'my-skill'}).recordSkill(
        skill,
      ),
    ).not.toThrow();
    expect(spanExporter.getFinishedSpans()).toEqual([]);
  });
});

describe('recordMergedToolCalls', () => {
  it('records only the merged response identifiers', () => {
    recordMergedToolCalls({responseEventId: 'merged-event-id'});

    expect(onlySpan('execute_tool (merged)').attributes).toEqual({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': '(merged tools)',
      'gen_ai.tool.description': '(merged tools)',
      'gen_ai.tool.call.id': 'merged-event-id',
      'gcp.vertex.agent.event_id': 'merged-event-id',
    });
  });
});

describe('invocation, agent and workflow spans', () => {
  const agent = new LlmAgent({name: 'root_agent', description: 'Root.'});

  it('opens a root invoke_workflow span named after the entrypoint', async () => {
    await drain(
      recordInvocation(
        {entrypoint: agent, sessionId: SESSION_ID},
        async function* () {
          yield* [];
        },
      ),
    );

    const span = onlySpan('invoke_workflow root_agent');
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.attributes).toEqual({
      'gen_ai.operation.name': 'invoke_workflow',
      'gen_ai.conversation.id': SESSION_ID,
      'gen_ai.workflow.name': 'root_agent',
    });
  });

  it('records agent attributes when the span starts and ERROR when it fails', async () => {
    const error = new Error('boom');

    await expect(
      drain(
        recordAgentInvocation(
          {agent, invocationContext: createInvocationContext()},
          async function* () {
            expect(trace.getActiveSpan()?.isRecording()).toBe(true);
            yield* [];
            throw error;
          },
        ),
      ),
    ).rejects.toBe(error);

    const span = onlySpan('invoke_agent root_agent');
    expect(span.attributes).toEqual({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'root_agent',
      'gen_ai.agent.description': 'Root.',
      'gen_ai.conversation.id': SESSION_ID,
    });
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('lets the entrypoint workflow run in the root span, once', async () => {
    const workflow = new Workflow({
      name: 'my_workflow',
      edges: [['START', new FunctionNode('step', () => 'out')]],
    });
    await drain(
      recordInvocation(
        {entrypoint: workflow, sessionId: SESSION_ID},
        async function* () {
          yield* [];
          const root = recordWorkflowInvocation({
            workflow,
            sessionId: SESSION_ID,
          });
          await root.run(async () => {
            const nested = recordWorkflowInvocation({
              workflow,
              sessionId: SESSION_ID,
            });
            nested.end();
          });
          root.end();
        },
      ),
    );

    const spans = spansNamed('invoke_workflow my_workflow');
    expect(spans).toHaveLength(2);
    const [nested, root] = spans;
    expect(root.attributes).not.toHaveProperty('gen_ai.workflow.nested');
    expect(nested.attributes['gen_ai.workflow.nested']).toBe(true);
    expect(nested.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  });

  it('marks a workflow failure as ERROR', () => {
    const workflow = new Workflow({
      name: 'other_workflow',
      edges: [['START', new FunctionNode('step', () => 'out')]],
    });

    const scope = recordWorkflowInvocation({workflow, sessionId: SESSION_ID});
    scope.end(new Error('failed'));
    scope.end();

    const span = onlySpan('invoke_workflow other_workflow');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes).not.toHaveProperty('gen_ai.workflow.nested');
  });
});

describe('runWithAgentEngineContext', () => {
  const agent = new LlmAgent({name: 'root_agent', description: 'Root.'});
  const AGENT_ENGINE_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
  const AGENT_ENGINE_SPAN_ID = 'b7ad6b7169203331';
  const AGENT_ENGINE_TRACEPARENT = `00-${AGENT_ENGINE_TRACE_ID}-${AGENT_ENGINE_SPAN_ID}-01`;
  const SUPPORT_ID = '00-11111111111111111111111111111111-2222222222222222-01';
  const ROOT_SPAN = 'invoke_workflow root_agent';

  function runInvocation(): Promise<void[]> {
    return drain(
      recordInvocation(
        {entrypoint: agent, sessionId: SESSION_ID},
        async function* () {
          yield* [];
        },
      ),
    );
  }

  it('parents the root span on the Agent Engine span and records supportID', async () => {
    await runWithAgentEngineContext(
      {
        'google-agent-engine-traceparent': AGENT_ENGINE_TRACEPARENT,
        'traceparent': SUPPORT_ID,
      },
      runInvocation,
    );

    const span = onlySpan(ROOT_SPAN);
    expect(span.spanContext().traceId).toBe(AGENT_ENGINE_TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(AGENT_ENGINE_SPAN_ID);
    expect(span.parentSpanContext?.isRemote).toBe(true);
    expect(span.attributes['supportID']).toBe(SUPPORT_ID);
  });

  it('reads header names case-insensitively and takes the first array value', async () => {
    await runWithAgentEngineContext(
      {
        'Google-Agent-Engine-Traceparent': [
          AGENT_ENGINE_TRACEPARENT,
          `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
        ],
        'TraceParent': [SUPPORT_ID, 'second'],
      },
      runInvocation,
    );

    const span = onlySpan(ROOT_SPAN);
    expect(span.parentSpanContext?.spanId).toBe(AGENT_ENGINE_SPAN_ID);
    expect(span.attributes['supportID']).toBe(SUPPORT_ID);
  });

  it.each([
    {
      kind: 'an all-zero trace id',
      value: `00-${'0'.repeat(32)}-${AGENT_ENGINE_SPAN_ID}-01`,
    },
    {
      kind: 'an all-zero span id',
      value: `00-${AGENT_ENGINE_TRACE_ID}-${'0'.repeat(16)}-01`,
    },
    {
      kind: 'version ff',
      value: `ff-${AGENT_ENGINE_TRACE_ID}-${AGENT_ENGINE_SPAN_ID}-01`,
    },
    {kind: 'uppercase hex', value: AGENT_ENGINE_TRACEPARENT.toUpperCase()},
    {
      kind: 'non-hex characters',
      value: `00-${'g'.repeat(32)}-${AGENT_ENGINE_SPAN_ID}-01`,
    },
    {
      kind: 'an extra field on version 00',
      value: `${AGENT_ENGINE_TRACEPARENT}-extra`,
    },
    {kind: 'missing fields', value: `00-${AGENT_ENGINE_TRACE_ID}`},
    {kind: 'free text', value: 'not a traceparent'},
  ])('ignores a header with $kind', async ({value}) => {
    await runWithAgentEngineContext(
      {
        'google-agent-engine-traceparent': value,
        'traceparent': SUPPORT_ID,
      },
      runInvocation,
    );

    const span = onlySpan(ROOT_SPAN);
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.spanContext().traceId).not.toBe(AGENT_ENGINE_TRACE_ID);
    expect(span.attributes['supportID']).toBe(SUPPORT_ID);
  });

  it('accepts extra fields on a later version', async () => {
    await runWithAgentEngineContext(
      {
        'google-agent-engine-traceparent': `01-${AGENT_ENGINE_TRACE_ID}-${AGENT_ENGINE_SPAN_ID}-01-extra`,
      },
      runInvocation,
    );

    const span = onlySpan(ROOT_SPAN);
    expect(span.parentSpanContext?.spanId).toBe(AGENT_ENGINE_SPAN_ID);
    expect(span.attributes).not.toHaveProperty('supportID');
  });

  it('does not record a traceparent longer than 256 characters', async () => {
    await runWithAgentEngineContext(
      {
        'google-agent-engine-traceparent': AGENT_ENGINE_TRACEPARENT,
        'traceparent': 'a'.repeat(257),
      },
      runInvocation,
    );

    expect(onlySpan(ROOT_SPAN).attributes).not.toHaveProperty('supportID');
  });

  it('changes nothing without the headers', async () => {
    await runWithAgentEngineContext({}, runInvocation);

    const span = onlySpan(ROOT_SPAN);
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.attributes).toEqual({
      'gen_ai.operation.name': 'invoke_workflow',
      'gen_ai.conversation.id': SESSION_ID,
      'gen_ai.workflow.name': 'root_agent',
    });
  });

  it('records supportID only on the root span of nested invocations', async () => {
    const child = new LlmAgent({name: 'child_agent'});
    await runWithAgentEngineContext(
      {
        'google-agent-engine-traceparent': AGENT_ENGINE_TRACEPARENT,
        'traceparent': SUPPORT_ID,
      },
      () =>
        drain(
          recordInvocation(
            {entrypoint: agent, sessionId: SESSION_ID},
            async function* () {
              yield* recordInvocation(
                {entrypoint: child, sessionId: SESSION_ID},
                async function* () {
                  yield* [];
                },
              );
            },
          ),
        ),
    );

    const root = onlySpan(ROOT_SPAN);
    const nested = onlySpan('invoke_workflow child_agent');
    expect(root.attributes['supportID']).toBe(SUPPORT_ID);
    expect(nested.attributes).not.toHaveProperty('supportID');
    expect(nested.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(nested.spanContext().traceId).toBe(AGENT_ENGINE_TRACE_ID);
  });

  it('keeps an active local span as the parent and records no supportID', async () => {
    const tracer = trace.getTracer('test');
    await tracer.startActiveSpan('application', async (appSpan) => {
      await runWithAgentEngineContext(
        {
          'google-agent-engine-traceparent': AGENT_ENGINE_TRACEPARENT,
          'traceparent': SUPPORT_ID,
        },
        runInvocation,
      );
      appSpan.end();
    });

    const app = onlySpan('application');
    const span = onlySpan(ROOT_SPAN);
    expect(span.parentSpanContext?.spanId).toBe(app.spanContext().spanId);
    expect(span.spanContext().traceId).not.toBe(AGENT_ENGINE_TRACE_ID);
    expect(span.attributes).not.toHaveProperty('supportID');
  });

  it('records no supportID when a local span starts inside the context', async () => {
    const tracer = trace.getTracer('test');
    await runWithAgentEngineContext(
      {
        'google-agent-engine-traceparent': AGENT_ENGINE_TRACEPARENT,
        'traceparent': SUPPORT_ID,
      },
      () =>
        tracer.startActiveSpan('application', async (appSpan) => {
          await runInvocation();
          appSpan.end();
        }),
    );

    const app = onlySpan('application');
    const span = onlySpan(ROOT_SPAN);
    expect(app.parentSpanContext?.spanId).toBe(AGENT_ENGINE_SPAN_ID);
    expect(span.parentSpanContext?.spanId).toBe(app.spanContext().spanId);
    expect(span.attributes).not.toHaveProperty('supportID');
  });
});

describe('recordNodeInvocation', () => {
  it.each([
    {kind: 'an agent', node: new LlmAgent({name: 'child'})},
    {
      kind: 'a workflow',
      node: new Workflow({
        name: 'child',
        edges: [['START', new FunctionNode('step', () => 'out')]],
      }),
    },
  ])('opens no node span for $kind node', ({node}) => {
    const scope = recordNodeInvocation({
      node,
      nodeName: 'child',
      sessionId: SESSION_ID,
    });
    scope.run(() => expect(trace.getActiveSpan()).toBeUndefined());
    scope.end();

    expect(spanExporter.getFinishedSpans()).toEqual([]);
  });

  it('opens invoke_node for a plain node and records its event ids', async () => {
    const node = new FunctionNode('plain_node', () => 'out');

    const scope = recordNodeInvocation({
      node,
      nodeName: 'plain_node',
      sessionId: SESSION_ID,
    });
    scope.run(() => expect(trace.getActiveSpan()?.isRecording()).toBe(true));
    scope.recordEvent(createEvent({id: 'event-a', author: 'plain_node'}));
    scope.recordEvent(createEvent({id: 'event-b', author: 'plain_node'}));
    scope.end();

    expect(onlySpan('invoke_node plain_node').attributes).toEqual({
      'gen_ai.operation.name': 'invoke_node',
      'gen_ai.conversation.id': SESSION_ID,
      'gcp.vertex.agent.associated_event_ids': ['event-a', 'event-b'],
    });
  });
});

describe('recordCompaction', () => {
  it('records the summary event the compaction added', async () => {
    const invocationContext = createInvocationContext();
    const earlier = [
      createEvent({id: 'e1', author: 'user', timestamp: 10}),
      createEvent({id: 'e2', author: 'test_agent', timestamp: 20}),
      createEvent({id: 'e3', author: 'user', timestamp: 30}),
    ];
    invocationContext.session.events.push(...earlier);

    await recordCompaction(
      {invocationContext, trigger: ContextCompactionTrigger.AgentControlled},
      async () => {
        invocationContext.session.events.push(
          createCompactedEvent({
            id: 'summary',
            startTime: 10,
            endTime: 20,
            compactedContent: 'summary',
          }),
        );
      },
    );

    expect(onlySpan('compact_events agent_controlled').attributes).toEqual({
      'gen_ai.system': 'gemini',
      'gen_ai.operation.name': 'compact_events',
      'gen_ai.conversation.id': SESSION_ID,
      'gen_ai.compaction.trigger': 'agent_controlled',
      'gen_ai.compaction.event_count': 2,
      'gen_ai.compaction.result_event_id': 'summary',
      'gen_ai.compaction.start_timestamp': 10,
      'gen_ai.compaction.end_timestamp': 20,
    });
  });
});

describe('recordSendData', () => {
  it('sets invocation_id, event_id and the serialized content list', async () => {
    const data: Content[] = [{role: 'user', parts: [{text: 'hi'}]}];

    await recordSendData(
      {invocationContext: createInvocationContext(), eventId: EVENT_ID, data},
      async () => {},
    );

    const span = onlySpan('send_data');
    expect(span.attributes['gcp.vertex.agent.invocation_id']).toBe(
      INVOCATION_ID,
    );
    expect(span.attributes['gcp.vertex.agent.event_id']).toBe(EVENT_ID);
    expect(parseJsonAttribute(span, 'gcp.vertex.agent.data')).toEqual(data);
  });

  it('replaces bigint values with <not serializable> when serializing span payloads', async () => {
    const data = [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'test_function_1',
              response: {
                result: new Uint8Array([116, 101, 115, 116]),
                nonSerializableBigInt: BigInt(42),
              },
            },
          },
        ],
      },
    ] as unknown as Content[];

    await recordSendData(
      {invocationContext: createInvocationContext(), eventId: EVENT_ID, data},
      async () => {},
    );

    const span = onlySpan('send_data');
    const parsed = parseJsonAttribute(span, 'gcp.vertex.agent.data') as Array<{
      parts: Array<{functionResponse: {response: Record<string, unknown>}}>;
    }>;
    expect(
      parsed[0].parts[0].functionResponse.response['nonSerializableBigInt'],
    ).toBe('<not serializable>');
  });
});

describe('metrics', () => {
  const ROOT_AGENT = 'root_agent';
  const SCHEMA_URL = 'https://opentelemetry.io/schemas/1.44.0';

  interface MetricPoint {
    readonly attributes: Attributes;
    /** The counter value, or the histogram sum. */
    readonly value: number;
    /** The histogram bucket boundaries, if the point is a histogram. */
    readonly boundaries?: readonly number[];
  }

  async function collectMetrics(
    reader: MetricReader = metricReader,
  ): Promise<MetricData[]> {
    const {resourceMetrics} = await reader.collect();
    return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
  }

  function findMetric(
    collected: readonly MetricData[],
    name: string,
  ): MetricData | undefined {
    return collected.find(
      (metric) =>
        metric.descriptor.name === name && metric.dataPoints.length > 0,
    );
  }

  function pointsOf(
    collected: readonly MetricData[],
    name: string,
  ): MetricPoint[] {
    const metric = findMetric(collected, name);
    if (metric === undefined) {
      return [];
    }
    switch (metric.dataPointType) {
      case DataPointType.HISTOGRAM:
        return metric.dataPoints.map((point) => ({
          attributes: point.attributes,
          value: point.value.sum ?? 0,
          boundaries: point.value.buckets.boundaries,
        }));
      case DataPointType.SUM:
        return metric.dataPoints.map((point) => ({
          attributes: point.attributes,
          value: point.value,
        }));
      default:
        return expect.fail(`${name} is neither a histogram nor a counter`);
    }
  }

  function valuesOf(
    collected: readonly MetricData[],
    name: string,
  ): Array<{attributes: Attributes; value: number}> {
    return pointsOf(collected, name).map(({attributes, value}) => ({
      attributes,
      value,
    }));
  }

  function namesOf(collected: readonly MetricData[]): string[] {
    return collected
      .filter((metric) => metric.dataPoints.length > 0)
      .map((metric) => metric.descriptor.name);
  }

  function usageResponse(
    usage: GenerateContentResponseUsageMetadata | undefined,
    finishReason?: FinishReason,
  ): LlmResponse {
    return {
      content: {role: 'model', parts: [{text: 'ok'}]},
      usageMetadata: usage,
      finishReason,
    };
  }

  async function runInference(
    responses: readonly LlmResponse[] = [
      usageResponse(USAGE, FinishReason.STOP),
    ],
  ): Promise<void> {
    await drain(recordInference(inferenceParams(), () => streamOf(responses)));
  }

  async function runAgent(
    agentName: string,
    body: () => Promise<void> = async () => {},
  ): Promise<void> {
    await drain(
      recordAgentInvocation(
        {
          agent: new LlmAgent({name: agentName}),
          invocationContext: createInvocationContext(),
        },
        async function* () {
          yield* [];
          await body();
        },
      ),
    );
  }

  async function runInvocation(body: () => Promise<void>): Promise<void> {
    await drain(
      recordInvocation(
        {entrypoint: new LlmAgent({name: ROOT_AGENT}), sessionId: SESSION_ID},
        async function* () {
          yield* [];
          await body();
        },
      ),
    );
  }

  async function runWorkflow(
    workflowName: string,
    body: () => Promise<void>,
  ): Promise<void> {
    const scope = recordWorkflowInvocation({
      workflow: new Workflow({
        name: workflowName,
        edges: [['START', new FunctionNode('step', () => 'out')]],
      }),
      sessionId: SESSION_ID,
    });
    await scope.run(body);
    scope.end();
  }

  async function runTool(
    fn: (scope: ToolExecutionScope) => Promise<void> = async () => {},
  ): Promise<void> {
    await recordToolExecution(
      {
        tool: new FunctionTool({
          name: 'test_tool',
          description: 'A test tool',
          execute: () => ({}),
        }),
        args: {},
        invocationContext: createInvocationContext(),
      },
      fn,
    );
  }

  const rootWorkflowAttributes = {
    'adk.experimental.root_agent.name': ROOT_AGENT,
    'gen_ai.workflow.name': ROOT_AGENT,
  };

  it('uses the same instrumentation scope as the tracer', async () => {
    await runAgent(ROOT_AGENT);

    const {resourceMetrics} = await metricReader.collect();
    expect(resourceMetrics.scopeMetrics.map(({scope}) => scope)).toEqual([
      {name: 'gcp.vertex.agent', version, schemaUrl: SCHEMA_URL},
    ]);
    expect(onlySpan(`invoke_agent ${ROOT_AGENT}`).instrumentationScope).toEqual(
      {name: 'gcp.vertex.agent', version, schemaUrl: SCHEMA_URL},
    );
  });

  it('reaches a meter provider registered after earlier records', async () => {
    await runAgent(ROOT_AGENT);
    expect(
      pointsOf(await collectMetrics(), 'gen_ai.invoke_agent.duration'),
    ).toHaveLength(1);

    const lateReader = new DeltaMetricReader();
    const lateProvider = new MeterProvider({readers: [lateReader]});
    metrics.disable();
    metrics.setGlobalMeterProvider(lateProvider);
    try {
      await runAgent(ROOT_AGENT);
      expect(
        pointsOf(
          await collectMetrics(lateReader),
          'gen_ai.invoke_agent.duration',
        ),
      ).toHaveLength(1);
      expect(
        pointsOf(await collectMetrics(), 'gen_ai.invoke_agent.duration'),
      ).toEqual([]);
    } finally {
      await lateProvider.shutdown();
      metrics.disable();
      metrics.setGlobalMeterProvider(meterProvider);
    }
  });

  it('does not record the GenAI client operation duration or token usage', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY', 'true');

    await runInvocation(() => runAgent(ROOT_AGENT, () => runInference()));

    const names = namesOf(await collectMetrics());
    expect(names).toContain('gen_ai.invoke_agent.inference_calls');
    expect(names).not.toContain('gen_ai.client.operation.duration');
    expect(names).not.toContain('gen_ai.client.token.usage');
  });

  it('counts the newest cumulative usage report of a call, including one after the finish reason', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'token_usage');

    await runAgent(ROOT_AGENT, () =>
      runInference([
        usageResponse({promptTokenCount: 10, candidatesTokenCount: 1}),
        usageResponse(
          {promptTokenCount: 10, candidatesTokenCount: 5},
          FinishReason.STOP,
        ),
        usageResponse({promptTokenCount: 10, candidatesTokenCount: 7}),
        usageResponse(undefined),
      ]),
    );

    const collected = await collectMetrics();
    const attributes = {'gen_ai.agent.name': ROOT_AGENT};
    expect(
      valuesOf(collected, 'adk.experimental.invoke_agent.input_tokens'),
    ).toEqual([{attributes, value: 10}]);
    expect(
      valuesOf(collected, 'adk.experimental.invoke_agent.output_tokens'),
    ).toEqual([{attributes, value: 7}]);
    expect(
      valuesOf(collected, 'adk.experimental.invoke_agent.total_tokens'),
    ).toEqual([{attributes, value: 17}]);
  });

  it('counts the call and the usage reported before the model stream fails', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'token_usage');
    const error = new Error('stream broke');

    await runAgent(ROOT_AGENT, async () => {
      await expect(
        drain(
          recordInference(inferenceParams(), async function* () {
            yield usageResponse(USAGE);
            throw error;
          }),
        ),
      ).rejects.toBe(error);
    });

    const collected = await collectMetrics();
    const attributes = {'gen_ai.agent.name': ROOT_AGENT};
    expect(valuesOf(collected, 'gen_ai.invoke_agent.inference_calls')).toEqual([
      {attributes, value: 1},
    ]);
    expect(
      valuesOf(collected, 'adk.experimental.invoke_agent.input_tokens'),
    ).toEqual([{attributes, value: 103}]);
  });

  it('records the token buckets of each call into the agent token metrics', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'token_usage');

    await runAgent(ROOT_AGENT, () => runInference());

    const collected = await collectMetrics();
    const value = (suffix: string) =>
      pointsOf(collected, `adk.experimental.invoke_agent.${suffix}`).map(
        (point) => point.value,
      );
    expect(value('input_tokens')).toEqual([103]);
    expect(value('output_tokens')).toEqual([25]);
    expect(value('total_tokens')).toEqual([128]);
    expect(value('cache_read.input_tokens')).toEqual([40]);
    expect(value('reasoning.output_tokens')).toEqual([5]);
    expect(value('tool.input_tokens')).toEqual([3]);
  });

  it('records error.type on the agent duration when the agent fails', async () => {
    const error = new TypeError('boom');

    await expect(
      runAgent(ROOT_AGENT, async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    expect(
      valuesOf(await collectMetrics(), 'gen_ai.invoke_agent.duration').map(
        (point) => point.attributes,
      ),
    ).toEqual([{'gen_ai.agent.name': ROOT_AGENT, 'error.type': 'TypeError'}]);
  });

  it('records error.type on the tool duration when the tool fails or reports an error', async () => {
    const error = new TypeError('boom');

    await expect(
      runTool(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    await runTool(async (scope) => {
      scope.recordSuccess({rawResult: {error: 'x', errorType: 'MCP_ERROR'}});
    });
    await runTool();

    const toolAttributes = {
      'gen_ai.agent.name': 'test_agent',
      'gen_ai.tool.name': 'test_tool',
      'gen_ai.tool.type': 'FunctionTool',
    };
    expect(
      pointsOf(await collectMetrics(), 'gen_ai.execute_tool.duration').map(
        (point) => point.attributes,
      ),
    ).toEqual([
      {...toolAttributes, 'error.type': 'TypeError'},
      {...toolAttributes, 'error.type': 'MCP_ERROR'},
      toolAttributes,
    ]);
  });

  it('records exclusive totals for an agent nested in another agent', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'token_usage');

    await runAgent('outer_agent', async () => {
      await runInference();
      await runTool();
      await runAgent('inner_agent', async () => {
        await runInference();
        await runInference();
      });
    });

    const collected = await collectMetrics();
    const outer = {'gen_ai.agent.name': 'outer_agent'};
    const inner = {'gen_ai.agent.name': 'inner_agent'};
    expect(valuesOf(collected, 'gen_ai.invoke_agent.inference_calls')).toEqual(
      expect.arrayContaining([
        {attributes: outer, value: 1},
        {attributes: inner, value: 2},
      ]),
    );
    expect(valuesOf(collected, 'gen_ai.invoke_agent.tool_calls')).toEqual(
      expect.arrayContaining([
        {attributes: outer, value: 1},
        {attributes: inner, value: 0},
      ]),
    );
    expect(
      valuesOf(collected, 'adk.experimental.invoke_agent.input_tokens'),
    ).toEqual(
      expect.arrayContaining([
        {attributes: outer, value: 103},
        {attributes: inner, value: 206},
      ]),
    );
  });

  it('records inclusive totals for nested workflows, which inherit the root agent name', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'workflow,token_usage');

    await runInvocation(async () => {
      await runAgent(ROOT_AGENT, () => runInference());
      await runWorkflow('child_workflow', () =>
        runAgent('child_agent', async () => {
          await runInference();
          await runTool();
        }),
      );
    });

    const collected = await collectMetrics();
    const nested = {
      'adk.experimental.root_agent.name': ROOT_AGENT,
      'gen_ai.workflow.name': 'child_workflow',
      'gen_ai.workflow.nested': true,
    };
    expect(
      valuesOf(collected, 'adk.experimental.invoke_workflow.inference_calls'),
    ).toEqual(
      expect.arrayContaining([
        {attributes: nested, value: 1},
        {attributes: rootWorkflowAttributes, value: 2},
      ]),
    );
    expect(
      valuesOf(collected, 'adk.experimental.invoke_workflow.tool_calls'),
    ).toEqual(
      expect.arrayContaining([
        {attributes: nested, value: 1},
        {attributes: rootWorkflowAttributes, value: 1},
      ]),
    );
    expect(
      valuesOf(collected, 'adk.experimental.invoke_workflow.input_tokens'),
    ).toEqual(
      expect.arrayContaining([
        {attributes: nested, value: 103},
        {attributes: rootWorkflowAttributes, value: 206},
      ]),
    );
    expect(
      pointsOf(collected, 'gen_ai.invoke_workflow.duration').map(
        (point) => point.attributes,
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          'gen_ai.operation.name': 'invoke_workflow',
          'gen_ai.workflow.name': 'child_workflow',
          'gen_ai.workflow.nested': true,
        },
        {
          'gen_ai.operation.name': 'invoke_workflow',
          'gen_ai.workflow.name': ROOT_AGENT,
        },
      ]),
    );
  });

  it('sums each call once into the agent and into every enclosing workflow', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'workflow,token_usage');

    await runInvocation(() =>
      runAgent(ROOT_AGENT, async () => {
        await runInference();
        await runInference();
      }),
    );

    const collected = await collectMetrics();
    expect(
      valuesOf(collected, 'adk.experimental.invoke_agent.input_tokens'),
    ).toEqual([{attributes: {'gen_ai.agent.name': ROOT_AGENT}, value: 206}]);
    expect(
      valuesOf(collected, 'adk.experimental.invoke_workflow.input_tokens'),
    ).toEqual([{attributes: rootWorkflowAttributes, value: 206}]);
  });

  it('records agent tokens but no workflow totals for the token_usage feature alone', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'token_usage');

    await runInvocation(() =>
      runAgent(ROOT_AGENT, async () => {
        await runInference();
        await runInference();
      }),
    );

    const names = namesOf(await collectMetrics());
    expect(names).toContain('adk.experimental.invoke_agent.input_tokens');
    expect(names).toContain('gen_ai.invoke_workflow.duration');
    expect(names).not.toContain('adk.experimental.invoke_agent.skill.loads');
    expect(
      names.filter((name) =>
        name.startsWith('adk.experimental.invoke_workflow.'),
      ),
    ).toEqual([]);
  });

  it('records workflow call totals but no token, skill or compaction metrics for the workflow feature alone', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'workflow');

    await runInvocation(() => runAgent(ROOT_AGENT, () => runInference()));

    const names = namesOf(await collectMetrics());
    expect(names).toEqual(
      expect.arrayContaining([
        'adk.experimental.invoke_workflow.inference_calls',
        'adk.experimental.invoke_workflow.tool_calls',
      ]),
    );
    expect(
      names.filter(
        (name) =>
          name.endsWith('tokens') ||
          name.endsWith('skill.loads') ||
          name.endsWith('compactions'),
      ),
    ).toEqual([]);
  });

  it('records skill loads for agents, and for workflows only with the workflow feature', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'skills');
    await runInvocation(() => runAgent(ROOT_AGENT));
    let names = namesOf(await collectMetrics());
    expect(names).toContain('adk.experimental.invoke_agent.skill.loads');
    expect(names).not.toContain('adk.experimental.invoke_workflow.skill.loads');

    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'skills,workflow');
    await runInvocation(() => runAgent(ROOT_AGENT));
    names = namesOf(await collectMetrics());
    expect(names).toContain('adk.experimental.invoke_workflow.skill.loads');
    expect(names).not.toContain('adk.experimental.invoke_workflow.compactions');
  });

  it('records zero call counts, but no token metrics when no call reported usage', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY', 'true');

    await runInvocation(() =>
      runAgent(ROOT_AGENT, () =>
        runInference([usageResponse({}, FinishReason.STOP)]),
      ),
    );

    const collected = await collectMetrics();
    const agent = {'gen_ai.agent.name': ROOT_AGENT};
    expect(valuesOf(collected, 'gen_ai.invoke_agent.tool_calls')).toEqual([
      {attributes: agent, value: 0},
    ]);
    expect(
      valuesOf(collected, 'adk.experimental.invoke_agent.skill.loads'),
    ).toEqual([{attributes: agent, value: 0}]);
    expect(
      valuesOf(collected, 'adk.experimental.invoke_workflow.compactions'),
    ).toEqual([{attributes: rootWorkflowAttributes, value: 0}]);
    expect(
      namesOf(collected).filter((name) => name.endsWith('tokens')),
    ).toEqual([]);
  });

  it('uses the units, descriptions and bucket boundaries of the ADK metrics', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY', 'true');

    await runInvocation(() =>
      runAgent(ROOT_AGENT, async () => {
        await runInference();
        await runTool();
      }),
    );

    const collected = await collectMetrics();
    const describeMetric = (name: string) => {
      const metric = findMetric(collected, name);
      return {
        unit: metric?.descriptor.unit,
        description: metric?.descriptor.description,
        boundaries: pointsOf(collected, name)[0]?.boundaries,
      };
    };
    const callCountBuckets = [
      0, 1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 64, 128, 256, 512,
    ];
    expect(describeMetric('gen_ai.invoke_agent.duration')).toEqual({
      unit: 's',
      description: 'Duration of agent invocations.',
      boundaries: [
        0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2, 102.4, 204.8,
        409.6,
      ],
    });
    expect(describeMetric('gen_ai.execute_tool.duration')).toEqual({
      unit: 's',
      description: 'Duration of tool executions.',
      boundaries: [
        0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24,
        20.48, 40.96, 81.92,
      ],
    });
    expect(describeMetric('gen_ai.invoke_workflow.duration')).toMatchObject({
      unit: 's',
      description: 'Duration of workflow invocations.',
    });
    expect(describeMetric('gen_ai.invoke_agent.inference_calls')).toEqual({
      unit: '1',
      description: 'Number of inference (model) calls per agent invocation.',
      boundaries: callCountBuckets,
    });
    expect(
      describeMetric('adk.experimental.invoke_workflow.tool_calls'),
    ).toEqual({
      unit: '1',
      description:
        'Number of tool calls over one workflow invocation, across every' +
        ' agent that ran in it. Includes the `transfer_to_agent` calls that' +
        ' route between them.',
      boundaries: callCountBuckets,
    });
    expect(
      describeMetric('adk.experimental.invoke_agent.input_tokens'),
    ).toEqual({
      unit: '{token}',
      description: expect.stringMatching(
        / Summed over one agent invocation\.$/,
      ),
      boundaries: [
        0, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072,
        262144, 524288, 1048576,
      ],
    });
    expect(
      describeMetric('adk.experimental.invoke_workflow.output_tokens'),
    ).toEqual({
      unit: '{token}',
      description: expect.stringMatching(
        / Summed over one workflow invocation, across every agent that ran in it\.$/,
      ),
      boundaries: [
        0, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
        131072,
      ],
    });
  });

  it('records one workflow duration when the scope ends twice', async () => {
    const scope = recordWorkflowInvocation({
      workflow: new Workflow({
        name: 'twice_workflow',
        edges: [['START', new FunctionNode('step', () => 'out')]],
      }),
      sessionId: SESSION_ID,
    });
    scope.end(new TypeError('failed'));
    scope.end();

    expect(
      pointsOf(await collectMetrics(), 'gen_ai.invoke_workflow.duration').map(
        (point) => point.attributes,
      ),
    ).toEqual([
      {
        'gen_ai.operation.name': 'invoke_workflow',
        'gen_ai.workflow.name': 'twice_workflow',
        'error.type': 'TypeError',
      },
    ]);
  });

  describe('skill counters', () => {
    const skill = {
      frontmatter: {name: 'my-skill', description: 'A skill.'},
      instructions: 'do things',
      resources: {scripts: {'run.py': {src: 'print(1)'}}},
    };

    async function runSkillTool(
      activity: Parameters<typeof recordSkillActivity>[0],
      {
        resolve,
        rawResult,
      }: {readonly resolve: boolean; readonly rawResult?: unknown},
    ): Promise<void> {
      await runTool(async (scope) => {
        const skillScope = recordSkillActivity(activity);
        if (resolve) {
          skillScope.recordSkill(skill);
        }
        scope.recordSuccess({rawResult});
      });
    }

    it('counts skill loads, bounding an unresolved skill and recording the error', async () => {
      vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'skills');

      await runAgent(ROOT_AGENT, async () => {
        await runSkillTool(
          {kind: 'load', skillName: 'my-skill'},
          {resolve: true},
        );
        await runSkillTool(
          {kind: 'load', skillName: 'made-up-skill'},
          {
            resolve: false,
            rawResult: {error: 'not found', error_code: 'SKILL_NOT_FOUND'},
          },
        );
      });

      const collected = await collectMetrics();
      expect(valuesOf(collected, 'adk.experimental.skill.loads')).toEqual([
        {
          attributes: {
            'gen_ai.agent.name': 'test_agent',
            'gen_ai.skill.name': 'my-skill',
          },
          value: 1,
        },
        {
          attributes: {
            'gen_ai.agent.name': 'test_agent',
            'gen_ai.skill.name': '<hallucinated>',
            'error.type': 'SKILL_NOT_FOUND',
          },
          value: 1,
        },
      ]);
      expect(
        valuesOf(collected, 'adk.experimental.invoke_agent.skill.loads'),
      ).toEqual([{attributes: {'gen_ai.agent.name': ROOT_AGENT}, value: 2}]);
    });

    it('counts script executions, bounding an unknown script', async () => {
      vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'skills');

      await runSkillTool(
        {kind: 'script', skillName: 'my-skill', scriptPath: 'scripts/run.py'},
        {resolve: true},
      );
      await runSkillTool(
        {kind: 'script', skillName: 'my-skill', scriptPath: 'scripts/nope.py'},
        {resolve: true},
      );

      expect(
        valuesOf(
          await collectMetrics(),
          'adk.experimental.skill.script.executions',
        ),
      ).toEqual([
        {
          attributes: {
            'gen_ai.agent.name': 'test_agent',
            'gen_ai.skill.name': 'my-skill',
            'gen_ai.skill.resource.name': 'scripts/run.py',
          },
          value: 1,
        },
        {
          attributes: {
            'gen_ai.agent.name': 'test_agent',
            'gen_ai.skill.name': 'my-skill',
            'gen_ai.skill.resource.name': '<hallucinated>',
          },
          value: 1,
        },
      ]);
    });

    it('records no skill counters without the skills feature', async () => {
      await runSkillTool(
        {kind: 'load', skillName: 'my-skill'},
        {resolve: true},
      );

      const names = namesOf(await collectMetrics());
      expect(names).toContain('gen_ai.execute_tool.duration');
      expect(names.filter((name) => name.includes('skill'))).toEqual([]);
    });
  });

  it('counts a compaction in the workflow totals only when it adds a summary event', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'workflow,compaction');
    const invocationContext = createInvocationContext();
    invocationContext.session.events.push(
      createEvent({id: 'e1', author: 'user', timestamp: 10}),
      createEvent({id: 'e2', author: 'test_agent', timestamp: 20}),
    );

    await runInvocation(async () => {
      await recordCompaction(
        {invocationContext, trigger: ContextCompactionTrigger.Auto},
        async () => {},
      );
      await recordCompaction(
        {invocationContext, trigger: ContextCompactionTrigger.Auto},
        async () => {
          invocationContext.session.events.push(
            createCompactedEvent({
              id: 'summary',
              startTime: 10,
              endTime: 20,
              compactedContent: 'summary',
            }),
          );
        },
      );
    });

    expect(
      valuesOf(
        await collectMetrics(),
        'adk.experimental.invoke_workflow.compactions',
      ),
    ).toEqual([{attributes: rootWorkflowAttributes, value: 1}]);
  });
});

describe('per-run telemetry overrides', () => {
  const GROUNDED_RESPONSE: LlmResponse = {
    ...textResponse('done', {finishReason: FinishReason.STOP}),
    groundingMetadata: {
      webSearchQueries: ['adk'],
      groundingChunks: [{web: {uri: 'https://a.test/1'}}],
    },
  };

  /** Answers every request with one text response, after a timer tick. */
  class ScriptedLlm extends BaseLlm {
    constructor() {
      super({model: MODEL});
    }
    override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
      // Yields to the timer queue so that concurrent runs interleave.
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield textResponse('done', {finishReason: FinishReason.STOP});
    }
    override async connect(): Promise<BaseLlmConnection> {
      throw new Error('Live connections are not supported.');
    }
  }

  function contextWith(telemetry: TelemetryConfig): InvocationContext {
    const invocationContext = createInvocationContext();
    invocationContext.runConfig = {telemetry};
    return invocationContext;
  }

  async function metricNames(): Promise<string[]> {
    const {resourceMetrics} = await metricReader.collect();
    return resourceMetrics.scopeMetrics.flatMap((scope) =>
      scope.metrics.map((metric) => metric.descriptor.name),
    );
  }

  /**
   * Runs an agent invocation under the runner's invocation scope, with one
   * grounded model call, all with `telemetry` as the run's overrides.
   */
  async function runWith(telemetry: TelemetryConfig): Promise<void> {
    const invocationContext = contextWith(telemetry);
    const agent = invocationContext.agent;
    if (!agent) {
      throw new Error('Agent is not defined in invocationContext');
    }
    await drain(
      recordInvocation(
        {entrypoint: agent, sessionId: SESSION_ID, runConfig: {telemetry}},
        async function* () {
          yield* recordAgentInvocation(
            {agent, invocationContext},
            async function* () {
              yield* [];
              await drain(
                recordInference({...inferenceParams(), invocationContext}, () =>
                  streamOf([GROUNDED_RESPONSE]),
                ),
              );
            },
          );
        },
      ),
    );
  }

  function groundingAttributes(): string[] {
    return Object.keys(onlySpan(`generate_content ${MODEL}`).attributes).filter(
      (key) => key.startsWith('adk.experimental.grounding'),
    );
  }

  beforeEach(async () => {
    await metricReader.collect();
  });

  it('puts content on the span when the run asks for it and the environment does not', async () => {
    vi.stubEnv(CAPTURE_ENV, 'NO_CONTENT');

    await drain(
      recordInference(
        {
          ...inferenceParams(),
          invocationContext: contextWith({captureMessageContent: 'SPAN_ONLY'}),
        },
        () =>
          streamOf([textResponse('done', {finishReason: FinishReason.STOP})]),
      ),
    );

    expect(onlySpan(`generate_content ${MODEL}`).attributes).toHaveProperty(
      'gen_ai.input.messages',
    );
    expect(inferenceLogs()[0].attributes).not.toHaveProperty(
      'gen_ai.input.messages',
    );
  });

  it('keeps content off the span and log when the run turns it off', async () => {
    vi.stubEnv(CAPTURE_ENV, 'SPAN_AND_EVENT');

    await drain(
      recordInference(
        {
          ...inferenceParams(),
          invocationContext: contextWith({captureMessageContent: 'NO_CONTENT'}),
        },
        () =>
          streamOf([textResponse('done', {finishReason: FinishReason.STOP})]),
      ),
    );

    expect(onlySpan(`generate_content ${MODEL}`).attributes).not.toHaveProperty(
      'gen_ai.input.messages',
    );
    expect(inferenceLogs()[0].attributes).not.toHaveProperty(
      'gen_ai.input.messages',
    );
  });

  it.each([
    {env: 'NO_CONTENT', run: 'SPAN_ONLY', captured: true},
    {env: 'SPAN_ONLY', run: 'NO_CONTENT', captured: false},
  ] as const)(
    'follows the run over the environment for tool arguments and results ($run over $env)',
    async ({env, run, captured}) => {
      vi.stubEnv(CAPTURE_ENV, env);
      const tool = new FunctionTool({
        name: 'test_tool',
        description: 'A test tool',
        execute: () => ({result: 'ok'}),
      });

      await recordToolExecution(
        {
          tool,
          args: {city: 'Paris'},
          invocationContext: contextWith({captureMessageContent: run}),
        },
        async (scope) => {
          scope.recordSuccess({
            functionResponseEvent: createEvent({
              id: EVENT_ID,
              author: 'test_agent',
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
            }),
            rawResult: {result: 'ok'},
          });
        },
      );

      const span = onlySpan('execute_tool test_tool');
      expect('gen_ai.tool.call.arguments' in span.attributes).toBe(captured);
      expect('gen_ai.tool.call.result' in span.attributes).toBe(captured);
    },
  );

  it('turns every experimental feature off, including listed ones, when the run opts out', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY', 'true');
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'grounding,workflow');

    await runWith({adkExperimentalTelemetryOptIn: false});

    expect(groundingAttributes()).toEqual([]);
    expect(
      (await metricNames()).filter((name) => name.startsWith('adk.')),
    ).toEqual([]);
  });

  it('turns every experimental feature on when the run opts in', async () => {
    await runWith({adkExperimentalTelemetryOptIn: true});

    expect(groundingAttributes()).not.toEqual([]);
    expect(await metricNames()).toEqual(
      expect.arrayContaining([
        'adk.experimental.invoke_workflow.inference_calls',
        'adk.experimental.invoke_agent.input_tokens',
      ]),
    );
  });

  it('enables exactly the features the run lists', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY', 'true');
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'grounding');

    await runWith({experimentalFeaturesOptIn: ['workflow']});

    const recorded = await metricNames();
    expect(groundingAttributes()).toEqual([]);
    expect(recorded).toContain(
      'adk.experimental.invoke_workflow.inference_calls',
    );
    expect(recorded).not.toContain(
      'adk.experimental.invoke_agent.input_tokens',
    );
  });

  it.each([
    {name: 'empty', features: []},
    // A JavaScript caller is not held to the feature type.
    {name: 'unrecognized', features: JSON.parse('["not_a_feature"]')},
  ])(
    'falls back to the environment for an $name feature list',
    async ({features}) => {
      vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'grounding');

      await runWith({experimentalFeaturesOptIn: features});

      expect(groundingAttributes()).not.toEqual([]);
      expect(
        (await metricNames()).filter((name) => name.startsWith('adk.')),
      ).toEqual([]);
    },
  );

  it.each(['true', '1', ' TRUE '])(
    'ignores every override when ADK_TELEMETRY_IGNORE_RUN_CONFIG is %j',
    async (lock) => {
      vi.stubEnv('ADK_TELEMETRY_IGNORE_RUN_CONFIG', lock);
      vi.stubEnv(CAPTURE_ENV, 'NO_CONTENT');
      vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'grounding');

      await runWith({
        captureMessageContent: 'SPAN_ONLY',
        adkExperimentalTelemetryOptIn: false,
      });

      expect(
        onlySpan(`generate_content ${MODEL}`).attributes,
      ).not.toHaveProperty('gen_ai.input.messages');
      expect(groundingAttributes()).not.toEqual([]);

      spanExporter.reset();
      await metricReader.collect();
      await runWith({experimentalFeaturesOptIn: ['workflow']});

      expect(groundingAttributes()).not.toEqual([]);
      expect(
        (await metricNames()).filter((name) => name.startsWith('adk.')),
      ).toEqual([]);
    },
  );

  it("applies the run's overrides to the runner's workflow metrics", async () => {
    const agent = new LlmAgent({name: 'test_agent', model: new ScriptedLlm()});
    const runner = new InMemoryRunner({agent, appName: 'test-app'});
    const session = await runner.sessionService.createSession({
      appName: 'test-app',
      userId: USER_ID,
    });

    await drain(
      runner.runAsync({
        userId: USER_ID,
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'hello'}]},
        runConfig: {telemetry: {experimentalFeaturesOptIn: ['workflow']}},
      }),
    );

    expect(await metricNames()).toContain(
      'adk.experimental.invoke_workflow.inference_calls',
    );
  });

  it('keeps the overrides of two concurrent runs apart', async () => {
    async function run(
      agentName: string,
      telemetry: TelemetryConfig,
    ): Promise<void> {
      const agent = new LlmAgent({name: agentName, model: new ScriptedLlm()});
      const runner = new InMemoryRunner({agent, appName: 'test-app'});
      const session = await runner.sessionService.createSession({
        appName: 'test-app',
        userId: USER_ID,
      });
      await drain(
        runner.runAsync({
          userId: USER_ID,
          sessionId: session.id,
          newMessage: {role: 'user', parts: [{text: 'hello'}]},
          runConfig: {telemetry},
        }),
      );
    }

    await Promise.all([
      run('agent_a', {
        captureMessageContent: 'SPAN_ONLY',
        experimentalFeaturesOptIn: ['token_usage'],
      }),
      run('agent_b', {captureMessageContent: 'NO_CONTENT'}),
    ]);

    const inferenceSpanOf = (agentName: string): ReadableSpan => {
      const spans = spansNamed(`generate_content ${MODEL}`).filter(
        (span) => span.attributes['gen_ai.agent.name'] === agentName,
      );
      expect(spans).toHaveLength(1);
      return spans[0];
    };
    expect(inferenceSpanOf('agent_a').attributes).toHaveProperty(
      'gen_ai.input.messages',
    );
    expect(inferenceSpanOf('agent_b').attributes).not.toHaveProperty(
      'gen_ai.input.messages',
    );
    const {resourceMetrics} = await metricReader.collect();
    const agentTokens = resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find(
        (metric) =>
          metric.descriptor.name ===
          'adk.experimental.invoke_agent.input_tokens',
      );
    expect(
      agentTokens?.dataPoints.map(
        (point) => point.attributes['gen_ai.agent.name'],
      ),
    ).toEqual(['agent_a']);
  });
});

describe('instrumentMcpFetch', () => {
  const MCP_EVENT = 'adk.experimental.mcp.http.client.response.end';
  const MCP_URL = 'https://mcp.example.com/mcp';
  const ELIDED_BODY = {
    'http.request.body.content': '<elided>',
    'http.response.body.content': '<elided>',
  };

  function mcpRecords(): ReadableLogRecord[] {
    return logExporter
      .getFinishedLogRecords()
      .filter((record) => record.eventName === MCP_EVENT);
  }

  /** Waits for the one record a call reports in the background. */
  async function onlyMcpRecord(): Promise<ReadableLogRecord> {
    await vi.waitFor(() => expect(mcpRecords()).toHaveLength(1));
    return mcpRecords()[0];
  }

  function jsonResponse(
    body: string,
    {
      status = 200,
      headers = {},
    }: {
      status?: number;
      headers?: Record<string, string>;
    } = {},
  ): Response {
    return new Response(body, {
      status,
      headers: {'content-type': 'application/json', ...headers},
    });
  }

  /** A body stream that never closes. */
  function openStream(): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
      },
    });
  }

  function instrumented(respond: () => Response | Promise<Response>): McpFetch {
    const wrapped = instrumentMcpFetch(async () => respond());
    if (wrapped === undefined) {
      return expect.fail('instrumentMcpFetch returned no fetch');
    }
    return wrapped;
  }

  describe('with the mcp feature off', () => {
    it('returns the given fetch unchanged and emits nothing', async () => {
      const fetch = vi.fn(async () => jsonResponse('{}'));

      const wrapped = instrumentMcpFetch(fetch);
      await wrapped?.(MCP_URL);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(wrapped).toBe(fetch);
      expect(instrumentMcpFetch(undefined)).toBeUndefined();
      expect(mcpRecords()).toEqual([]);
    });
  });

  describe('with the mcp feature on', () => {
    beforeEach(() => {
      vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'mcp');
    });

    it.each([
      {name: 'ADK_EXPERIMENTAL_TELEMETRY_FEATURES', value: 'mcp'},
      {name: 'ADK_EXPERIMENTAL_TELEMETRY', value: 'true'},
    ])(
      'emits one DEBUG record parented to the calling span when $name is $value',
      async ({name, value}) => {
        vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', undefined);
        vi.stubEnv(name, value);
        const fetch = instrumented(() =>
          jsonResponse('{}', {
            headers: {
              'mcp-session-id': 'session-1',
              'mcp-protocol-version': '2025-06-18',
            },
          }),
        );

        const span = trace.getTracer('test').startSpan('caller');
        await context.with(trace.setSpan(context.active(), span), () =>
          fetch(MCP_URL, {method: 'post', body: '{}'}),
        );
        span.end();

        const record = await onlyMcpRecord();
        expect(record.severityNumber).toBe(SeverityNumber.DEBUG);
        expect(record.severityText).toBe('DEBUG');
        expect(record.spanContext?.spanId).toBe(span.spanContext().spanId);
        expect(record.body).toEqual(ELIDED_BODY);
        expect(record.attributes).toEqual({
          'http.request.method': 'POST',
          'url.full': MCP_URL,
          'http.response.status_code': 200,
          'server.address': 'mcp.example.com',
          'mcp.session.id': 'session-1',
          'mcp.protocol.version': '2025-06-18',
        });
      },
    );

    it('records the request and response bodies when asked to', async () => {
      vi.stubEnv('ADK_CAPTURE_MCP_HTTP_BODIES', ' True ');
      const fetch = instrumented(() => jsonResponse('{"result":{}}'));

      await fetch(MCP_URL, {method: 'POST', body: '{"id":1}'});

      expect((await onlyMcpRecord()).body).toEqual({
        'http.request.body.content': '{"id":1}',
        'http.response.body.content': '{"result":{}}',
      });
    });

    it.each([
      {name: 'bytes', body: new TextEncoder().encode('{"id":1}')},
      {name: 'URLSearchParams', body: new URLSearchParams({id: '1'})},
    ])('records a $name request body as text', async ({body}) => {
      vi.stubEnv('ADK_CAPTURE_MCP_HTTP_BODIES', 'true');
      const fetch = instrumented(() => jsonResponse('{}'));

      await fetch(MCP_URL, {method: 'POST', body});

      expect((await onlyMcpRecord()).body).toMatchObject({
        'http.request.body.content':
          body instanceof URLSearchParams ? 'id=1' : '{"id":1}',
      });
    });

    it('leaves out a request body that cannot be read without consuming it', async () => {
      vi.stubEnv('ADK_CAPTURE_MCP_HTTP_BODIES', 'true');
      const fetch = instrumented(() => jsonResponse('{}'));

      await fetch(MCP_URL, {method: 'POST', body: openStream()});

      expect((await onlyMcpRecord()).body).toEqual({
        'http.response.body.content': '{}',
      });
    });

    it.each([
      {
        name: 'a long body',
        body: 'a'.repeat(1001),
        recorded: 'a'.repeat(1000),
      },
      {
        name: 'a body whose cut falls inside a surrogate pair',
        body: 'a'.repeat(999) + '\u{1F600}b',
        recorded: 'a'.repeat(999) + '\u{1F600}',
      },
    ])('truncates $name at 1000 characters', async ({body, recorded}) => {
      vi.stubEnv('ADK_CAPTURE_MCP_HTTP_BODIES', 'true');
      const fetch = instrumented(() => jsonResponse(body));

      await fetch(MCP_URL, {method: 'POST', body});

      expect((await onlyMcpRecord()).body).toEqual({
        'http.request.body.content': `${recorded}... [truncated]`,
        'http.response.body.content': `${recorded}... [truncated]`,
      });
    });

    it('never reads or clones an event stream response', async () => {
      vi.stubEnv('ADK_CAPTURE_MCP_HTTP_BODIES', 'true');
      const response = new Response(openStream(), {
        headers: {'content-type': 'text/event-stream'},
      });
      const clone = vi.spyOn(response, 'clone');
      const fetch = instrumented(() => response);

      const received = await fetch(MCP_URL);

      expect((await onlyMcpRecord()).body).toEqual({
        'http.response.body.content': '<SSE stream>',
      });
      expect(received).toBe(response);
      expect(clone).not.toHaveBeenCalled();
      expect(received.bodyUsed).toBe(false);
      const reader = received.body?.getReader();
      expect((await reader?.read())?.done).toBe(false);
      await reader?.cancel();
    });

    it('hands the response on before its body has been read', async () => {
      vi.stubEnv('ADK_CAPTURE_MCP_HTTP_BODIES', 'true');
      const response = new Response(openStream(), {
        headers: {'content-type': 'application/json'},
      });
      const fetch = instrumented(() => response);

      const received = await fetch(MCP_URL);

      expect(received).toBe(response);
      expect(received.bodyUsed).toBe(false);
      expect(mcpRecords()).toEqual([]);
    });

    it('records no header without an allowlist', async () => {
      const fetch = instrumented(() => jsonResponse('{}'));

      await fetch(MCP_URL, {headers: {'X-Trace': 'a'}});

      expect(
        Object.keys((await onlyMcpRecord()).attributes).filter((key) =>
          key.includes('.header.'),
        ),
      ).toEqual([]);
    });

    it('records allowlisted headers, with credentials redacted', async () => {
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_REQUEST',
        'authorization, x-.*',
      );
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_RESPONSE',
        'Content-Type,set-cookie',
      );
      const fetch = instrumented(() =>
        jsonResponse('{}', {headers: {'set-cookie': 'sid=token-2'}}),
      );

      await fetch(MCP_URL, {
        headers: {
          Authorization: 'Bearer token-1',
          'X-Trace': 'a',
          'Other-Header': 'b',
        },
      });

      const {attributes} = await onlyMcpRecord();
      expect(attributes).toMatchObject({
        'http.request.header.authorization': ['<redacted>'],
        'http.request.header.x-trace': ['a'],
        'http.response.header.content-type': ['application/json'],
        'http.response.header.set-cookie': ['<redacted>'],
      });
      expect(attributes).not.toHaveProperty('http.request.header.other-header');
      expect(JSON.stringify(attributes)).not.toContain('token-');
    });

    it('matches a header pattern against the whole name', async () => {
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_REQUEST',
        'x',
      );
      const fetch = instrumented(() => jsonResponse('{}'));

      await fetch(MCP_URL, {headers: {'X-Trace': 'a'}});

      expect((await onlyMcpRecord()).attributes).not.toHaveProperty(
        'http.request.header.x-trace',
      );
    });

    it('skips a malformed header pattern with a warning', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_REQUEST',
        '(,x-trace',
      );
      const fetch = instrumented(() => jsonResponse('{}'));

      await fetch(MCP_URL, {headers: {'X-Trace': 'a'}});

      expect((await onlyMcpRecord()).attributes).toMatchObject({
        'http.request.header.x-trace': ['a'],
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_REQUEST',
        ),
      );
      warn.mockRestore();
    });

    it('drops userinfo and redacts query values from the URL', async () => {
      const fetch = instrumented(() => jsonResponse('{}'));

      await fetch(
        'https://user:password@mcp.example.com:8443/messages?sessionId=s-1&b=2&b=3&empty=',
      );

      expect((await onlyMcpRecord()).attributes).toMatchObject({
        'url.full':
          'https://mcp.example.com:8443/messages?sessionId=REDACTED&b=REDACTED',
        'server.address': 'mcp.example.com',
        'server.port': 8443,
        'mcp.session.id': 's-1',
      });
    });

    it('falls back to the request headers for the session and protocol', async () => {
      const fetch = instrumented(() => jsonResponse('{}'));

      await fetch(new URL(MCP_URL), {
        headers: {
          'mcp-session-id': 'session-2',
          'mcp-protocol-version': '2025-03-26',
        },
      });

      expect((await onlyMcpRecord()).attributes).toMatchObject({
        'mcp.session.id': 'session-2',
        'mcp.protocol.version': '2025-03-26',
      });
    });

    it('records the status code as the error type of a failed response', async () => {
      const fetch = instrumented(() => jsonResponse('{}', {status: 500}));

      await fetch(MCP_URL);

      expect((await onlyMcpRecord()).attributes).toMatchObject({
        'http.response.status_code': 500,
        'error.type': '500',
      });
    });

    it('records the error type when the response body cannot be read', async () => {
      vi.stubEnv('ADK_CAPTURE_MCP_HTTP_BODIES', 'true');
      const failing = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError('stream broke with token-1'));
        },
      });
      const fetch = instrumented(
        () =>
          new Response(failing, {
            headers: {'content-type': 'application/json'},
          }),
      );

      await fetch(MCP_URL);

      expect((await onlyMcpRecord()).body).toEqual({
        'http.response.body.content': '<failed to read body: TypeError>',
      });
    });

    it('logs and does not throw when the record cannot be emitted', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const failingLogger: Logger = {
        emit() {
          throw new Error('exporter down');
        },
        enabled: () => true,
      };
      const getLogger = vi
        .spyOn(logs, 'getLogger')
        .mockReturnValue(failingLogger);
      const response = jsonResponse('{}');
      const fetch = instrumented(() => response);

      await expect(fetch(MCP_URL)).resolves.toBe(response);

      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          'Failed to record an MCP HTTP exchange: Error',
        ),
      );
      getLogger.mockRestore();
      warn.mockRestore();
    });

    it('sends the request with the given fetch', async () => {
      const response = jsonResponse('{}');
      const userFetch = vi.fn(
        async (_url: string | URL, _init?: Parameters<typeof fetch>[1]) =>
          response,
      );
      const init: NonNullable<Parameters<typeof fetch>[1]> = {
        method: 'POST',
        body: '{}',
      };

      const received = await instrumentMcpFetch(userFetch)?.(MCP_URL, init);

      expect(received).toBe(response);
      expect(userFetch).toHaveBeenCalledWith(MCP_URL, init);
      expect(userFetch.mock.calls[0][1]).toBe(init);
    });

    it('sends the request with the global fetch when none is given', async () => {
      const response = jsonResponse('{}');
      const globalFetch = vi.fn(async () => response);
      const wrapped = instrumentMcpFetch(undefined);
      vi.stubGlobal('fetch', globalFetch);
      const init: NonNullable<Parameters<typeof fetch>[1]> = {
        method: 'POST',
        body: '{}',
      };

      try {
        await expect(wrapped?.(MCP_URL, init)).resolves.toBe(response);
      } finally {
        vi.unstubAllGlobals();
      }

      expect(globalFetch).toHaveBeenCalledWith(MCP_URL, init);
    });

    it('reads its settings when the request is sent', async () => {
      vi.stubEnv('ADK_CAPTURE_MCP_HTTP_BODIES', 'true');
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_REQUEST',
        'x-trace',
      );
      let respond: (response: Response) => void = () => {};
      const fetch = instrumented(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve;
          }),
      );

      const pending = fetch(MCP_URL, {
        method: 'POST',
        body: '{}',
        headers: {'X-Trace': 'a'},
      });
      vi.stubEnv('ADK_CAPTURE_MCP_HTTP_BODIES', undefined);
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_REQUEST',
        undefined,
      );
      respond(jsonResponse('{"ok":true}'));
      await pending;

      const record = await onlyMcpRecord();
      expect(record.body).toEqual({
        'http.request.body.content': '{}',
        'http.response.body.content': '{"ok":true}',
      });
      expect(record.attributes).toMatchObject({
        'http.request.header.x-trace': ['a'],
      });
    });
  });
});
