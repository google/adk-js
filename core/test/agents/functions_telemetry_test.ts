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
import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
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
  it('records gen_ai.system and the invocation id on a single tool span', async () => {
    const event = await handleFunctionCallList({
      invocationContext: createInvocationContext(),
      functionCalls: [createCall('call-1')],
      toolsDict: {echoTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const span = onlySpan('execute_tool echoTool');
    expect(span.attributes['gen_ai.system']).toBe('gcp.vertex.agent');
    expect(span.attributes['gcp.vertex.agent.invocation_id']).toBe(
      INVOCATION_ID,
    );
  });

  it('records gen_ai.system and the invocation id on a merged tool span', async () => {
    const event = await handleFunctionCallList({
      invocationContext: createInvocationContext(),
      functionCalls: [createCall('call-1'), createCall('call-2')],
      toolsDict: {echoTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const span = onlySpan('execute_tool (merged)');
    expect(span.attributes['gen_ai.system']).toBe('gcp.vertex.agent');
    expect(span.attributes['gcp.vertex.agent.invocation_id']).toBe(
      INVOCATION_ID,
    );
  });
});
