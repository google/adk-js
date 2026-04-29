/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {MCPConnectionParams} from '../../../src/tools/mcp/mcp_session_manager.js';
import {MCPToolset} from '../../../src/tools/mcp/mcp_toolset.js';

vi.hoisted(() => {
  vi.resetModules();
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {name: 'test-tool', description: 'A test tool', inputSchema: {}},
          {name: 'other-tool', description: 'Another tool', inputSchema: {}},
        ],
      }),
    })),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn(),
  };
});

describe('MCPToolset', () => {
  it('discovers tools without prefix', async () => {
    const connectionParams = {
      type: 'StdioConnectionParams',
      serverParams: {command: 'test'},
    } as unknown as MCPConnectionParams;
    const toolset = new MCPToolset(connectionParams);

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('test-tool');
    expect(tools[1].name).toBe('other-tool');
  });

  it('discovers tools with prefix applied', async () => {
    const connectionParams = {
      type: 'StdioConnectionParams',
      serverParams: {command: 'test'},
    } as unknown as MCPConnectionParams;
    const toolset = new MCPToolset(connectionParams, [], 'myprefix');

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('myprefix_test-tool');
    expect(tools[1].name).toBe('myprefix_other-tool');
  });
});
