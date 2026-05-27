/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {ReadonlyContext} from '../../../src/agents/readonly_context.js';
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

const stdioParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'test'},
} as unknown as MCPConnectionParams;

describe('MCPToolset', () => {
  it('discovers tools without prefix', async () => {
    const toolset = new MCPToolset(stdioParams);
    const tools = await toolset.getTools();

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('test-tool');
    expect(tools[1].name).toBe('other-tool');
  });

  it('discovers tools with prefix applied', async () => {
    const toolset = new MCPToolset(stdioParams, [], 'myprefix');
    const tools = await toolset.getTools();

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('myprefix_test-tool');
    expect(tools[1].name).toBe('myprefix_other-tool');
  });

  describe('toolFilter', () => {
    it('empty array (default) returns all tools', async () => {
      const toolset = new MCPToolset(stdioParams, []);
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
    });

    it('string array filter returns only matching tools', async () => {
      const toolset = new MCPToolset(stdioParams, ['test-tool']);
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('test-tool');
    });

    it('string array filter with prefix matches prefixed names', async () => {
      const toolset = new MCPToolset(
        stdioParams,
        ['myprefix_test-tool'],
        'myprefix',
      );
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('myprefix_test-tool');
    });

    it('string array filter returns empty when no tools match', async () => {
      const toolset = new MCPToolset(stdioParams, ['nonexistent-tool']);
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(0);
    });

    it('predicate filter applies when context is provided', async () => {
      const toolset = new MCPToolset(
        stdioParams,
        (tool) => tool.name === 'other-tool',
      );
      const tools = await toolset.getTools({} as ReadonlyContext);

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('other-tool');
    });

    it('predicate filter returns all tools when no context is provided', async () => {
      const toolset = new MCPToolset(
        stdioParams,
        (tool) => tool.name === 'other-tool',
      );
      // No context passed — filter cannot be applied, returns all tools
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
    });
  });
});
