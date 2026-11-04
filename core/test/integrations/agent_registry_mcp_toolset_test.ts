/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AgentRegistrySingleMCPToolset,
  Context,
  GCP_MCP_SERVER_DESTINATION_ID,
  InvocationContext,
} from '../../src/index.js';
import {StreamableHTTPConnectionParams} from '../../src/tools/mcp/mcp_session_manager.js';
import {logger} from '../../src/utils/logger.js';

const mockListTools = vi.fn().mockResolvedValue({
  tools: [
    {name: 'search', description: 'Search the web', inputSchema: {}},
    {name: 'fetch', description: 'Fetch a URL', inputSchema: {}},
  ],
});

const mockCallTool = vi.fn().mockResolvedValue({content: []});
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(function () {
    return {
      connect: mockConnect,
      close: mockClose,
      listTools: mockListTools,
      callTool: mockCallTool,
    };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function () {
    return {};
  }),
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

  describe('getTools — session cleanup', () => {
    it('closes the discovery session after listing tools', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
      });

      await toolset.getTools();

      expect(mockClose).toHaveBeenCalledOnce();
    });

    it('closes the discovery session when listing tools fails', async () => {
      mockListTools.mockRejectedValueOnce(new Error('discovery failed'));
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
      });

      await expect(toolset.getTools()).rejects.toThrow('discovery failed');
      expect(mockClose).toHaveBeenCalledOnce();
    });

    it('preserves the discovery error when closing also fails', async () => {
      mockListTools.mockRejectedValueOnce(new Error('discovery failed'));
      mockClose.mockRejectedValueOnce(new Error('close failed'));
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
      });

      await expect(toolset.getTools()).rejects.toThrow('discovery failed');
      expect(mockClose).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to close MCP discovery session',
        expect.objectContaining({message: 'close failed'}),
      );
      warnSpy.mockRestore();
    });
  });

  describe('close', () => {
    it('resolves without throwing', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
      });
      await expect(toolset.close()).resolves.toBeUndefined();
    });

    it('reuses a shared session across returned MCPTools and closes it on close()', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
      });
      const tools = await toolset.getTools();
      // Discovery opened and closed one session.
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);

      const toolContext = new Context({
        invocationContext: {
          abortSignal: new AbortController().signal,
          session: {state: {}},
        } as unknown as InvocationContext,
      });
      await tools[0].runAsync({args: {q: 'adk'}, toolContext});
      await tools[1].runAsync({
        args: {url: 'https://example.com'},
        toolContext,
      });

      // Both tool calls shared one execution session that remains open until close().
      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(mockCallTool).toHaveBeenCalledTimes(2);
      expect(mockClose).toHaveBeenCalledTimes(1);

      await toolset.close();
      expect(mockClose).toHaveBeenCalledTimes(2);

      // Calling close() again is a safe no-op.
      await toolset.close();
      expect(mockClose).toHaveBeenCalledTimes(2);
    });

    it('reuses the same MCPSessionManager across repeated getTools() calls when headers do not change', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        headerProvider: async () => ({Authorization: 'Bearer stable-token'}),
      });

      const toolsStep1 = await toolset.getTools();
      const toolContext = new Context({
        invocationContext: {
          abortSignal: new AbortController().signal,
          session: {state: {}},
        } as unknown as InvocationContext,
      });
      await toolsStep1[0].runAsync({args: {q: 'step-1'}, toolContext});

      // Discovery (1 connect, 1 close) + shared execution session (1 connect, 0 close).
      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(mockClose).toHaveBeenCalledTimes(1);

      const toolsStep2 = await toolset.getTools();
      // Second discovery opened and closed 1 session, while the shared execution session stayed open.
      expect(mockConnect).toHaveBeenCalledTimes(3);
      expect(mockClose).toHaveBeenCalledTimes(2);

      // Tool from the second getTools() call reuses the same execution session from step 1.
      await toolsStep2[1].runAsync({
        args: {url: 'https://example.com'},
        toolContext,
      });
      expect(mockConnect).toHaveBeenCalledTimes(3);
      expect(mockClose).toHaveBeenCalledTimes(2);

      await toolset.close();
      expect(mockClose).toHaveBeenCalledTimes(3);
    });

    it('replaces and closes the previous MCPSessionManager when resolved headers change', async () => {
      let token = 'Bearer token-1';
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        headerProvider: async () => ({Authorization: token}),
      });
      const toolContext = new Context({
        invocationContext: {
          abortSignal: new AbortController().signal,
          session: {state: {}},
        } as unknown as InvocationContext,
      });

      const tools1 = await toolset.getTools();
      await tools1[0].runAsync({args: {q: 'with-token-1'}, toolContext});
      // 1 discovery session (closed) + 1 execution session (open).
      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(mockClose).toHaveBeenCalledTimes(1);

      token = 'Bearer token-2';
      const tools2 = await toolset.getTools();
      // Previous manager's execution session was closed (close #2) and new discovery session closed (close #3).
      expect(mockConnect).toHaveBeenCalledTimes(3);
      expect(mockClose).toHaveBeenCalledTimes(3);

      await tools2[0].runAsync({args: {q: 'with-token-2'}, toolContext});
      expect(mockConnect).toHaveBeenCalledTimes(4);
      expect(mockClose).toHaveBeenCalledTimes(3);

      await toolset.close();
      expect(mockClose).toHaveBeenCalledTimes(4);
    });
  });
});
