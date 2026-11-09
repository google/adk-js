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
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';

const {handleFunctionCallList} = functionsExportedForTestingOnly;

const INVOCATION_ID = 'inv_telemetry_1';

let exporter: InMemorySpanExporter;
let contextManager: AsyncLocalStorageContextManager;
let provider: BasicTracerProvider;

const echoTool = new FunctionTool({
  name: 'echoTool',
  description: 'echoes a value',
  parameters: z.object({}),
  execute: async () => ({result: 'echoed'}),
});

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
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  contextManager.disable();
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
  it('records the tool, its agent and the call id on a single tool span', async () => {
    const event = await handleFunctionCallList({
      invocationContext: createInvocationContext(),
      functionCalls: [createCall('call-1')],
      toolsDict: {echoTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const span = onlySpan('execute_tool echoTool');
    expect(span.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'echoTool',
      'gen_ai.tool.description': 'echoes a value',
      'gen_ai.tool.type': 'FunctionTool',
      'gen_ai.agent.name': 'test_agent',
      'gen_ai.tool.call.id': 'call-1',
    });
    expect(span.attributes).not.toHaveProperty('gen_ai.system');
    expect(span.attributes).not.toHaveProperty(
      'gcp.vertex.agent.invocation_id',
    );
  });

  it('records the merged response event id on a merged tool span', async () => {
    const event = await handleFunctionCallList({
      invocationContext: createInvocationContext(),
      functionCalls: [createCall('call-1'), createCall('call-2')],
      toolsDict: {echoTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const span = onlySpan('execute_tool (merged)');
    expect(span.attributes).toEqual({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': '(merged tools)',
      'gen_ai.tool.description': '(merged tools)',
      'gen_ai.tool.call.id': event?.id,
      'gcp.vertex.agent.event_id': event?.id,
    });
  });

  it('records a call to a tool the agent does not have on its own tool span', async () => {
    await handleFunctionCallList({
      invocationContext: createInvocationContext(),
      functionCalls: [{id: 'call-1', name: 'missingTool', args: {}}],
      toolsDict: {echoTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(onlySpan('execute_tool missingTool').attributes).toMatchObject({
      'gen_ai.tool.name': 'missingTool',
      'gen_ai.agent.name': 'test_agent',
    });
  });
});
