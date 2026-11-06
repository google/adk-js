/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BigQueryCredentialsConfig,
  BigQueryToolset,
  isBigQueryTool,
  isBigQueryToolset,
} from '@google/adk-integrations';
import {describe, expect, it} from 'vitest';

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

  // reference: test_bigquery_toolset_tools_default
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

  // reference: test_bigquery_toolset_tools_selective
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

  // reference: test_bigquery_toolset_unknown_tool
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

  it('declares camelCase parameters without credentials', async () => {
    const toolset = new BigQueryToolset();
    const tools = await toolset.getTools();
    const getTableInfo = tools.find((tool) => tool.name === 'get_table_info');

    const declaration = getTableInfo?._getDeclaration();
    expect(declaration?.parameters?.required).toEqual([
      'projectId',
      'datasetId',
      'tableId',
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
    expect(description).toContain('resultIsLikelyTruncated');
  });
});
