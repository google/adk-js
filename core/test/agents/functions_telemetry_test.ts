/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives the real tool-call path with a real tracer, so the span attributes
 * the call sites in `core/src/agents/functions.ts` supply are asserted on the
 * exported span rather than on a mock.
 */

import {
  createSession,
  functionsExportedForTestingOnly,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {context, SpanStatusCode, trace} from '@opentelemetry/api';
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
  vi,
} from 'vitest';
import {z} from 'zod';

const {handleFunctionCallList} = functionsExportedForTestingOnly;

const INVOCATION_ID = 'inv_telemetry_1';

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

const echoTool = new FunctionTool({
  name: 'echoTool',
  description: 'echoes a value',
  parameters: z.object({}),
  execute: async () => ({result: 'echoed'}),
});

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
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function createInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: INVOCATION_ID,
    session: createSession({
      id: 'session-1',
      appName: 'test-app',
      userId: 'test-user',
    }),
    agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
    pluginManager: new PluginManager(),
  });
}

function createCall(id: string): FunctionCall {
  return {id, name: 'echoTool', args: {}};
}

function onlySpan(name: string): ReadableSpan {
  const matches = exporter.getFinishedSpans().filter((s) => s.name === name);
  expect(matches.map((s) => s.name)).toEqual([name]);
  return matches[0];
}

describe('tool span attributes from the function call path', () => {
  it('records gen_ai.agent.name and no gen_ai.system or invocation id on a single tool span', async () => {
    const event = await handleFunctionCallList({
      invocationContext: createInvocationContext(),
      functionCalls: [createCall('call-1')],
      toolsDict: {echoTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const span = onlySpan('execute_tool echoTool');
    expect(span.attributes['gen_ai.agent.name']).toBe('test_agent');
    expect(span.attributes).not.toHaveProperty('gen_ai.system');
    expect(span.attributes).not.toHaveProperty(
      'gcp.vertex.agent.invocation_id',
    );
  });

  it('records no gen_ai.system or invocation id on a merged tool span', async () => {
    const event = await handleFunctionCallList({
      invocationContext: createInvocationContext(),
      functionCalls: [createCall('call-1'), createCall('call-2')],
      toolsDict: {echoTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const span = onlySpan('execute_tool (merged)');
    expect(span.attributes).not.toHaveProperty('gen_ai.system');
    expect(span.attributes).not.toHaveProperty(
      'gcp.vertex.agent.invocation_id',
    );
    expect(span.attributes['gcp.vertex.agent.event_id']).toBe(event?.id);
  });

  it('records the id of the emitted function response event on the tool span', async () => {
    const event = await handleFunctionCallList({
      invocationContext: createInvocationContext(),
      functionCalls: [createCall('call-1')],
      toolsDict: {echoTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    expect(
      onlySpan('execute_tool echoTool').attributes['gcp.vertex.agent.event_id'],
    ).toBe(event?.id);
  });
});

describe('cyclic tool results', () => {
  function createCyclicTool() {
    return new FunctionTool({
      name: 'echoTool',
      description: 'returns a cyclic value',
      parameters: z.object({}),
      execute: async () => {
        const result: Record<string, unknown> = {status: 'kept'};
        result['self'] = result;
        return result;
      },
    });
  }

  it.each([
    {
      schema: 'v1',
      env: {ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN: '1'},
      attribute: 'gcp.vertex.agent.tool_response',
    },
    {
      schema: 'v2',
      env: {
        ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN: '2',
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'SPAN_ONLY',
      },
      attribute: 'gen_ai.tool.call.result',
    },
  ])(
    'passes the tool result to the function response event under $schema',
    async ({env, attribute}) => {
      for (const [name, value] of Object.entries(env)) {
        vi.stubEnv(name, value);
      }

      const event = await handleFunctionCallList({
        invocationContext: createInvocationContext(),
        functionCalls: [createCall('call-1')],
        toolsDict: {echoTool: createCyclicTool()},
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      });

      const response = event?.content?.parts?.[0]?.functionResponse?.response;
      expect(response?.['status']).toBe('kept');
      expect(response?.['self']).toBe(response);
      const span = onlySpan('execute_tool echoTool');
      expect(span.attributes[attribute]).toBe('<not serializable>');
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
    },
  );

  it('passes the tool results to the function response event of merged calls', async () => {
    vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');

    const event = await handleFunctionCallList({
      invocationContext: createInvocationContext(),
      functionCalls: [createCall('call-1'), createCall('call-2')],
      toolsDict: {echoTool: createCyclicTool()},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const responses = (event?.content?.parts ?? []).map(
      (part) => part.functionResponse?.response,
    );
    expect(responses.map((response) => response?.['status'])).toEqual([
      'kept',
      'kept',
    ]);
    expect(
      onlySpan('execute_tool (merged)').attributes[
        'gcp.vertex.agent.tool_response'
      ],
    ).toBe('<not serializable>');
  });
});
