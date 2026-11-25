/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Context,
  createSession,
  InvocationContext,
  isGoogleAuthClient,
  isGoogleTool,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  type Skill,
  SkillToolset,
  State,
} from '@google/adk';
import {
  DEFAULT_SPANNER_TOOL_NAME_PREFIX,
  isSpannerToolset,
  SpannerCapabilities,
  SpannerCredentialsConfig,
  SpannerToolset,
  type SpannerToolsetOptions,
  SpannerToolSettings,
} from '@google/adk-integrations';
import {Readable} from 'node:stream';
import {afterEach, describe, expect, it, vi} from 'vitest';

interface ToolsetTestState {
  streamRows: unknown[];
  capturedClientOptions: Array<Record<string, unknown>>;
}

const fakeState: ToolsetTestState = {
  streamRows: [[42]],
  capturedClientOptions: [],
};

vi.mock('@google-cloud/spanner', () => ({
  Spanner: class {
    constructor(options: Record<string, unknown>) {
      fakeState.capturedClientOptions.push(options);
      return {
        instance: () => ({
          database: () => ({
            getDatabaseDialect: async () => 'GOOGLE_STANDARD_SQL',
            getSnapshot: async () => [
              {
                runStream: () => Readable.from(fakeState.streamRows),
                end: () => {},
              },
            ],
            close: async () => {},
          }),
        }),
        close: async () => {},
      };
    }
  },
}));

const ALL_TOOL_NAMES = [
  'list_table_names',
  'list_table_indexes',
  'list_table_index_columns',
  'list_named_schemas',
  'get_table_schema',
  'execute_sql',
];

function createCredentialsConfig(): SpannerCredentialsConfig {
  return new SpannerCredentialsConfig({
    clientId: 'abc',
    clientSecret: 'def',
  });
}

function createMockToolContext(
  initialState: Record<string, unknown> = {},
): Context {
  return {
    getAuthResponse: vi.fn(() => undefined),
    requestCredential: vi.fn(),
    requestConfirmation: vi.fn(),
    actions: {},
    state: new State(initialState),
  } as unknown as Context;
}

describe('SpannerToolset', () => {
  afterEach(() => {
    fakeState.streamRows = [[42]];
    fakeState.capturedClientOptions = [];
    vi.restoreAllMocks();
  });

  it('identifies SpannerToolset instances via isSpannerToolset and exposes DEFAULT_SPANNER_TOOL_NAME_PREFIX', () => {
    const toolset = new SpannerToolset();
    expect(DEFAULT_SPANNER_TOOL_NAME_PREFIX).toBe('spanner');
    expect(toolset.toolNamePrefix).toBe('spanner');
    expect(isSpannerToolset(toolset)).toBe(true);
    expect(isSpannerToolset({})).toBe(false);
    expect(isSpannerToolset(null)).toBe(false);
  });

  it('exposes six unprefixed GoogleTool instances by default and prefixes them via getToolsWithPrefix', async () => {
    const toolset = new SpannerToolset({
      credentialsConfig: createCredentialsConfig(),
    });
    expect(toolset.toolSettings.capabilities).toEqual([
      SpannerCapabilities.DATA_READ,
    ]);
    expect(toolset.toolSettings.maxExecutedQueryResultRows).toBe(50);

    const tools = await toolset.getTools();
    expect(tools).toHaveLength(6);
    expect(tools.every((tool) => isGoogleTool(tool))).toBe(true);
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set(ALL_TOOL_NAMES),
    );

    const prefixedTools = await toolset.getToolsWithPrefix();
    expect(prefixedTools).toHaveLength(6);
    expect(new Set(prefixedTools.map((tool) => tool.name))).toEqual(
      new Set(ALL_TOOL_NAMES.map((name) => `spanner_${name}`)),
    );
    expect(prefixedTools.map((tool) => tool._getDeclaration()?.name)).toEqual(
      prefixedTools.map((tool) => tool.name),
    );
    // Original tools from getTools() remain unprefixed.
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set(ALL_TOOL_NAMES),
    );

    await toolset.close();
  });

  it('treats an empty toolFilter array as exposing all enabled tools', async () => {
    const toolset = new SpannerToolset({
      credentialsConfig: createCredentialsConfig(),
      toolFilter: [],
      spannerToolSettings: new SpannerToolSettings(),
    });

    const tools = await toolset.getTools();
    expect(tools).toHaveLength(6);
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set(ALL_TOOL_NAMES),
    );
  });

  it('defensively copies caller-supplied toolFilter arrays and accepts readonly string[]', async () => {
    const mutableFilter = ['list_table_names'];
    const toolset = new SpannerToolset({
      credentialsConfig: createCredentialsConfig(),
      toolFilter: mutableFilter,
    });

    mutableFilter.length = 0;
    mutableFilter.push('execute_sql', 'get_table_schema');

    const tools = await toolset.getTools();
    expect(tools.map((tool) => tool.name)).toEqual(['list_table_names']);

    const readonlyFilter: readonly string[] = [
      'list_table_names',
      'get_table_schema',
    ];
    const readonlyToolset = new SpannerToolset({
      credentialsConfig: createCredentialsConfig(),
      toolFilter: readonlyFilter,
    });
    const readonlyTools = await readonlyToolset.getTools();
    expect(new Set(readonlyTools.map((tool) => tool.name))).toEqual(
      new Set(['list_table_names', 'get_table_schema']),
    );
  });

  it.each([
    {selectedTools: ['list_table_names', 'get_table_schema']},
    {selectedTools: ['execute_sql']},
  ])(
    'exposes only the tools named in toolFilter $selectedTools',
    async ({selectedTools}) => {
      const toolset = new SpannerToolset({
        credentialsConfig: createCredentialsConfig(),
        toolFilter: selectedTools,
        spannerToolSettings: new SpannerToolSettings(),
      });

      const tools = await toolset.getTools();
      expect(tools).toHaveLength(selectedTools.length);
      expect(tools.every((tool) => isGoogleTool(tool))).toBe(true);
      expect(new Set(tools.map((tool) => tool.name))).toEqual(
        new Set(selectedTools),
      );
    },
  );

  const unknownFilterCases: Array<{
    selectedTools: string[];
    returnedTools: string[];
  }> = [
    {selectedTools: ['unknown'], returnedTools: []},
    {
      selectedTools: ['unknown', 'execute_sql'],
      returnedTools: ['execute_sql'],
    },
  ];

  it.each(unknownFilterCases)(
    'skips unknown tool names in toolFilter $selectedTools',
    async ({selectedTools, returnedTools}) => {
      const toolset = new SpannerToolset({
        credentialsConfig: createCredentialsConfig(),
        toolFilter: selectedTools,
        spannerToolSettings: new SpannerToolSettings(),
      });

      const tools = await toolset.getTools();
      expect(tools).toHaveLength(returnedTools.length);
      expect(tools.every((tool) => isGoogleTool(tool))).toBe(true);
      expect(new Set(tools.map((tool) => tool.name))).toEqual(
        new Set(returnedTools),
      );
    },
  );

  it.each([
    {
      selectedTools: ['execute_sql', 'list_table_names'],
      returnedTools: ['list_table_names'],
    },
    {
      selectedTools: ['list_table_names', 'list_table_indexes'],
      returnedTools: ['list_table_names', 'list_table_indexes'],
    },
  ])(
    'excludes execute_sql when DATA_READ capability is disabled for $selectedTools',
    async ({selectedTools, returnedTools}) => {
      const toolset = new SpannerToolset({
        credentialsConfig: createCredentialsConfig(),
        toolFilter: selectedTools,
        spannerToolSettings: new SpannerToolSettings({capabilities: []}),
      });

      const tools = await toolset.getTools();
      expect(tools).toHaveLength(returnedTools.length);
      expect(tools.every((tool) => isGoogleTool(tool))).toBe(true);
      expect(new Set(tools.map((tool) => tool.name))).toEqual(
        new Set(returnedTools),
      );
    },
  );

  it('supports ToolPredicate function filtering and custom toolNamePrefix', async () => {
    const toolset = new SpannerToolset({
      toolFilter: (tool) => tool.name.startsWith('list_table_'),
      toolNamePrefix: 'custom',
    });

    const unprefixed = await toolset.getTools();
    expect(new Set(unprefixed.map((t) => t.name))).toEqual(
      new Set([
        'list_table_names',
        'list_table_indexes',
        'list_table_index_columns',
      ]),
    );

    const prefixed = await toolset.getToolsWithPrefix();
    expect(new Set(prefixed.map((t) => t.name))).toEqual(
      new Set([
        'custom_list_table_names',
        'custom_list_table_indexes',
        'custom_list_table_index_columns',
      ]),
    );
  });

  it('strips credentials and settings from declarations and reflects maxExecutedQueryResultRows in execute_sql description', async () => {
    const toolset = new SpannerToolset({
      spannerToolSettings: {maxExecutedQueryResultRows: 1},
    });
    const tools = await toolset.getTools();

    const getTableSchemaTool = tools.find(
      (tool) => tool.name === 'get_table_schema',
    );
    const schemaDecl = getTableSchemaTool?._getDeclaration();
    expect(schemaDecl?.parameters?.required).toEqual([
      'project_id',
      'instance_id',
      'database_id',
      'table_name',
    ]);
    expect(schemaDecl?.parameters?.properties?.['named_schema']).toBeDefined();
    expect(schemaDecl?.parameters?.properties?.['credentials']).toBeUndefined();
    expect(schemaDecl?.parameters?.properties?.['settings']).toBeUndefined();

    const executeSqlTool = tools.find((tool) => tool.name === 'execute_sql');
    const executeDecl = executeSqlTool?._getDeclaration();
    expect(executeDecl?.parameters?.required).toEqual([
      'project_id',
      'instance_id',
      'database_id',
      'query',
    ]);
    expect(
      executeDecl?.parameters?.properties?.['credentials'],
    ).toBeUndefined();
    expect(executeDecl?.parameters?.properties?.['settings']).toBeUndefined();
    expect(executeDecl?.description).toContain('At most 1 row is returned.');
  });

  it('executes execute_sql end-to-end through GoogleTool.runAsync with resolved credentials and settings', async () => {
    fakeState.streamRows = [[1], [2], [3]];
    const credentialsConfig = new SpannerCredentialsConfig({
      externalAccessTokenKey: 'spannerAccessToken',
    });
    const options: SpannerToolsetOptions = {
      credentialsConfig,
      spannerToolSettings: new SpannerToolSettings({
        maxExecutedQueryResultRows: 2,
      }),
    };
    const toolset = new SpannerToolset(options);

    const tools = await toolset.getTools();
    const executeSqlTool = tools.find((tool) => tool.name === 'execute_sql');
    if (!executeSqlTool) {
      throw new Error('Expected execute_sql tool');
    }

    const result = await executeSqlTool.runAsync({
      args: {
        project_id: 'test-project',
        instance_id: 'test-instance',
        database_id: 'test-database',
        query: 'SELECT id FROM Singers',
        // Model-forged credentials/settings must be overwritten by GoogleTool.
        credentials: {token: 'forged-token'},
        settings: {maxExecutedQueryResultRows: 50},
      },
      toolContext: createMockToolContext({
        spannerAccessToken: 'resolved-session-token',
      }),
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      rows: [[1], [2]],
      result_is_likely_truncated: true,
    });
    const rawAuthClient = fakeState.capturedClientOptions[0]?.['authClient'];
    expect(isGoogleAuthClient(rawAuthClient)).toBe(true);
    if (!isGoogleAuthClient(rawAuthClient)) {
      throw new Error('Expected authClient to implement GoogleAuthClient');
    }
    await expect(rawAuthClient.getAccessToken?.()).resolves.toEqual({
      token: 'resolved-session-token',
    });
  });

  it('resolves spanner_* tools when registered as additionalTools in SkillToolset', async () => {
    const spannerSkill: Skill = {
      frontmatter: {
        name: 'spanner-query-skill',
        description: 'Inspects and queries Spanner tables.',
        metadata: {
          adk_additional_tools: [
            'spanner_list_table_names',
            'spanner_execute_sql',
          ],
        },
      },
      instructions: 'Use Spanner tools to answer questions.',
    };

    const skillToolset = new SkillToolset([spannerSkill], {
      additionalTools: [
        new SpannerToolset({
          credentialsConfig: createCredentialsConfig(),
        }),
      ],
    });

    const agent = new LlmAgent({name: 'spannerSkillAgent'});
    const session = createSession({
      id: 'sess-spanner-skill',
      appName: 'testApp',
      userId: 'testUser',
      state: {
        _adk_activated_skill_spannerSkillAgent: ['spanner-query-skill'],
      },
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv-spanner-skill',
      agent,
      session,
      pluginManager: new PluginManager(),
    });
    const readonlyContext = new ReadonlyContext(invocationContext);

    const resolvedTools = await skillToolset.getTools(readonlyContext);
    const resolvedNames = resolvedTools.map((tool) => tool.name);

    expect(resolvedNames).toContain('spanner_list_table_names');
    expect(resolvedNames).toContain('spanner_execute_sql');
    expect(resolvedNames).not.toContain('list_table_names');
    expect(resolvedNames).not.toContain('execute_sql');
  });
});
