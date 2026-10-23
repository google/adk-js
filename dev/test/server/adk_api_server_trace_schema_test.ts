/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The per-event and session trace routes under both telemetry schema
 * versions. In a file of its own because the first server started in a
 * process registers the global OTel providers, and later ones cannot.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {context, trace} from '@opentelemetry/api';
import {logs} from '@opentelemetry/api-logs';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';

const MODEL = 'gemini-flash-latest';
const APP_NAME = 'testApp';
const USER_ID = 'test-user';

/** Asks for `some_tool` first, then answers once the tool has responded. */
class ToolCallingLlm extends BaseLlm {
  constructor() {
    super({model: MODEL});
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const answered = llmRequest.contents.some((content) =>
      content.parts?.some((part) => part.functionResponse),
    );
    yield {
      content: {
        role: 'model',
        parts: [
          answered
            ? {text: 'done'}
            : {functionCall: {name: 'some_tool', args: {arg1: 'value'}}},
        ],
      },
      finishReason: FinishReason.STOP,
    };
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('connect is not used in ToolCallingLlm');
  }
}

interface UiSpan {
  name: string;
  trace_id: string;
}

interface Turn {
  modelEventIds: string[];
  functionResponseEventId: string;
  sessionId: string;
}

describe('trace routes by schema version', () => {
  const sessionService = new InMemorySessionService();
  let server: AdkApiServer;

  async function runTurn(sessionId: string): Promise<Turn> {
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId,
    });
    const response = await fetch(`${server.url}/run`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId,
        newMessage: {role: 'user', parts: [{text: 'hello'}]},
      }),
    });
    expect(response.status).toBe(200);
    const events = (await response.json()) as Event[];
    const functionResponseEvent = events.find((event) =>
      event.content?.parts?.some((part) => part.functionResponse),
    );
    expect(functionResponseEvent).toBeDefined();
    return {
      modelEventIds: events
        .filter((event) => event.content?.role === 'model')
        .map((event) => event.id),
      functionResponseEventId: functionResponseEvent?.id ?? '',
      sessionId,
    };
  }

  async function eventTrace(eventId: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${server.url}/debug/trace/${eventId}`);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  async function sessionSpans(sessionId: string): Promise<UiSpan[]> {
    const response = await fetch(
      `${server.url}/debug/trace/session/${sessionId}`,
    );
    return (await response.json()) as UiSpan[];
  }

  beforeAll(async () => {
    for (const name of [
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
      'ADK_TRACE_TO_CLOUD',
      'OTEL_SEMCONV_STABILITY_OPT_IN',
      'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
    ]) {
      vi.stubEnv(name, undefined);
    }
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new ToolCallingLlm(),
      instruction: 'be helpful',
      tools: [
        new FunctionTool({
          name: 'some_tool',
          description: 'A sample tool.',
          parameters: z.object({arg1: z.string()}),
          execute: ({arg1}) => `processed ${arg1}`,
        }),
      ],
    });
    const agentLoader = {
      listAgents: () => Promise.resolve([APP_NAME]),
      getAgentFile: () =>
        Promise.resolve({
          load: () => Promise.resolve(agent),
          [Symbol.asyncDispose]: () => Promise.resolve(),
        }),
    } as unknown as AgentLoader;
    server = new AdkApiServer({agentLoader, sessionService});
    await server.start();
  });

  afterEach(() => {
    vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', undefined);
  });

  afterAll(async () => {
    await server.stop();
    logs.disable();
    trace.disable();
    context.disable();
    vi.unstubAllEnvs();
  });

  it('finds the generate_content span of each model event under schema v2', async () => {
    vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '2');
    const turn = await runTurn('session-v2-events');

    expect(turn.modelEventIds).toHaveLength(2);
    for (const eventId of turn.modelEventIds) {
      expect(await eventTrace(eventId)).toMatchObject({
        'gen_ai.operation.name': 'generate_content',
        'gcp.vertex.agent.event_id': eventId,
      });
    }
    expect(await eventTrace(turn.functionResponseEventId)).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'some_tool',
      'gcp.vertex.agent.event_id': turn.functionResponseEventId,
    });
  });

  it('finds the call_llm span of each model event under schema v1', async () => {
    vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');
    const turn = await runTurn('session-v1-events');

    expect(turn.modelEventIds).toHaveLength(2);
    for (const eventId of turn.modelEventIds) {
      expect(await eventTrace(eventId)).toMatchObject({
        'gen_ai.system': 'gcp.vertex.agent',
        'gcp.vertex.agent.event_id': eventId,
      });
    }
    expect(await eventTrace(turn.functionResponseEventId)).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'some_tool',
      'gcp.vertex.agent.event_id': turn.functionResponseEventId,
    });
  });

  it.each([
    {
      schema: '2',
      names: [
        'execute_tool some_tool',
        `generate_content ${MODEL}`,
        `generate_content ${MODEL}`,
        'invoke_agent test_agent',
        'invoke_workflow test_agent',
      ],
    },
    {
      schema: '1',
      names: [
        'call_llm',
        'call_llm',
        'execute_tool some_tool',
        `generate_content ${MODEL}`,
        `generate_content ${MODEL}`,
        'invocation',
        'invoke_agent test_agent',
      ],
    },
  ])(
    'returns every span of the session under schema v$schema',
    async ({schema, names}) => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', schema);
      const turn = await runTurn(`session-v${schema}-trace`);

      const spans = await sessionSpans(turn.sessionId);

      expect(spans.map((span) => span.name).sort()).toEqual(names);
      expect(new Set(spans.map((span) => span.trace_id)).size).toBe(1);
    },
  );
});
