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

describe('BigQueryToolset', () => {
  it('identifies BigQueryToolset instances via isBigQueryToolset', () => {
    const toolset = new BigQueryToolset();
    expect(isBigQueryToolset(toolset)).toBe(true);
    expect(isBigQueryToolset({})).toBe(false);
    expect(isBigQueryToolset(null)).toBe(false);
  });

  it('test_bigquery_toolset_tools_default', async () => {
    const credentialsConfig = new BigQueryCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });
    const toolset = new BigQueryToolset({credentialsConfig});

    const tools = await toolset.getTools();
    expect(tools).toBeDefined();
    expect(tools).toHaveLength(5);
    expect(tools.every((tool) => isBigQueryTool(tool))).toBe(true);

    const expectedToolNames = new Set([
      'list_dataset_ids',
      'get_dataset_info',
      'list_table_ids',
      'get_table_info',
      'execute_sql',
    ]);
    const actualToolNames = new Set(tools.map((tool) => tool.name));
    expect(actualToolNames).toEqual(expectedToolNames);

    await toolset.close();
  });

  it.each([
    {selectedTools: [] as string[]},
    {selectedTools: ['list_dataset_ids', 'get_dataset_info']},
    {selectedTools: ['list_table_ids', 'get_table_info']},
    {selectedTools: ['execute_sql']},
  ])(
    'test_bigquery_toolset_tools_selective ($selectedTools)',
    async ({selectedTools}) => {
      const credentialsConfig = new BigQueryCredentialsConfig({
        clientId: 'abc',
        clientSecret: 'def',
      });
      const toolset = new BigQueryToolset({
        credentialsConfig,
        toolFilter: selectedTools,
      });

      const tools = await toolset.getTools();
      expect(tools).toBeDefined();
      expect(tools).toHaveLength(selectedTools.length);
      expect(tools.every((tool) => isBigQueryTool(tool))).toBe(true);

      const actualToolNames = new Set(tools.map((tool) => tool.name));
      expect(actualToolNames).toEqual(new Set(selectedTools));
    },
  );

  it.each([
    {selectedTools: ['unknown'], returnedTools: [] as string[]},
    {
      selectedTools: ['unknown', 'execute_sql'],
      returnedTools: ['execute_sql'],
    },
  ])(
    'test_bigquery_toolset_unknown_tool ($selectedTools)',
    async ({selectedTools, returnedTools}) => {
      const credentialsConfig = new BigQueryCredentialsConfig({
        clientId: 'abc',
        clientSecret: 'def',
      });
      const toolset = new BigQueryToolset({
        credentialsConfig,
        toolFilter: selectedTools,
      });

      const tools = await toolset.getTools();
      expect(tools).toHaveLength(returnedTools.length);
      expect(new Set(tools.map((tool) => tool.name))).toEqual(
        new Set(returnedTools),
      );
    },
  );

  it('test_bigquery_toolset_unknown_tool_raises', async () => {
    const credentialsConfig = new BigQueryCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });
    const toolset = new BigQueryToolset({
      credentialsConfig,
      toolFilter: ['unknown'],
    });

    const tools = await toolset.getTools();
    expect(tools).toEqual([]);
  });

  it('supports ToolPredicate function filtering', async () => {
    const toolset = new BigQueryToolset({
      toolFilter: (tool) => tool.name.startsWith('list_'),
    });

    const tools = await toolset.getTools();
    expect(new Set(tools.map((t) => t.name))).toEqual(
      new Set(['list_dataset_ids', 'list_table_ids']),
    );
  });
});
