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
import {context, metrics, SpanStatusCode, trace} from '@opentelemetry/api';
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

/**
 * A metric reader that collects only when asked, with DELTA temporality, so
 * each collection holds exactly what was recorded since the previous one.
 */
class ManualMetricReader extends MetricReader {
  constructor() {
    super({
      aggregationTemporalitySelector: () => AggregationTemporality.DELTA,
    });
  }

  protected override async onForceFlush(): Promise<void> {}

  protected override async onShutdown(): Promise<void> {}
}

const metricReader = new ManualMetricReader();
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

beforeEach(() => {
  spanExporter.reset();
  logExporter.reset();
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
    // A browser or worker has no `process`, so no environment to read.
    vi.stubGlobal('process', undefined);
    try {
      await drain(
        recordInference(inferenceParams(), () =>
          streamOf([textResponse('done', {finishReason: FinishReason.STOP})]),
        ),
      );
    } finally {
      vi.unstubAllGlobals();
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

describe('telemetry logger', () => {
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
    expect(
      onlySpan(`generate_content ${MODEL}`).instrumentationScope.schemaUrl,
    ).toBe('https://opentelemetry.io/schemas/1.44.0');
  });

  it('reaches a provider registered after earlier records were emitted', async () => {
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
    } finally {
      logs.disable();
      logs.setGlobalLoggerProvider(loggerProvider);
    }

    expect(lateExporter.getFinishedLogRecords()).toHaveLength(1);
    expect(inferenceLogs()).toEqual([]);
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
});

describe('metrics', () => {
  const CALL_COUNT_BUCKETS = [
    0, 1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 64, 128, 256, 512,
  ];
  const OUTPUT_TOKEN_BUCKETS = [
    0, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
    131072,
  ];
  const AGENT_DURATION_BUCKETS = [
    0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2, 102.4, 204.8, 409.6,
  ];

  const rootAgent = new LlmAgent({name: 'root_agent'});
  const innerAgent = new LlmAgent({name: 'inner_agent'});
  const nestedWorkflow = new Workflow({
    name: 'nested_workflow',
    edges: [['START', new FunctionNode('step', () => 'out')]],
  });

  interface Point {
    readonly attributes: Record<string, unknown>;
    /** The counter value, or the histogram sum. */
    readonly value: number | undefined;
    /** The number of measurements in a histogram point. */
    readonly count?: number;
  }

  async function collect(reader: MetricReader = metricReader) {
    const {resourceMetrics} = await reader.collect();
    return resourceMetrics.scopeMetrics;
  }

  async function collectMetrics(
    reader: MetricReader = metricReader,
  ): Promise<MetricData[]> {
    return (await collect(reader)).flatMap((scope) => scope.metrics);
  }

  function find(data: readonly MetricData[], name: string): MetricData {
    const metric = data.find((m) => m.descriptor.name === name);
    if (!metric) {
      expect.fail(`metric ${name} was not recorded`);
    }
    return metric;
  }

  function pointsOf(data: readonly MetricData[], name: string): Point[] {
    const metric = data.find((m) => m.descriptor.name === name);
    if (!metric) {
      return [];
    }
    if (metric.dataPointType === DataPointType.HISTOGRAM) {
      return metric.dataPoints.map((dp) => ({
        attributes: dp.attributes,
        value: dp.value.sum,
        count: dp.value.count,
      }));
    }
    if (metric.dataPointType === DataPointType.SUM) {
      return metric.dataPoints.map((dp) => ({
        attributes: dp.attributes,
        value: dp.value,
      }));
    }
    return expect.fail(`metric ${name} has an unexpected type`);
  }

  function valueOf(
    data: readonly MetricData[],
    name: string,
    attributes: Record<string, unknown>,
  ): number | undefined {
    const points = pointsOf(data, name).filter((point) =>
      Object.entries(attributes).every(
        ([key, value]) => point.attributes[key] === value,
      ),
    );
    expect(points, name).toHaveLength(1);
    return points[0].value;
  }

  function names(data: readonly MetricData[]): string[] {
    return data.map((m) => m.descriptor.name);
  }

  function invocationContextFor(agent: LlmAgent): InvocationContext {
    return new InvocationContext({
      invocationId: INVOCATION_ID,
      agent,
      session: createSession({
        id: SESSION_ID,
        appName: 'test-app',
        userId: USER_ID,
      }),
      pluginManager: new PluginManager([]),
    });
  }

  async function callModel(
    invocationContext: InvocationContext,
    responses: readonly LlmResponse[] = [
      textResponse('done', {finishReason: FinishReason.STOP}),
    ],
  ): Promise<void> {
    await drain(
      recordInference({...inferenceParams(), invocationContext}, () =>
        streamOf(responses),
      ),
    );
  }

  async function callTool(invocationContext: InvocationContext) {
    await recordToolExecution(
      {
        tool: new FunctionTool({
          name: 'test_tool',
          description: 'A test tool',
          execute: () => ({}),
        }),
        args: {},
        invocationContext,
      },
      async () => {},
    );
  }

  async function runAgent(
    agent: LlmAgent,
    body: (invocationContext: InvocationContext) => Promise<void>,
  ): Promise<void> {
    const invocationContext = invocationContextFor(agent);
    await drain(
      recordAgentInvocation({agent, invocationContext}, async function* () {
        yield* [];
        await body(invocationContext);
      }),
    );
  }

  /**
   * Runs `root_agent` under the runner's invocation scope. It calls the model
   * once, transfers to `inner_agent`, which calls the model and a tool, and
   * then runs a nested workflow that calls the model once more.
   */
  async function runNestedInvocation(): Promise<void> {
    await drain(
      recordInvocation(
        {entrypoint: rootAgent, sessionId: SESSION_ID},
        async function* () {
          yield* [];
          await runAgent(rootAgent, async (invocationContext) => {
            await callModel(invocationContext);
            await runAgent(innerAgent, async (innerContext) => {
              await callModel(innerContext);
              await callTool(innerContext);
            });
            const scope = recordWorkflowInvocation({
              workflow: nestedWorkflow,
              sessionId: SESSION_ID,
            });
            await scope.run(() => callModel(invocationContext));
            scope.end();
          });
        },
      ),
    );
  }

  beforeEach(async () => {
    await metricReader.collect();
  });

  it('uses the same instrumentation scope as the tracer', async () => {
    await runAgent(rootAgent, async () => {});

    const [scope] = (await collect()).map((s) => s.scope);
    const span = onlySpan('invoke_agent root_agent');
    expect(scope).toEqual({
      name: 'gcp.vertex.agent',
      version,
      schemaUrl: 'https://opentelemetry.io/schemas/1.44.0',
    });
    expect(scope).toEqual(span.instrumentationScope);
  });

  it('reaches a provider registered after earlier records', async () => {
    await runAgent(rootAgent, async () => {});
    const lateReader = new ManualMetricReader();
    const lateProvider = new MeterProvider({readers: [lateReader]});
    metrics.disable();
    metrics.setGlobalMeterProvider(lateProvider);
    try {
      await metricReader.collect();
      await runAgent(rootAgent, async () => {});
    } finally {
      metrics.disable();
      metrics.setGlobalMeterProvider(meterProvider);
    }

    expect(
      pointsOf(
        await collectMetrics(lateReader),
        'gen_ai.invoke_agent.duration',
      ),
    ).toHaveLength(1);
    expect(
      pointsOf(await collectMetrics(), 'gen_ai.invoke_agent.duration'),
    ).toEqual([]);
    await lateProvider.shutdown();
  });

  it('does not record removed GenAI client duration or token usage metrics', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY', 'true');

    await runAgent(rootAgent, (invocationContext) =>
      callModel(invocationContext),
    );

    const recorded = names(await collectMetrics());
    expect(recorded).not.toContain('gen_ai.client.operation.duration');
    expect(recorded).not.toContain('gen_ai.client.token.usage');
  });

  it('accumulates the newest cumulative usage report, not their sum', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'token_usage');
    const chunk = (
      candidatesTokenCount: number,
      finishReason?: FinishReason,
    ): LlmResponse => ({
      content: {role: 'model', parts: [{text: 'x'}]},
      usageMetadata: {promptTokenCount: 10, candidatesTokenCount},
      finishReason,
    });

    await runAgent(rootAgent, (invocationContext) =>
      callModel(invocationContext, [
        chunk(1),
        chunk(5, FinishReason.STOP),
        // Arrives after the span ended; still the call's newest report.
        chunk(9),
        {content: {role: 'model', parts: [{text: 'no usage'}]}},
      ]),
    );

    const data = await collectMetrics();
    const root = {'gen_ai.agent.name': 'root_agent'};
    expect(
      valueOf(data, 'adk.experimental.invoke_agent.input_tokens', root),
    ).toBe(10);
    expect(
      valueOf(data, 'adk.experimental.invoke_agent.output_tokens', root),
    ).toBe(9);
  });

  it('accumulates usage reported before a model stream throws', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'token_usage');
    const error = new ApiError({status: 429, message: 'quota'});

    await expect(
      runAgent(rootAgent, async (invocationContext) => {
        await drain(
          recordInference(
            {...inferenceParams(), invocationContext},
            async function* () {
              yield textResponse('partial', {
                finishReason: FinishReason.STOP,
              });
              throw error;
            },
          ),
        );
      }),
    ).rejects.toBe(error);

    const data = await collectMetrics();
    const root = {'gen_ai.agent.name': 'root_agent'};
    expect(pointsOf(data, 'gen_ai.invoke_agent.duration')).toEqual([
      expect.objectContaining({
        attributes: {...root, 'error.type': '429'},
      }),
    ]);
    expect(valueOf(data, 'gen_ai.invoke_agent.inference_calls', root)).toBe(1);
    expect(
      valueOf(data, 'adk.experimental.invoke_agent.input_tokens', root),
    ).toBe(103);
    expect(
      valueOf(data, 'adk.experimental.invoke_agent.output_tokens', root),
    ).toBe(25);
  });

  it('records error.type on tool duration when a tool throws', async () => {
    const error = new ToolExecutionError('failed', ToolErrorType.BAD_REQUEST);

    await expect(
      recordToolExecution(
        {
          tool: new FunctionTool({
            name: 'test_tool',
            description: 'A test tool',
            execute: () => ({}),
          }),
          args: {},
          invocationContext: createInvocationContext(),
        },
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);

    expect(
      pointsOf(await collectMetrics(), 'gen_ai.execute_tool.duration'),
    ).toEqual([
      expect.objectContaining({
        attributes: {
          'gen_ai.agent.name': 'test_agent',
          'gen_ai.tool.name': 'test_tool',
          'gen_ai.tool.type': 'FunctionTool',
          'error.type': ToolErrorType.BAD_REQUEST,
        },
      }),
    ]);
  });

  it('counts calls exclusively per agent', async () => {
    await runNestedInvocation();

    const data = await collectMetrics();
    const root = {'gen_ai.agent.name': 'root_agent'};
    const inner = {'gen_ai.agent.name': 'inner_agent'};
    expect(valueOf(data, 'gen_ai.invoke_agent.inference_calls', root)).toBe(2);
    expect(valueOf(data, 'gen_ai.invoke_agent.tool_calls', root)).toBe(0);
    expect(valueOf(data, 'gen_ai.invoke_agent.inference_calls', inner)).toBe(1);
    expect(valueOf(data, 'gen_ai.invoke_agent.tool_calls', inner)).toBe(1);
    expect(pointsOf(data, 'gen_ai.invoke_agent.duration')).toHaveLength(2);
  });

  it('counts calls inclusively per workflow', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY', 'true');

    await runNestedInvocation();

    const data = await collectMetrics();
    const root = {
      'adk.experimental.root_agent.name': 'root_agent',
      'gen_ai.workflow.name': 'root_agent',
    };
    const nested = {
      'adk.experimental.root_agent.name': 'root_agent',
      'gen_ai.workflow.name': 'nested_workflow',
      'gen_ai.workflow.nested': true,
    };
    const calls = 'adk.experimental.invoke_workflow.inference_calls';
    expect(pointsOf(data, calls).map((p) => p.attributes)).toEqual(
      expect.arrayContaining([root, nested]),
    );
    expect(valueOf(data, calls, root)).toBe(3);
    expect(valueOf(data, calls, nested)).toBe(1);
    expect(
      valueOf(data, 'adk.experimental.invoke_workflow.tool_calls', root),
    ).toBe(1);
    expect(
      valueOf(data, 'adk.experimental.invoke_workflow.input_tokens', root),
    ).toBe(3 * 103);
    expect(
      valueOf(data, 'adk.experimental.invoke_workflow.total_tokens', nested),
    ).toBe(103 + 25);
    expect(
      pointsOf(data, 'gen_ai.invoke_workflow.duration').map(
        (p) => p.attributes,
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          'gen_ai.operation.name': 'invoke_workflow',
          'gen_ai.workflow.name': 'root_agent',
        },
        {
          'gen_ai.operation.name': 'invoke_workflow',
          'gen_ai.workflow.name': 'nested_workflow',
          'gen_ai.workflow.nested': true,
        },
      ]),
    );
  });

  it('records no experimental metric without the experimental opt-in', async () => {
    await runNestedInvocation();

    const recorded = names(await collectMetrics());
    expect(recorded).toContain('gen_ai.invoke_agent.inference_calls');
    expect(recorded.filter((name) => name.startsWith('adk.'))).toEqual([]);
  });

  it('records workflow call counts but no tokens for the workflow feature alone', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'workflow');

    await runNestedInvocation();

    const recorded = names(await collectMetrics());
    expect(recorded).toContain(
      'adk.experimental.invoke_workflow.inference_calls',
    );
    expect(recorded).toContain('adk.experimental.invoke_workflow.tool_calls');
    expect(recorded).not.toContain(
      'adk.experimental.invoke_workflow.input_tokens',
    );
    expect(recorded).not.toContain(
      'adk.experimental.invoke_agent.input_tokens',
    );
    expect(recorded).not.toContain(
      'adk.experimental.invoke_workflow.skill.loads',
    );
  });

  it('records agent tokens but no workflow totals for the token_usage feature alone', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'token_usage');

    await runNestedInvocation();

    const data = await collectMetrics();
    expect(
      valueOf(data, 'adk.experimental.invoke_agent.input_tokens', {
        'gen_ai.agent.name': 'root_agent',
      }),
    ).toBe(2 * 103);
    expect(
      valueOf(data, 'adk.experimental.invoke_agent.reasoning.output_tokens', {
        'gen_ai.agent.name': 'inner_agent',
      }),
    ).toBe(5);
    expect(
      names(data).filter((name) =>
        name.startsWith('adk.experimental.invoke_workflow.'),
      ),
    ).toEqual([]);
  });

  it('records zero counts but skips tokens when no call reported usage', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY', 'true');

    await runAgent(rootAgent, async (invocationContext) => {
      await callModel(invocationContext, [
        {
          content: {role: 'model', parts: [{text: 'done'}]},
          usageMetadata: {},
          finishReason: FinishReason.STOP,
        },
      ]);
    });
    await runAgent(innerAgent, async () => {});

    const data = await collectMetrics();
    const inner = {'gen_ai.agent.name': 'inner_agent'};
    expect(valueOf(data, 'gen_ai.invoke_agent.inference_calls', inner)).toBe(0);
    expect(valueOf(data, 'gen_ai.invoke_agent.tool_calls', inner)).toBe(0);
    expect(
      valueOf(data, 'adk.experimental.invoke_agent.skill.loads', inner),
    ).toBe(0);
    expect(names(data)).not.toContain(
      'adk.experimental.invoke_agent.input_tokens',
    );
  });

  it('declares units, descriptions and bucket boundaries', async () => {
    vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY', 'true');

    await runAgent(rootAgent, (invocationContext) =>
      callModel(invocationContext),
    );

    const data = await collectMetrics();
    const boundaries = (name: string): number[] => {
      const metric = find(data, name);
      if (metric.dataPointType !== DataPointType.HISTOGRAM) {
        return expect.fail(`${name} is not a histogram`);
      }
      return metric.dataPoints[0].value.buckets.boundaries;
    };
    expect(find(data, 'gen_ai.invoke_agent.duration').descriptor).toMatchObject(
      {unit: 's', description: 'Duration of agent invocations.'},
    );
    expect(boundaries('gen_ai.invoke_agent.duration')).toEqual(
      AGENT_DURATION_BUCKETS,
    );
    expect(
      find(data, 'gen_ai.invoke_agent.inference_calls').descriptor,
    ).toMatchObject({
      unit: '1',
      description: 'Number of inference (model) calls per agent invocation.',
    });
    expect(boundaries('gen_ai.invoke_agent.inference_calls')).toEqual(
      CALL_COUNT_BUCKETS,
    );
    const outputTokens = find(
      data,
      'adk.experimental.invoke_agent.output_tokens',
    ).descriptor;
    expect(outputTokens.unit).toBe('{token}');
    expect(outputTokens.description).toBe(
      'Output (completion) tokens, summing candidate and reasoning tokens.' +
        ' The tokens a model spends emitting a tool call are candidate' +
        ' tokens, so they count here. Summed over one agent invocation.',
    );
    expect(boundaries('adk.experimental.invoke_agent.output_tokens')).toEqual(
      OUTPUT_TOKEN_BUCKETS,
    );
  });

  it('records a workflow once when its scope is ended twice', async () => {
    const scope = recordWorkflowInvocation({
      workflow: nestedWorkflow,
      sessionId: SESSION_ID,
    });
    scope.end(new TypeError('failed'));
    scope.end();

    expect(
      pointsOf(await collectMetrics(), 'gen_ai.invoke_workflow.duration'),
    ).toEqual([
      expect.objectContaining({
        attributes: {
          'gen_ai.operation.name': 'invoke_workflow',
          'gen_ai.workflow.name': 'nested_workflow',
          'error.type': 'TypeError',
        },
        count: 1,
      }),
    ]);
  });

  describe('skills', () => {
    const skill = {
      frontmatter: {name: 'my-skill', description: 'A skill.'},
      instructions: 'do things',
      resources: {scripts: {'run.py': {src: 'print(1)'}}},
    };

    async function runSkillTool(
      activity: Parameters<typeof recordSkillActivity>[0],
      {resolved, rawResult}: {resolved: boolean; rawResult?: unknown},
    ): Promise<void> {
      await recordToolExecution(
        {
          tool: new FunctionTool({
            name: 'skill_tool',
            description: 'Uses a skill.',
            execute: () => ({}),
          }),
          args: {},
          invocationContext: createInvocationContext(),
        },
        async (scope) => {
          const skillActivity = recordSkillActivity(activity);
          if (resolved) {
            skillActivity.recordSkill(skill);
          }
          scope.recordSuccess({rawResult});
        },
      );
    }

    beforeEach(() => {
      vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'skills');
    });

    it('records a load that resolved no skill as hallucinated, with its error', async () => {
      await runSkillTool(
        {kind: 'load', skillName: 'made-up'},
        {
          resolved: false,
          rawResult: {error: 'not found', error_code: 'SKILL_NOT_FOUND'},
        },
      );

      expect(
        pointsOf(await collectMetrics(), 'adk.experimental.skill.loads'),
      ).toEqual([
        {
          attributes: {
            'gen_ai.agent.name': 'test_agent',
            'gen_ai.skill.name': '<hallucinated>',
            'error.type': 'SKILL_NOT_FOUND',
          },
          value: 1,
        },
      ]);
    });

    it('records a resolved load by the skill name', async () => {
      await runSkillTool(
        {kind: 'load', skillName: 'my-skill'},
        {resolved: true},
      );

      expect(
        pointsOf(await collectMetrics(), 'adk.experimental.skill.loads'),
      ).toEqual([
        {
          attributes: {
            'gen_ai.agent.name': 'test_agent',
            'gen_ai.skill.name': 'my-skill',
          },
          value: 1,
        },
      ]);
    });

    it.each([
      {scriptPath: 'scripts/run.py', recorded: 'scripts/run.py'},
      {scriptPath: 'run.py', recorded: 'run.py'},
      {scriptPath: 'scripts/other.py', recorded: '<hallucinated>'},
    ])(
      'records the script path $scriptPath as $recorded',
      async ({scriptPath, recorded}) => {
        await runSkillTool(
          {kind: 'script', skillName: 'my-skill', scriptPath},
          {resolved: true},
        );

        expect(
          pointsOf(
            await collectMetrics(),
            'adk.experimental.skill.script.executions',
          ),
        ).toEqual([
          {
            attributes: {
              'gen_ai.agent.name': 'test_agent',
              'gen_ai.skill.name': 'my-skill',
              'gen_ai.skill.resource.name': recorded,
            },
            value: 1,
          },
        ]);
      },
    );

    it('counts loads against the agent', async () => {
      await runAgent(innerAgent, async (invocationContext) => {
        await recordToolExecution(
          {
            tool: new FunctionTool({
              name: 'load_skill',
              description: 'Loads.',
              execute: () => ({}),
            }),
            args: {},
            invocationContext,
          },
          async () => {
            recordSkillActivity({kind: 'load', skillName: 'my-skill'});
          },
        );
      });

      expect(
        valueOf(
          await collectMetrics(),
          'adk.experimental.invoke_agent.skill.loads',
          {'gen_ai.agent.name': 'inner_agent'},
        ),
      ).toBe(1);
    });
  });

  it.each([
    {addsSummary: true, compactions: 1},
    {addsSummary: false, compactions: 0},
  ])(
    'counts a compaction against the workflow when it adds a summary ($addsSummary)',
    async ({addsSummary, compactions}) => {
      vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'workflow,compaction');
      const invocationContext = createInvocationContext();

      await drain(
        recordInvocation(
          {entrypoint: rootAgent, sessionId: SESSION_ID},
          async function* () {
            yield* [];
            await recordCompaction(
              {
                invocationContext,
                trigger: ContextCompactionTrigger.AgentControlled,
              },
              async () => {
                if (addsSummary) {
                  invocationContext.session.events.push(
                    createCompactedEvent({
                      id: 'summary',
                      startTime: 0,
                      endTime: 1,
                      compactedContent: 'summary',
                    }),
                  );
                }
              },
            );
          },
        ),
      );

      expect(
        valueOf(
          await collectMetrics(),
          'adk.experimental.invoke_workflow.compactions',
          {'gen_ai.workflow.name': 'root_agent'},
        ),
      ).toBe(compactions);
    },
  );
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
