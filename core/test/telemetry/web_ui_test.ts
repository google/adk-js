/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {context, trace} from '@opentelemetry/api';
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
  INFERENCE_SCOPE_KEY,
  startInferenceSpan,
  traceInferenceResult,
} from '../../src/telemetry/tracing.js';
import {WebUiLogProcessor} from '../../src/telemetry/web_ui.js';

const COMPLETION_DETAILS = 'gen_ai.client.inference.operation.details';
const MODEL = 'gemini-flash-latest';

const spanExporter = new InMemorySpanExporter();
const logExporter = new InMemoryLogRecordExporter();
const contextManager = new AsyncLocalStorageContextManager();
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
let webUiProcessor = new WebUiLogProcessor();
/**
 * One provider for the whole file: the ADK logger caches the provider it first
 * delegates to, so each test swaps in a fresh processor behind this one.
 */
const loggerProvider = new LoggerProvider({
  processors: [
    {
      onEmit: (record, otelContext) =>
        webUiProcessor.onEmit(record, otelContext),
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    },
    new SimpleLogRecordProcessor({exporter: logExporter}),
  ],
});

function createInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'invocation-1',
    agent: new LlmAgent({name: 'test-agent', description: 'A test agent'}),
    session: createSession({
      id: 'session-1',
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function runInference(): void {
  const invocationContext = createInvocationContext();
  const llmRequest: LlmRequest = {
    model: MODEL,
    contents: [{role: 'user', parts: [{text: 'hello'}]}],
    config: {systemInstruction: 'be helpful'},
    liveConnectConfig: {},
    toolsDict: {},
  };
  const llmResponse: LlmResponse = {
    content: {role: 'model', parts: [{text: 'world'}]},
    finishReason: FinishReason.STOP,
  };
  const gcSpan = startInferenceSpan({llmRequest, invocationContext});
  traceInferenceResult({
    invocationContext,
    generateContentSpan: gcSpan,
    llmResponse,
  });
  finishInferenceSpan({generateContentSpan: gcSpan, invocationContext});
}

describe('WebUiLogProcessor', () => {
  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
    trace.setGlobalTracerProvider(tracerProvider);
    logs.setGlobalLoggerProvider(loggerProvider);
  });

  afterAll(async () => {
    await tracerProvider.shutdown();
    await loggerProvider.shutdown();
    logs.disable();
    trace.disable();
    context.disable();
    contextManager.disable();
  });

  beforeEach(() => {
    spanExporter.reset();
    logExporter.reset();
    webUiProcessor = new WebUiLogProcessor();
    for (const name of [
      'ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN',
      'OTEL_SEMCONV_STABILITY_OPT_IN',
      'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
      'ADK_TELEMETRY_IGNORE_RUN_CONFIG',
    ]) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('restores content on its copy while the exported record has none', () => {
    runInference();

    const gcSpan = spanExporter
      .getFinishedSpans()
      .find((span) => span.name === `generate_content ${MODEL}`);
    expect(gcSpan).toBeDefined();
    const [exported] = logExporter.getFinishedLogRecords();
    expect(exported.eventName).toBe(COMPLETION_DETAILS);
    expect(exported.attributes).not.toHaveProperty('gen_ai.input.messages');
    expect(exported.attributes).not.toHaveProperty('gen_ai.output.messages');
    expect(exported.attributes).not.toHaveProperty(
      'gen_ai.system_instructions',
    );
    expect(exported.attributes).not.toHaveProperty('user.id');

    const [uiLog] = webUiProcessor.getFinishedLogs();
    expect(uiLog.spanId).toBe(gcSpan?.spanContext().spanId);
    expect(uiLog.eventName).toBe(COMPLETION_DETAILS);
    expect(uiLog.body).toBeNull();
    expect(uiLog.attributes).toMatchObject({
      ...exported.attributes,
      'gen_ai.input.messages': [
        {role: 'user', parts: [{type: 'text', content: 'hello'}]},
      ],
      'gen_ai.output.messages': [
        {
          role: 'assistant',
          parts: [{type: 'text', content: 'world'}],
          finish_reason: 'stop',
        },
      ],
      'gen_ai.system_instructions': [{type: 'text', content: 'be helpful'}],
      'user.id': 'test-user',
    });
  });

  it('keeps only completion-details records', () => {
    const otelLogger = loggerProvider.getLogger('test');
    trace.getTracer('test').startActiveSpan('span', (span) => {
      otelLogger.emit({eventName: 'gen_ai.choice', body: 'ignored'});
      otelLogger.emit({eventName: COMPLETION_DETAILS, body: 'kept'});
      span.end();
    });

    expect(webUiProcessor.getFinishedLogs().map((log) => log.body)).toEqual([
      'kept',
    ]);
  });

  it('base64-encodes bytes with the standard alphabet', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const otelLogger = loggerProvider.getLogger('test');
    trace.getTracer('test').startActiveSpan('span', (span) => {
      otelLogger.emit({
        eventName: COMPLETION_DETAILS,
        body: {data: bytes, nested: [bytes]},
        attributes: {payload: bytes},
        context: context.active().setValue(INFERENCE_SCOPE_KEY, {
          contentAttributes: {'gen_ai.input.messages': [{raw: bytes}]},
        }),
      });
      span.end();
    });

    const [uiLog] = webUiProcessor.getFinishedLogs();
    expect(uiLog.body).toEqual({data: '+/+/', nested: ['+/+/']});
    expect(uiLog.attributes['payload']).toBe('+/+/');
    expect(uiLog.attributes['gen_ai.input.messages']).toEqual([{raw: '+/+/'}]);
  });

  it('keeps the newest 1000 records', () => {
    const otelLogger = loggerProvider.getLogger('test');
    trace.getTracer('test').startActiveSpan('span', (span) => {
      for (let i = 0; i < 1001; i++) {
        otelLogger.emit({eventName: COMPLETION_DETAILS, body: i});
      }
      span.end();
    });

    const kept = webUiProcessor.getFinishedLogs();
    expect(kept).toHaveLength(1000);
    expect(kept[0].body).toBe(1);
    expect(kept[999].body).toBe(1000);
  });
});
