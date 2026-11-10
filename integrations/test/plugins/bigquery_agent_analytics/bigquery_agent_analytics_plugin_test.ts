/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  BaseAgent,
  BaseLlm,
  type BaseLlmConnection,
  BaseTool,
  Context,
  type Event,
  FunctionTool,
  InMemoryRunner,
  type InvocationContext,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  LoadMcpResourceTool,
  type MCPSessionManager,
  MCPTool,
  type MCPToolset,
  RemoteA2AAgent,
  type SkillRegistry,
  SkillToolset,
  ToolboxToolset,
  WebMCPTool,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

import {
  BigQueryAgentAnalyticsPlugin,
  getToolOrigin,
} from '../../../src/plugins/bigquery_agent_analytics/bigquery_agent_analytics_plugin.js';
import {
  EVENTS_SCHEMA,
  type EventRow,
} from '../../../src/plugins/bigquery_agent_analytics/event_schema.js';
import type {RawTableField} from '../../../src/plugins/bigquery_agent_analytics/storage_write_client.js';

interface FakeCreatedTable {
  readonly tableId: string;
  readonly metadata: unknown;
}

const mockCreatedTables: FakeCreatedTable[] = [];
const mockExecutedQueries: string[] = [];
const mockSetMetadataCalls: unknown[] = [];
let mockAppendedRows: EventRow[] = [];
let shouldTableExist = true;
let tableGetError: unknown = null;
let fakeExistingTableMetadata: {
  schema?: {fields?: RawTableField[]};
  labels?: Record<string, string>;
} = {
  schema: {
    fields: JSON.parse(JSON.stringify(EVENTS_SCHEMA)) as RawTableField[],
  },
  labels: {adk_schema_version: '2'},
};

class FakeTable {
  metadata = fakeExistingTableMetadata;

  constructor(readonly id: string) {}

  async get(): Promise<[FakeTable]> {
    if (tableGetError) {
      throw tableGetError;
    }
    if (!shouldTableExist) {
      const err = new Error('Table not found');
      (err as {code?: number}).code = 404;
      throw err;
    }
    this.metadata = fakeExistingTableMetadata;
    return [this];
  }

  async getMetadata(): Promise<[typeof fakeExistingTableMetadata]> {
    return [this.metadata];
  }

  async setMetadata(metadata: unknown): Promise<[unknown]> {
    mockSetMetadataCalls.push(metadata);
    return [metadata];
  }
}

class FakeDataset {
  constructor(readonly id: string) {}

  table(tableId: string): FakeTable {
    return new FakeTable(tableId);
  }

  async createTable(tableId: string, metadata: unknown): Promise<[FakeTable]> {
    mockCreatedTables.push({tableId, metadata});
    shouldTableExist = true;
    return [new FakeTable(tableId)];
  }
}

class FakeBigQuery {
  dataset(datasetId: string): FakeDataset {
    return new FakeDataset(datasetId);
  }

  async query(sql: string): Promise<[unknown[]]> {
    mockExecutedQueries.push(sql);
    return [[]];
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
  constructor(
    readonly responses: Array<(req: LlmRequest) => LlmResponse | Error>,
  ) {
    super({model: 'scripted-mock-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const fn =
      this.responses[this.callCount++] ??
      this.responses[this.responses.length - 1];
    const res = fn(request);
    if (res instanceof Error) {
      throw res;
    }
    yield res;
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('connect not implemented');
  }
}

async function runTurn(
  runner: InMemoryRunner,
  userId: string,
  sessionId: string,
  text: string,
): Promise<void> {
  await runner.sessionService.createSession({
    appName: runner.appName,
    userId,
    sessionId,
  });
  for await (const _ of runner.runAsync({
    userId,
    sessionId,
    newMessage: {parts: [{text}]},
  })) {
    // consume stream
  }
}

describe('BigQueryAgentAnalyticsPlugin', () => {
  beforeEach(() => {
    mockCreatedTables.length = 0;
    mockExecutedQueries.length = 0;
    mockSetMetadataCalls.length = 0;
    mockAppendedRows = [];
    shouldTableExist = true;
    tableGetError = null;
    fakeExistingTableMetadata = {
      schema: {
        fields: JSON.parse(JSON.stringify(EVENTS_SCHEMA)) as RawTableField[],
      },
      labels: {adk_schema_version: '2'},
    };
  });

  it('logs the expected event sequence for a tool-calling agent turn on a plain InMemoryRunner', async () => {
    const plugin = new BigQueryAgentAnalyticsPlugin({
      projectId: 'test-project',
      datasetId: 'test_dataset',
      tableId: 'agent_events',
      config: {
        batchSize: 1,
        flushOnRunEnd: true,
      },
    });

    const weatherTool = new FunctionTool({
      name: 'get_weather',
      description: 'Get weather for location',
      parameters: z.object({
        location: z.string(),
      }),
      execute: async () => ({forecast: 'Sunny in Seattle'}),
    });

    const llm = new ScriptedMockLlm([
      // First model response: calls tool
      () => ({
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'get_weather',
                args: {location: 'Seattle'},
              },
            },
          ],
        },
      }),
      // Second model response: final answer
      () => ({
        content: {
          role: 'model',
          parts: [{text: 'It is sunny in Seattle.'}],
        },
      }),
    ]);

    const agent = new LlmAgent({
      name: 'weather_assistant',
      model: llm,
      tools: [weatherTool],
      instruction: 'Help with weather.',
    });

    const runner = new InMemoryRunner({
      agent,
      plugins: [plugin],
    });

    await runTurn(
      runner,
      'user-42',
      'sess-99',
      'What is the weather in Seattle?',
    );

    await plugin.flush();

    const eventTypes = mockAppendedRows.map((r) => r.event_type);
    expect(eventTypes).toEqual([
      'INVOCATION_STARTING',
      'LLM_REQUEST',
      'LLM_RESPONSE',
      'TOOL_STARTING',
      'TOOL_COMPLETED',
      'LLM_REQUEST',
      'LLM_RESPONSE',
      'INVOCATION_COMPLETED',
    ]);

    // Check row schema columns
    for (const row of mockAppendedRows) {
      expect(row.timestamp).toBeInstanceOf(Date);
      expect(typeof row.event_id).toBe('string');
      expect(row.event_id.length).toBe(32);
      expect(row.session_id).toBe('sess-99');
      expect(row.user_id).toBe('user-42');
      expect(row.agent).toBe('weather_assistant');
      expect(row.status).toBe('OK');

      const parsedAttrs = JSON.parse(row.attributes) as Record<string, unknown>;
      expect(parsedAttrs['adk']).toEqual({
        schema_version: '1',
        app_name: 'InMemoryRunner',
      });
      expect(parsedAttrs['root_agent_name']).toBe('weather_assistant');
    }

    // Check execution tree span linkage (LLM/tool spans parent directly to invocation)
    const invocationStart = mockAppendedRows[0];
    const llmReq1 = mockAppendedRows[1];
    const toolStart = mockAppendedRows[3];

    expect(llmReq1.parent_span_id).toBe(invocationStart.span_id);
    expect(toolStart.parent_span_id).toBe(invocationStart.span_id);

    // Verify tool row contents
    const toolStartRow = mockAppendedRows[3];
    expect(toolStartRow.content).toContain('get_weather');
    expect(toolStartRow.content).toContain('Seattle');
    expect(toolStartRow.content).toContain('LOCAL');

    const toolCompletedRow = mockAppendedRows[4];
    expect(toolCompletedRow.content).toContain('Sunny in Seattle');
  });

  it('logs AGENT_STARTING and AGENT_COMPLETED when beforeAgentCallback and afterAgentCallback are invoked', async () => {
    const plugin = new BigQueryAgentAnalyticsPlugin({
      projectId: 'test-project',
      datasetId: 'test_dataset',
    });

    const llm = new ScriptedMockLlm([
      () => ({content: {role: 'model', parts: [{text: 'Done'}]}}),
    ]);
    const agent = new LlmAgent({
      name: 'direct_agent',
      model: llm,
      description: 'Direct agent description',
      instruction: 'Follow instructions.',
    });
    const runner = new InMemoryRunner({agent, plugins: [plugin]});
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'u1',
      sessionId: 's1',
    });

    const callbackContext = new Context({
      invocationContext: {
        invocationId: 'inv-direct',
        agent,
        session,
        userId: 'u1',
      } as unknown as ConstructorParameters<
        typeof Context
      >[0]['invocationContext'],
    });

    await plugin.beforeAgentCallback({agent, callbackContext});
    await plugin.afterAgentCallback({agent, callbackContext});
    await plugin.flush();

    expect(mockAppendedRows.map((r) => r.event_type)).toEqual([
      'AGENT_STARTING',
      'AGENT_COMPLETED',
    ]);
    expect(mockAppendedRows[0].content).toBe(
      JSON.stringify('Follow instructions.'),
    );
    const attrs = JSON.parse(mockAppendedRows[0].attributes) as Record<
      string,
      unknown
    >;
    expect(attrs['agent_description']).toBe('Direct agent description');
    expect(attrs['model']).toBe('scripted-mock-llm');
  });

  it('records TOOL_ERROR when a tool throws without duplicate TOOL_COMPLETED', async () => {
    const plugin = new BigQueryAgentAnalyticsPlugin({
      projectId: 'test-project',
      datasetId: 'test_dataset',
    });

    const failingTool = new FunctionTool({
      name: 'failing_tool',
      description: 'Always fails',
      parameters: z.object({}),
      execute: async () => {
        throw new Error('Database connection failed');
      },
    });

    const llm = new ScriptedMockLlm([
      () => ({
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'call-fail', name: 'failing_tool', args: {}}},
          ],
        },
      }),
      () => ({
        content: {role: 'model', parts: [{text: 'Tool failed.'}]},
      }),
    ]);

    const agent = new LlmAgent({
      name: 'error_agent',
      model: llm,
      tools: [failingTool],
    });

    const runner = new InMemoryRunner({agent, plugins: [plugin]});
    await runTurn(runner, 'u1', 's1', 'Run failing tool');
    await plugin.flush();

    const toolRows = mockAppendedRows.filter((r) =>
      r.event_type.startsWith('TOOL_'),
    );
    expect(toolRows.map((r) => r.event_type)).toEqual([
      'TOOL_STARTING',
      'TOOL_ERROR',
    ]);
    expect(toolRows[1].status).toBe('ERROR');
    expect(toolRows[1].error_message).toContain('Database connection failed');
  });

  it('records TOOL_ERROR when a tool returns isError: true result', async () => {
    const plugin = new BigQueryAgentAnalyticsPlugin({
      projectId: 'test-project',
      datasetId: 'test_dataset',
    });

    const softFailingTool = new FunctionTool({
      name: 'soft_fail_tool',
      description: 'Returns error flag',
      parameters: z.object({}),
      execute: async () => ({isError: true, error: 'Soft failure reported'}),
    });

    const llm = new ScriptedMockLlm([
      () => ({
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'call-soft', name: 'soft_fail_tool', args: {}}},
          ],
        },
      }),
      () => ({
        content: {role: 'model', parts: [{text: 'Done.'}]},
      }),
    ]);

    const agent = new LlmAgent({
      name: 'soft_error_agent',
      model: llm,
      tools: [softFailingTool],
    });

    const runner = new InMemoryRunner({agent, plugins: [plugin]});
    await runTurn(runner, 'u1', 's1', 'Run soft fail');
    await plugin.flush();

    const toolErrorRow = mockAppendedRows.find(
      (r) => r.event_type === 'TOOL_ERROR',
    );
    expect(toolErrorRow).toBeDefined();
    expect(toolErrorRow?.status).toBe('ERROR');
    expect(toolErrorRow?.error_message).toContain('Soft failure reported');
  });

  it('records LLM_ERROR when model execution fails', async () => {
    const plugin = new BigQueryAgentAnalyticsPlugin({
      projectId: 'test-project',
      datasetId: 'test_dataset',
    });

    const llm = new ScriptedMockLlm([
      () => new Error('Quota exceeded on model API'),
    ]);

    const agent = new LlmAgent({
      name: 'failing_llm_agent',
      model: llm,
    });

    const runner = new InMemoryRunner({agent, plugins: [plugin]});

    await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'u1',
      sessionId: 's1',
    });

    try {
      for await (const _ of runner.runAsync({
        userId: 'u1',
        sessionId: 's1',
        newMessage: {parts: [{text: 'Hello'}]},
      })) {
        // Consume event
      }
    } catch {
      // Expected runner error
    }

    await plugin.flush();

    const llmErrorRow = mockAppendedRows.find(
      (r) => r.event_type === 'LLM_ERROR',
    );
    expect(llmErrorRow).toBeDefined();
    expect(llmErrorRow?.status).toBe('ERROR');
    expect(llmErrorRow?.error_message).toContain('Quota exceeded');
  });

  it('filters events with eventAllowlist and eventDenylist', async () => {
    const plugin = new BigQueryAgentAnalyticsPlugin({
      projectId: 'test-project',
      datasetId: 'test_dataset',
      config: {
        eventAllowlist: ['INVOCATION_STARTING', 'INVOCATION_COMPLETED'],
      },
    });

    const llm = new ScriptedMockLlm([
      () => ({content: {parts: [{text: 'Hi'}]}}),
    ]);

    const agent = new LlmAgent({name: 'filtered_agent', model: llm});
    const runner = new InMemoryRunner({agent, plugins: [plugin]});

    await runTurn(runner, 'u1', 's1', 'Hi');
    await plugin.flush();

    const types = mockAppendedRows.map((r) => r.event_type);
    expect(types).toEqual(['INVOCATION_STARTING', 'INVOCATION_COMPLETED']);
  });

  it('never logs and never initializes SDK when enabled is false', async () => {
    const plugin = new BigQueryAgentAnalyticsPlugin({
      projectId: 'test-project',
      datasetId: 'test_dataset',
      config: {enabled: false},
    });

    const llm = new ScriptedMockLlm([
      () => ({content: {parts: [{text: 'Hi'}]}}),
    ]);
    const agent = new LlmAgent({name: 'disabled_agent', model: llm});
    const runner = new InMemoryRunner({agent, plugins: [plugin]});

    await runTurn(runner, 'u1', 's1', 'Hi');
    await plugin.flush();
    expect(mockAppendedRows.length).toBe(0);
  });

  it('creates table with partitioning, clustering, labels, and views when table is missing (404)', async () => {
    shouldTableExist = false;

    const plugin = new BigQueryAgentAnalyticsPlugin({
      projectId: 'test-project',
      datasetId: 'test_dataset',
      tableId: 'custom_events_table',
      config: {
        createViews: true,
        viewPrefix: 'v_custom',
      },
    });

    const llm = new ScriptedMockLlm([
      () => ({content: {parts: [{text: 'Hi'}]}}),
    ]);
    const agent = new LlmAgent({name: 'init_agent', model: llm});
    const runner = new InMemoryRunner({agent, plugins: [plugin]});

    await runTurn(runner, 'u1', 's1', 'Hi');
    await plugin.flush();

    expect(mockCreatedTables.length).toBe(1);
    expect(mockCreatedTables[0].tableId).toBe('custom_events_table');

    const meta = mockCreatedTables[0].metadata as Record<string, unknown>;
    expect(meta['timePartitioning']).toEqual({
      type: 'DAY',
      field: 'timestamp',
    });
    expect(meta['clustering']).toEqual({
      fields: ['event_type', 'agent', 'user_id'],
    });
    expect(meta['labels']).toEqual({
      adk_schema_version: '2',
    });

    expect(mockExecutedQueries.length).toBeGreaterThan(0);
    expect(
      mockExecutedQueries.some((q) =>
        q.includes(
          'CREATE OR REPLACE VIEW `test-project.test_dataset.v_custom_llm_request`',
        ),
      ),
    ).toBe(true);
  });

  it('performs additive schema upgrade when existing table is missing columns', async () => {
    shouldTableExist = true;
    fakeExistingTableMetadata = {
      schema: {
        fields: [
          {name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED'},
          {name: 'event_id', type: 'STRING', mode: 'NULLABLE'},
        ],
      },
      labels: {adk_schema_version: '1'},
    };

    const plugin = new BigQueryAgentAnalyticsPlugin({
      projectId: 'test-project',
      datasetId: 'test_dataset',
      config: {
        autoSchemaUpgrade: true,
        createViews: false,
      },
    });

    const llm = new ScriptedMockLlm([
      () => ({content: {parts: [{text: 'Hi'}]}}),
    ]);
    const agent = new LlmAgent({name: 'upgrade_agent', model: llm});
    const runner = new InMemoryRunner({agent, plugins: [plugin]});

    await runTurn(runner, 'u1', 's1', 'Hi');
    await plugin.flush();

    expect(mockSetMetadataCalls.length).toBe(1);
    const updated = mockSetMetadataCalls[0] as {
      schema: {fields: RawTableField[]};
      labels: Record<string, string>;
    };
    expect(updated.schema.fields.length).toBe(17);
    expect(updated.labels['adk_schema_version']).toBe('2');
  });

  it('classifies tool origin across LOCAL, SUB_AGENT, A2A, MCP, TRANSFER_AGENT, TRANSFER_A2A, TOOLBOX, SKILL, and UNKNOWN', async () => {
    const localTool = new FunctionTool({
      name: 'local_fn',
      description: 'Local',
      parameters: z.object({}),
      execute: async () => ({}),
    });
    expect(getToolOrigin(localTool)).toBe('LOCAL');

    const subLlmAgent = new LlmAgent({
      name: 'sub_llm',
      model: 'gemini-flash-latest',
    });
    const subAgentTool = new AgentTool({agent: subLlmAgent});
    expect(getToolOrigin(subAgentTool)).toBe('SUB_AGENT');

    const remoteA2a = new RemoteA2AAgent({
      name: 'remote_a2a',
      agentCard: 'https://example.com/agent.json',
    });
    const a2aTool = new AgentTool({agent: remoteA2a});
    expect(getToolOrigin(a2aTool)).toBe('A2A');

    const mcpTool = new MCPTool(
      {
        name: 'mcp_lookup',
        description: 'MCP tool',
        inputSchema: {type: 'object'},
      },
      {} as MCPSessionManager,
    );
    expect(getToolOrigin(mcpTool)).toBe('MCP');

    const loadMcpResourceTool = new LoadMcpResourceTool({} as MCPToolset);
    expect(getToolOrigin(loadMcpResourceTool)).toBe('MCP');

    const webMcpTool = new WebMCPTool({
      tool: {name: 'web_mcp_action', description: 'WebMCP tool'},
    });
    expect(getToolOrigin(webMcpTool)).toBe('MCP');

    const skillToolset = new SkillToolset([], {
      allowInlineScripts: true,
      registry: {} as SkillRegistry,
    });
    const skillTools = await skillToolset.getTools();
    expect(skillTools.length).toBe(6);
    for (const skillTool of skillTools) {
      expect(getToolOrigin(skillTool)).toBe('SKILL');
    }

    const toolboxToolset = new ToolboxToolset({
      serverUrl: 'http://127.0.0.1:5000',
      toolNames: ['toolbox_search'],
      client: {
        loadTool: async (name: string) => ({
          name,
          description: 'Toolbox search tool',
          execute: async () => ({ok: true}),
        }),
      },
    });
    const [toolboxTool] = await toolboxToolset.getTools();
    expect(getToolOrigin(toolboxTool)).toBe('TOOLBOX');

    const transferTool = new FunctionTool({
      name: 'transfer_to_agent',
      description: 'Transfer',
      parameters: z.object({agent_name: z.string()}),
      execute: async () => 'Transfer queued',
    });
    expect(getToolOrigin(transferTool, {agent_name: 'sub_llm'})).toBe(
      'TRANSFER_AGENT',
    );

    const parentWithRemote = new LlmAgent({
      name: 'root_router',
      model: 'gemini-flash-latest',
      subAgents: [remoteA2a],
    });
    expect(
      getToolOrigin(transferTool, {agent_name: 'remote_a2a'}, {
        invocationContext: {agent: parentWithRemote},
      } as unknown as Context),
    ).toBe('TRANSFER_A2A');

    class CustomToolWithMcpProperty extends BaseTool {
      readonly mcpTool = {name: 'not_an_mcp_tool'};
      constructor() {
        super({name: 'custom_tool', description: 'Custom tool'});
      }
      override async runAsync(): Promise<unknown> {
        return {};
      }
    }
    expect(getToolOrigin(new CustomToolWithMcpProperty())).toBe('UNKNOWN');

    class CustomAgentWithCardProperty extends BaseAgent {
      readonly agentCard = 'https://example.com/not-a2a.json';
      constructor() {
        super({name: 'custom_agent'});
      }
      protected override async *runAsyncImpl(
        _ctx: InvocationContext,
      ): AsyncGenerator<Event, void, void> {}
      protected override async *runLiveImpl(
        _ctx: InvocationContext,
      ): AsyncGenerator<Event, void, void> {}
    }
    const customAgent = new CustomAgentWithCardProperty();
    expect(getToolOrigin(new AgentTool({agent: customAgent}))).toBe(
      'SUB_AGENT',
    );
  });

  it('counts setup_unavailable and applies backoff when setup fails', async () => {
    tableGetError = new Error('Permission denied on project');
    (tableGetError as {code?: number}).code = 403;

    const plugin = new BigQueryAgentAnalyticsPlugin({
      projectId: 'test-project',
      datasetId: 'test_dataset',
    });

    const llm = new ScriptedMockLlm([
      () => ({content: {parts: [{text: 'Hi'}]}}),
    ]);
    const agent = new LlmAgent({name: 'unavail_agent', model: llm});
    const runner = new InMemoryRunner({agent, plugins: [plugin]});

    await runTurn(runner, 'u1', 's1', 'Hi');

    expect(plugin.getDropStats().setup_unavailable).toBeGreaterThan(0);
    expect(mockAppendedRows.length).toBe(0);
  });

  it('closes writer and drains queue on shutdown', async () => {
    const plugin = new BigQueryAgentAnalyticsPlugin({
      projectId: 'test-project',
      datasetId: 'test_dataset',
    });

    const llm = new ScriptedMockLlm([
      () => ({content: {parts: [{text: 'Hi'}]}}),
    ]);
    const agent = new LlmAgent({name: 'shutdown_agent', model: llm});
    const runner = new InMemoryRunner({agent, plugins: [plugin]});

    await runTurn(runner, 'u1', 's1', 'Hi');

    await plugin.shutdown();
    expect(mockAppendedRows.length).toBeGreaterThan(0);

    // Idempotent shutdown
    await expect(plugin.shutdown()).resolves.toBeUndefined();
  });
});
