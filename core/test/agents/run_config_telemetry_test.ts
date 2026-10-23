/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  ContentCapturingMode,
  createRunConfig,
  InMemorySessionService,
  LlmAgent,
  LlmResponse,
  RunConfig,
  Runner,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {context} from '@opentelemetry/api';
import {logs} from '@opentelemetry/api-logs';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
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

const COMPLETION_DETAILS = 'gen_ai.client.inference.operation.details';

const logExporter = new InMemoryLogRecordExporter();
const loggerProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({exporter: logExporter})],
});
const contextManager = new AsyncLocalStorageContextManager();

/** A model that answers once, after a short pause so two runs interleave. */
class SlowFakeLlm extends BaseLlm {
  constructor() {
    super({model: 'gemini-flash-latest'});
  }

  override async *generateContentAsync(): AsyncGenerator<
    LlmResponse,
    void,
    void
  > {
    await new Promise((resolve) => setTimeout(resolve, 10));
    yield {
      content: {role: 'model', parts: [{text: 'answer'}]},
      finishReason: FinishReason.STOP,
    };
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('connect is not used in SlowFakeLlm');
  }
}

describe('RunConfig.telemetry', () => {
  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
    logs.setGlobalLoggerProvider(loggerProvider);
  });

  afterAll(async () => {
    await loggerProvider.shutdown();
    logs.disable();
    context.disable();
    contextManager.disable();
  });

  beforeEach(() => {
    logExporter.reset();
    for (const name of [
      'ADK_TELEMETRY_IGNORE_RUN_CONFIG',
      'ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN',
      'OTEL_SEMCONV_STABILITY_OPT_IN',
      'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
    ]) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function runConcurrently(
    configs: Record<string, RunConfig>,
  ): Promise<void> {
    const sessionService = new InMemorySessionService();
    const runner = new Runner({
      appName: 'test-app',
      agent: new LlmAgent({name: 'test_agent', model: new SlowFakeLlm()}),
      sessionService,
    });
    await Promise.all(
      Object.entries(configs).map(async ([sessionId, runConfig]) => {
        await sessionService.createSession({
          appName: 'test-app',
          userId: 'test-user',
          sessionId,
        });
        for await (const _event of runner.runAsync({
          userId: 'test-user',
          sessionId,
          newMessage: {role: 'user', parts: [{text: 'question'}]},
          runConfig,
        })) {
          // Drain the run.
        }
      }),
    );
  }

  function completionDetailsFor(sessionId: string) {
    const records = logExporter
      .getFinishedLogRecords()
      .filter(
        (record) =>
          record.eventName === COMPLETION_DETAILS &&
          record.attributes['gen_ai.conversation.id'] === sessionId,
      );
    expect(records).toHaveLength(1);
    return records[0];
  }

  it('gives two concurrent runs the content capture each one asked for', async () => {
    await runConcurrently({
      'with-content': {
        telemetry: {captureMessageContent: ContentCapturingMode.EVENT_ONLY},
      },
      'without-content': {
        telemetry: {captureMessageContent: ContentCapturingMode.NO_CONTENT},
      },
    });

    const withContent = completionDetailsFor('with-content');
    const withoutContent = completionDetailsFor('without-content');
    expect(withContent.attributes['user.id']).toBe('test-user');
    expect(withContent.attributes['gen_ai.input.messages']).toEqual([
      {role: 'user', parts: [{type: 'text', content: 'question'}]},
    ]);
    expect(withContent.attributes['gen_ai.output.messages']).toEqual([
      {
        role: 'assistant',
        parts: [{type: 'text', content: 'answer'}],
        finish_reason: 'stop',
      },
    ]);
    expect(withoutContent.attributes).not.toHaveProperty('user.id');
    expect(withoutContent.attributes).not.toHaveProperty(
      'gen_ai.input.messages',
    );
    expect(withoutContent.attributes).not.toHaveProperty(
      'gen_ai.output.messages',
    );
  });

  it('ignores the per-run value under ADK_TELEMETRY_IGNORE_RUN_CONFIG', async () => {
    vi.stubEnv('ADK_TELEMETRY_IGNORE_RUN_CONFIG', 'true');

    await runConcurrently({
      locked: {
        telemetry: {captureMessageContent: ContentCapturingMode.EVENT_ONLY},
      },
    });

    expect(completionDetailsFor('locked').attributes).not.toHaveProperty(
      'gen_ai.input.messages',
    );
  });

  it('switches a run to the stable records with genaiSemconvStabilityOptIn', async () => {
    await runConcurrently({
      stable: {telemetry: {genaiSemconvStabilityOptIn: 'stable'}},
    });

    const eventNames = logExporter
      .getFinishedLogRecords()
      .map((record) => record.eventName);
    expect(eventNames).toContain('gen_ai.user.message');
    expect(eventNames).toContain('gen_ai.choice');
    expect(eventNames).not.toContain(COMPLETION_DETAILS);
  });

  it('is kept by createRunConfig', () => {
    const telemetry = {captureMessageContent: ContentCapturingMode.EVENT_ONLY};

    expect(createRunConfig({telemetry}).telemetry).toBe(telemetry);
  });
});
