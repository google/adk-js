/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  type BaseLlmConnection,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {z} from 'zod';

import {BigQueryAgentAnalyticsPlugin} from '../../../src/plugins/bigquery_agent_analytics/bigquery_agent_analytics_plugin.js';
import type {EventRow} from '../../../src/plugins/bigquery_agent_analytics/event_schema.js';

let mockAppendedRows: EventRow[] = [];

class FakeTable {
  async get(): Promise<[FakeTable]> {
    return [this];
  }
}

class FakeDataset {
  table(): FakeTable {
    return new FakeTable();
  }
  async createTable(): Promise<[FakeTable]> {
    return [new FakeTable()];
  }
}

class FakeBigQuery {
  dataset(): FakeDataset {
    return new FakeDataset();
  }
}

class FakePendingWrite {
  async getResult(): Promise<unknown> {
    return {};
  }
}

class FakeJSONWriter {
  appendRows(rows: EventRow[]): FakePendingWrite {
    mockAppendedRows.push(...rows);
    return new FakePendingWrite();
  }
  close(): void {}
}

class FakeWriterClient {
  async createStreamConnection(): Promise<unknown> {
    return {};
  }
  close(): void {}
}

vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: FakeBigQuery,
}));

vi.mock('@google-cloud/bigquery-storage', () => ({
  managedwriter: {
    WriterClient: FakeWriterClient,
    JSONWriter: FakeJSONWriter,
  },
  adapt: {
    convertBigQuerySchemaToStorageTableSchema: () => ({}),
    convertStorageSchemaToProto2Descriptor: () => ({name: 'EventRow'}),
  },
}));

class ScriptedMockLlm extends BaseLlm {
  private callCount = 0;
  constructor(readonly responses: Array<(req: LlmRequest) => LlmResponse>) {
    super({model: 'scripted-mock-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const fn =
      this.responses[this.callCount++] ??
      this.responses[this.responses.length - 1];
    yield fn(request);
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('connect not implemented');
  }
}

describe('trace_correlation', () => {
  const spanExporter = new InMemorySpanExporter();
  const contextManager = new AsyncLocalStorageContextManager();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });

  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
    trace.setGlobalTracerProvider(tracerProvider);
  });

  afterAll(async () => {
    await tracerProvider.shutdown();
    trace.disable();
    context.disable();
    contextManager.disable();
  });

  beforeEach(() => {
    spanExporter.reset();
    mockAppendedRows = [];
  });

  it('correlates trace_id and span_id with active ADK OpenTelemetry spans', async () => {
    const plugin = new BigQueryAgentAnalyticsPlugin({
      projectId: 'test-project',
      datasetId: 'test_dataset',
      config: {
        enableOtelCorrelation: true,
        flushOnRunEnd: true,
      },
    });

    const tool = new FunctionTool({
      name: 'test_tool',
      description: 'A test tool',
      parameters: z.object({}),
      execute: async () => ({result: 'ok'}),
    });

    const llm = new ScriptedMockLlm([
      () => ({
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'call-1', name: 'test_tool', args: {}}}],
        },
      }),
      () => ({
        content: {role: 'model', parts: [{text: 'Final response.'}]},
      }),
    ]);

    const agent = new LlmAgent({
      name: 'otel_agent',
      model: llm,
      tools: [tool],
      beforeAgentCallback: async (ctx) => {
        await plugin.beforeAgentCallback({agent, callbackContext: ctx});
        return undefined;
      },
      afterAgentCallback: async (ctx) => {
        await plugin.afterAgentCallback({agent, callbackContext: ctx});
        return undefined;
      },
    });

    const runner = new InMemoryRunner({
      agent,
      plugins: [plugin],
    });

    await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'u1',
      sessionId: 's1',
    });

    for await (const _ of runner.runAsync({
      userId: 'u1',
      sessionId: 's1',
      newMessage: {parts: [{text: 'Hello'}]},
    })) {
      // Consume event
    }

    await plugin.flush();

    const finishedSpans = spanExporter.getFinishedSpans();
    const workflowSpan = finishedSpans.find(
      (s) => s.name === 'invoke_workflow' || s.name.includes('workflow'),
    );
    const agentSpan = finishedSpans.find(
      (s) => s.name === 'invoke_agent' || s.name.includes('agent'),
    );

    expect(workflowSpan).toBeDefined();
    const expectedTraceId = workflowSpan?.spanContext().traceId;
    const expectedWorkflowSpanId = workflowSpan?.spanContext().spanId;

    // Every row's trace_id equals the exported invoke_workflow trace ID
    expect(mockAppendedRows.length).toBeGreaterThan(0);
    for (const row of mockAppendedRows) {
      expect(row.trace_id).toBe(expectedTraceId);
    }

    // INVOCATION_STARTING and INVOCATION_COMPLETED span_id equals the invoke_workflow span id
    const invStart = mockAppendedRows.find(
      (r) => r.event_type === 'INVOCATION_STARTING',
    );
    const invEnd = mockAppendedRows.find(
      (r) => r.event_type === 'INVOCATION_COMPLETED',
    );

    expect(invStart?.span_id).toBe(expectedWorkflowSpanId);
    expect(invEnd?.span_id).toBe(expectedWorkflowSpanId);

    // With enableOtelCorrelation: true:
    // attributes.otel.span_id matches the active OTel span at callback time
    if (invStart) {
      const attrs = JSON.parse(invStart.attributes) as {
        otel?: {span_id: string};
      };
      expect(attrs.otel?.span_id).toBe(expectedWorkflowSpanId);
    }

    const agentStart = mockAppendedRows.find(
      (r) => r.event_type === 'AGENT_STARTING',
    );
    if (agentStart && agentSpan) {
      const attrs = JSON.parse(agentStart.attributes) as {
        otel?: {span_id: string};
      };
      expect(attrs.otel?.span_id).toBe(agentSpan.spanContext().spanId);
    }

    // Model and tool callbacks in adk-js run inside the agent scope (invoke_agent)
    const modelReq = mockAppendedRows.find(
      (r) => r.event_type === 'LLM_REQUEST',
    );
    if (modelReq && agentSpan) {
      const attrs = JSON.parse(modelReq.attributes) as {
        otel?: {span_id: string};
      };
      expect(attrs.otel?.span_id).toBe(agentSpan.spanContext().spanId);
    }
  });

  it('generates 32-hex trace IDs when no ambient OpenTelemetry tracer provider is active', async () => {
    // Disable active tracer for this test
    trace.disable();

    try {
      const plugin = new BigQueryAgentAnalyticsPlugin({
        projectId: 'test-project',
        datasetId: 'test_dataset',
      });

      const llm = new ScriptedMockLlm([
        () => ({content: {role: 'model', parts: [{text: 'Response'}]}}),
      ]);
      const agent = new LlmAgent({name: 'non_otel_agent', model: llm});
      const runner = new InMemoryRunner({agent, plugins: [plugin]});

      await runner.sessionService.createSession({
        appName: runner.appName,
        userId: 'u1',
        sessionId: 's1',
      });

      for await (const _ of runner.runAsync({
        userId: 'u1',
        sessionId: 's1',
        newMessage: {parts: [{text: 'Hi'}]},
      })) {
        // Consume event
      }

      await plugin.flush();

      expect(mockAppendedRows.length).toBeGreaterThan(0);
      const firstTraceId = mockAppendedRows[0].trace_id;

      expect(typeof firstTraceId).toBe('string');
      expect(firstTraceId?.length).toBe(32);

      // Same trace id for all rows within this invocation
      for (const row of mockAppendedRows) {
        expect(row.trace_id).toBe(firstTraceId);
      }
    } finally {
      // Re-enable for other suites
      trace.setGlobalTracerProvider(tracerProvider);
    }
  });
});
