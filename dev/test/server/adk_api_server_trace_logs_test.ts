/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The session trace routes, with the log records the dev UI shows under each
 * span. In a file of its own because the first server started in a process
 * registers the global OTel providers, and later ones cannot.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  InMemorySessionService,
  LlmAgent,
  LlmResponse,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {context, trace} from '@opentelemetry/api';
import {logs} from '@opentelemetry/api-logs';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';

const MODEL = 'gemini-flash-latest';

class FakeLlm extends BaseLlm {
  constructor() {
    super({model: MODEL});
  }

  override async *generateContentAsync(): AsyncGenerator<
    LlmResponse,
    void,
    void
  > {
    yield {
      content: {role: 'model', parts: [{text: 'world'}]},
      finishReason: FinishReason.STOP,
    };
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('connect is not used in FakeLlm');
  }
}

interface UiSpan {
  name: string;
  span_id: string;
  trace_id: string;
  start_time: number;
  end_time: number;
  attributes: Record<string, unknown>;
  parent_span_id: string | null;
  logs: Array<{
    event_name: string;
    body: unknown;
    attributes: Record<string, unknown>;
  }>;
}

describe('session trace logs', () => {
  const sessionService = new InMemorySessionService();
  let server: AdkApiServer;

  beforeAll(async () => {
    for (const name of [
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
      'ADK_TRACE_TO_CLOUD',
      'ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN',
      'OTEL_SEMCONV_STABILITY_OPT_IN',
      'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
    ]) {
      vi.stubEnv(name, undefined);
    }
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new FakeLlm(),
      instruction: 'be helpful',
    });
    const agentLoader = {
      listAgents: () => Promise.resolve(['testApp']),
      getAgentFile: () =>
        Promise.resolve({
          load: () => Promise.resolve(agent),
          [Symbol.asyncDispose]: () => Promise.resolve(),
        }),
    } as unknown as AgentLoader;
    server = new AdkApiServer({agentLoader, sessionService});
    await server.start();

    await sessionService.createSession({
      appName: 'testApp',
      userId: 'test-user',
      sessionId: 'session-1',
    });
    const response = await fetch(`${server.url}/run`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        appName: 'testApp',
        userId: 'test-user',
        sessionId: 'session-1',
        newMessage: {role: 'user', parts: [{text: 'hello'}]},
      }),
    });
    expect(response.status).toBe(200);
  });

  afterAll(async () => {
    await server.stop();
    logs.disable();
    trace.disable();
    context.disable();
    vi.unstubAllEnvs();
  });

  it.each([
    '/debug/trace/session/session-1',
    '/dev/apps/testApp/debug/trace/session/session-1',
  ])('returns logs on every span from %s', async (route) => {
    const response = await fetch(`${server.url}${route}`);
    const spans = (await response.json()) as UiSpan[];

    expect(spans.length).toBeGreaterThan(1);
    for (const span of spans) {
      expect(span).toEqual(
        expect.objectContaining({
          name: expect.any(String),
          span_id: expect.any(String),
          trace_id: expect.any(String),
          start_time: expect.any(Number),
          end_time: expect.any(Number),
          attributes: expect.any(Object),
          logs: expect.any(Array),
        }),
      );
      expect(span).toHaveProperty('parent_span_id');
    }

    const inference = spans.find(
      (span) => span.name === `generate_content ${MODEL}`,
    );
    expect(inference?.logs).toEqual([
      {
        event_name: 'gen_ai.client.inference.operation.details',
        body: null,
        attributes: expect.objectContaining({
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
          'gen_ai.system_instructions': [
            expect.objectContaining({type: 'text'}),
          ],
          'user.id': 'test-user',
        }),
      },
    ]);
    const others = spans.filter((span) => span !== inference);
    expect(others.length).toBeGreaterThan(0);
    for (const span of others) {
      expect(span.logs).toEqual([]);
    }
  });
});
