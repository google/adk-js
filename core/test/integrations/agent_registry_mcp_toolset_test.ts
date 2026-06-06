/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AgentRegistrySingleMCPToolset,
  GCP_MCP_SERVER_DESTINATION_ID,
} from '../../src/index.js';
import {StreamableHTTPConnectionParams} from '../../src/tools/mcp/mcp_session_manager.js';

const mockListTools = vi.fn().mockResolvedValue({
  tools: [
    {name: 'search', description: 'Search the web', inputSchema: {}},
    {name: 'fetch', description: 'Fetch a URL', inputSchema: {}},
  ],
});

const mockConnect = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    listTools: mockListTools,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({})),
}));

const BASE_PARAMS: StreamableHTTPConnectionParams = {
  type: 'StreamableHTTPConnectionParams',
  url: 'https://example.com/mcp',
};

describe('AgentRegistrySingleMCPToolset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue({
      tools: [
        {name: 'search', description: 'Search the web', inputSchema: {}},
        {name: 'fetch', description: 'Fetch a URL', inputSchema: {}},
      ],
    });
  });

  describe('getTools — tool name prefixing', () => {
    it('returns tools with unprefixed names when no prefix is set', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
      });
      const tools = await toolset.getTools();
      expect(tools.map((t) => t.name)).toEqual(['search', 'fetch']);
    });

    it('prefixes tool names with the configured prefix', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        prefix: 'my_server',
      });
      const tools = await toolset.getTools();
      expect(tools.map((t) => t.name)).toEqual([
        'my_server_search',
        'my_server_fetch',
      ]);
    });
  });

  describe('getTools — destinationResourceId injection', () => {
    it('injects GCP_MCP_SERVER_DESTINATION_ID into each tool when set', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        destinationResourceId: 'projects/p/locations/l/mcpServers/s',
      });
      const tools = await toolset.getTools();
      for (const tool of tools) {
        const meta = (
          tool as unknown as {customMetadata?: Record<string, string>}
        ).customMetadata;
        expect(meta?.[GCP_MCP_SERVER_DESTINATION_ID]).toBe(
          'projects/p/locations/l/mcpServers/s',
        );
      }
    });

    it('does not add customMetadata when destinationResourceId is not set', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
      });
      const tools = await toolset.getTools();
      for (const tool of tools) {
        const meta = (
          tool as unknown as {customMetadata?: Record<string, string>}
        ).customMetadata;
        expect(meta?.[GCP_MCP_SERVER_DESTINATION_ID]).toBeUndefined();
      }
    });
  });

  describe('getTools — toolFilter', () => {
    it('returns all tools when toolFilter is an empty array', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        toolFilter: [],
      });
      const tools = await toolset.getTools();
      expect(tools).toHaveLength(2);
    });

    it('filters tools by name when toolFilter is a string array', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        toolFilter: ['search'],
      });
      const tools = await toolset.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('search');
    });

    it('filters by prefixed name when prefix and toolFilter are both set', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        prefix: 'srv',
        toolFilter: ['srv_search'],
      });
      const tools = await toolset.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('srv_search');
    });

    it('returns an empty list when no tool name matches the filter', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        toolFilter: ['nonexistent'],
      });
      const tools = await toolset.getTools();
      expect(tools).toHaveLength(0);
    });
  });

  describe('getTools — headerProvider', () => {
    it('calls headerProvider and merges returned headers into requestInit', async () => {
      const headerProvider = vi
        .fn()
        .mockResolvedValue({'Authorization': 'Bearer token'});
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        headerProvider,
      });
      await toolset.getTools();
      expect(headerProvider).toHaveBeenCalledOnce();
    });

    it('merges headerProvider headers over existing transportOptions headers', async () => {
      const Transport = (
        await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      ).StreamableHTTPClientTransport as unknown as ReturnType<typeof vi.fn>;

      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: {
          ...BASE_PARAMS,
          transportOptions: {
            requestInit: {
              headers: {'X-Existing': 'yes'} as Record<string, string>,
            },
          },
        },
        headerProvider: async () => ({'Authorization': 'Bearer new'}),
      });

      await toolset.getTools();

      const constructorArg = Transport.mock.calls.at(-1)?.[1];
      expect(constructorArg?.requestInit?.headers).toMatchObject({
        'X-Existing': 'yes',
        'Authorization': 'Bearer new',
      });
    });

    it('passes context to headerProvider when one is provided', async () => {
      const headerProvider = vi.fn().mockResolvedValue({});
      const context = {} as never;
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        headerProvider,
      });
      await toolset.getTools(context);
      expect(headerProvider).toHaveBeenCalledWith(context);
    });
  });

  describe('close', () => {
    it('resolves without throwing', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
      });
      await expect(toolset.close()).resolves.toBeUndefined();
    });
  });
});
