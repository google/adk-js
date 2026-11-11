/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, MCPToolset} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_pagination_server.mjs', import.meta.url),
);

describe('MCPToolset pagination over stdio', () => {
  let toolset: MCPToolset;

  afterEach(async () => {
    await toolset?.close();
  });

  function createToolset(filter: string[] = []) {
    toolset = new MCPToolset(
      {
        type: 'StdioConnectionParams',
        serverParams: {command: process.execPath, args: [SERVER_PATH]},
      },
      filter,
      'paged',
    );
    return toolset;
  }

  it('discovers all pages and calls a prefixed tool from the last page', async () => {
    const tools = await createToolset().getTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'paged_first',
      'paged_last',
    ]);
    const result = await tools[1].runAsync({
      args: {},
      toolContext: {} as Context,
    });
    expect(result).toMatchObject({
      content: [{type: 'text', text: 'called last'}],
    });
  });

  it('applies the tool filter to tools on later pages', async () => {
    const tools = await createToolset(['paged_last']).getTools();
    expect(tools.map((tool) => tool.name)).toEqual(['paged_last']);
  });

  it('lists all resources and reads a resource from the last page', async () => {
    createToolset();
    expect(await toolset.listResources()).toEqual(['first', 'last']);
    expect(await toolset.getResourceInfo('last')).toEqual({
      name: 'last',
      uri: 'test:///last',
    });
    expect(await toolset.readResource('last')).toEqual([
      {uri: 'test:///last', text: 'read test:///last'},
    ]);
    await expect(toolset.getResourceInfo('missing')).rejects.toThrow(
      "Resource with name 'missing' not found.",
    );
  });
});
