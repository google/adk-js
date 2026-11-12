/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type Context, State} from '@google/adk';
import {
  BigQueryCredentialsConfig,
  BigQueryToolConfig,
  BigQueryToolset,
  isBigQueryTool,
  isBigQueryToolset,
  WriteMode,
} from '@google/adk-integrations';
import {describe, expect, it, vi} from 'vitest';

import {BigQueryClient} from '../../src/bigquery/client.js';

function createMockToolContext(): Context {
  return {
    getAuthResponse: vi.fn(() => undefined),
    requestCredential: vi.fn(),
    requestConfirmation: vi.fn(),
    actions: {},
    state: new State(),
  } as unknown as Context;
}

const ALL_TOOL_NAMES = [
  'list_dataset_ids',
  'get_dataset_info',
  'list_table_ids',
  'get_table_info',
  'execute_sql',
];

function createCredentialsConfig(): BigQueryCredentialsConfig {
  return new BigQueryCredentialsConfig({
    clientId: 'abc',
    clientSecret: 'def',
  });
}

describe('BigQueryToolset', () => {
  it('identifies BigQueryToolset instances via isBigQueryToolset', () => {
    const toolset = new BigQueryToolset();
    expect(isBigQueryToolset(toolset)).toBe(true);
    expect(isBigQueryToolset({})).toBe(false);
    expect(isBigQueryToolset(null)).toBe(false);
  });

  it('defaults toolConfig to WriteMode.BLOCKED when omitted', () => {
    const toolset = new BigQueryToolset();
    expect(toolset.toolConfig).toBeInstanceOf(BigQueryToolConfig);
    expect(toolset.toolConfig.writeMode).toBe(WriteMode.BLOCKED);
  });

  it('exposes all five BigQuery tools by default', async () => {
    const toolset = new BigQueryToolset({
      credentialsConfig: createCredentialsConfig(),
    });

    const tools = await toolset.getTools();
    expect(tools).toHaveLength(5);
    expect(tools.every((tool) => isBigQueryTool(tool))).toBe(true);
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set(ALL_TOOL_NAMES),
    );

    await toolset.close();
  });

  it.each([
    {selectedTools: ['list_dataset_ids', 'get_dataset_info']},
    {selectedTools: ['list_table_ids', 'get_table_info']},
    {selectedTools: ['execute_sql']},
  ])(
    'exposes only the tools named in toolFilter $selectedTools',
    async ({selectedTools}) => {
      const toolset = new BigQueryToolset({
        credentialsConfig: createCredentialsConfig(),
        toolFilter: selectedTools,
      });

      const tools = await toolset.getTools();
      expect(tools).toHaveLength(selectedTools.length);
      expect(tools.every((tool) => isBigQueryTool(tool))).toBe(true);
      expect(new Set(tools.map((tool) => tool.name))).toEqual(
        new Set(selectedTools),
      );
    },
  );

  it('treats an empty toolFilter as no filter', async () => {
    const toolset = new BigQueryToolset({
      credentialsConfig: createCredentialsConfig(),
      toolFilter: [],
    });

    const tools = await toolset.getTools();
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set(ALL_TOOL_NAMES),
    );
  });

  it.each([
    {selectedTools: ['unknown'], returnedTools: [] as string[]},
    {
      selectedTools: ['unknown', 'execute_sql'],
      returnedTools: ['execute_sql'],
    },
  ])(
    'skips unknown tool names in toolFilter $selectedTools',
    async ({selectedTools, returnedTools}) => {
      const toolset = new BigQueryToolset({
        credentialsConfig: createCredentialsConfig(),
        toolFilter: selectedTools,
      });

      const tools = await toolset.getTools();
      expect(tools).toHaveLength(returnedTools.length);
      expect(new Set(tools.map((tool) => tool.name))).toEqual(
        new Set(returnedTools),
      );
    },
  );

  it('supports ToolPredicate function filtering', async () => {
    const toolset = new BigQueryToolset({
      toolFilter: (tool) => tool.name.startsWith('list_'),
    });

    const tools = await toolset.getTools();
    expect(new Set(tools.map((t) => t.name))).toEqual(
      new Set(['list_dataset_ids', 'list_table_ids']),
    );
  });

  it('declares snake_case parameters without credentials', async () => {
    const toolset = new BigQueryToolset();
    const tools = await toolset.getTools();
    const getTableInfo = tools.find((tool) => tool.name === 'get_table_info');

    const declaration = getTableInfo?._getDeclaration();
    expect(declaration?.parameters?.required).toEqual([
      'project_id',
      'dataset_id',
      'table_id',
    ]);
    expect(declaration?.parameters?.properties?.['credentials']).toBe(
      undefined,
    );
  });

  it('describes the row limit and truncation flag of execute_sql', async () => {
    const toolset = new BigQueryToolset();
    const tools = await toolset.getTools();
    const executeSql = tools.find((tool) => tool.name === 'execute_sql');

    const description = executeSql?._getDeclaration()?.description;
    expect(description).toContain("{status: 'SUCCESS', rows}");
    expect(description).toContain('At most 50 rows');
    expect(description).toContain('result_is_likely_truncated');
  });

  it('describes metadata tools with updated property notes and examples', async () => {
    const toolset = new BigQueryToolset();
    const tools = await toolset.getTools();
    const getDatasetInfo = tools.find((t) => t.name === 'get_dataset_info');
    const getTableInfo = tools.find((t) => t.name === 'get_table_info');
    const listTableIds = tools.find((t) => t.name === 'list_table_ids');

    expect(getDatasetInfo?._getDeclaration()?.description).toContain(
      'description',
    );
    expect(getTableInfo?._getDeclaration()?.description).toContain(
      'description',
    );
    expect(listTableIds?._getDeclaration()?.description).toContain(
      'chronic_disease_indicators',
    );
    expect(listTableIds?._getDeclaration()?.description).toContain(
      'local_data_for_better_health_county_data',
    );
  });

  it.each([
    {
      configDesc: 'no config',
      toolConfig: undefined,
    },
    {
      configDesc: 'default config',
      toolConfig: new BigQueryToolConfig(),
    },
    {
      configDesc: 'explicit WriteMode.BLOCKED',
      toolConfig: new BigQueryToolConfig({writeMode: WriteMode.BLOCKED}),
    },
  ])(
    'describes execute_sql in read-only mode when configured with $configDesc',
    async ({toolConfig}) => {
      const toolset = new BigQueryToolset({toolConfig});
      const tools = await toolset.getTools();
      const executeSql = tools.find((tool) => tool.name === 'execute_sql');

      const description = executeSql?._getDeclaration()?.description;
      expect(description).toContain("{status: 'SUCCESS', rows}");
      expect(description).toContain('At most 50 rows');
      expect(description).toContain('result_is_likely_truncated');
      expect(description).not.toContain('CREATE TABLE');
      expect(description).not.toContain('DROP TABLE');
    },
  );

  it('describes execute_sql with write examples when configured with WriteMode.ALLOWED', async () => {
    const toolset = new BigQueryToolset({
      toolConfig: new BigQueryToolConfig({writeMode: WriteMode.ALLOWED}),
    });
    const tools = await toolset.getTools();
    const executeSql = tools.find((tool) => tool.name === 'execute_sql');

    const description = executeSql?._getDeclaration()?.description;
    expect(description).toContain("{status: 'SUCCESS', rows}");
    expect(description).toContain('At most 50 rows');
    expect(description).toContain('result_is_likely_truncated');
    expect(description).toContain('CREATE TABLE');
    expect(description).toContain('DROP TABLE');
    expect(description).toContain('CLONE');
  });

  it('executes execute_sql through BigQueryToolset in default read-only mode', async () => {
    const dryRunSpy = vi
      .spyOn(BigQueryClient.prototype, 'dryRun')
      .mockResolvedValue({statementType: 'SELECT'});
    const querySpy = vi
      .spyOn(BigQueryClient.prototype, 'query')
      .mockResolvedValue([{count: 42}]);

    const toolset = new BigQueryToolset();
    const tools = await toolset.getTools();
    const executeSql = tools.find((t) => t.name === 'execute_sql');
    expect(executeSql).toBeDefined();

    const result = await executeSql!.runAsync({
      args: {
        project_id: 'my_project',
        query: 'SELECT COUNT(*) FROM my_dataset.my_table',
      },
      toolContext: createMockToolContext(),
    });

    expect(result).toEqual({status: 'SUCCESS', rows: [{count: 42}]});
    expect(dryRunSpy).toHaveBeenCalledWith({
      query: 'SELECT COUNT(*) FROM my_dataset.my_table',
      projectId: 'my_project',
    });
    expect(querySpy).toHaveBeenCalledOnce();
  });

  it('executes execute_sql through BigQueryToolset in WriteMode.ALLOWED without dry-run check', async () => {
    const dryRunSpy = vi.spyOn(BigQueryClient.prototype, 'dryRun');
    const querySpy = vi
      .spyOn(BigQueryClient.prototype, 'query')
      .mockResolvedValue([]);

    const toolset = new BigQueryToolset({
      toolConfig: {writeMode: WriteMode.ALLOWED},
    });
    const tools = await toolset.getTools();
    const executeSql = tools.find((t) => t.name === 'execute_sql');
    expect(executeSql).toBeDefined();

    const result = await executeSql!.runAsync({
      args: {
        project_id: 'my_project',
        query: 'CREATE TABLE my_dataset.new_table AS SELECT 1',
      },
      toolContext: createMockToolContext(),
    });

    expect(result).toEqual({status: 'SUCCESS', rows: []});
    expect(dryRunSpy).not.toHaveBeenCalled();
    expect(querySpy).toHaveBeenCalledWith({
      query: 'CREATE TABLE my_dataset.new_table AS SELECT 1',
      projectId: 'my_project',
      maxResults: 50,
    });
  });
});
