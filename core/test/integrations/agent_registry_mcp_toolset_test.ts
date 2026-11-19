/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AgentRegistrySingleMCPToolset,
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  Context,
  createSession,
  GCP_MCP_SERVER_DESTINATION_ID,
  GcpAuthProviderScheme,
  InMemoryCredentialService,
  InvocationContext,
  isBaseAuthenticatedTool,
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
    mockCallTool.mockResolvedValue({content: []});
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

  describe('getTools auth forwarding', () => {
    function createToolContext(credentialService?: InMemoryCredentialService) {
      const session = createSession({
        id: 'sess-1',
        appName: 'app-1',
        userId: 'user-1',
      });
      const invocationContext = {
        abortSignal: new AbortController().signal,
        session,
        credentialService,
      } as unknown as InvocationContext;
      return new Context({invocationContext, functionCallId: 'fc-1'});
    }

    it('forwards authScheme and authCredential to each MCPTool and sends bearer header on tool calls', async () => {
      const Transport = (
        await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      ).StreamableHTTPClientTransport as unknown as ReturnType<typeof vi.fn>;

      const authScheme: AuthScheme = {type: 'http', scheme: 'bearer'};
      const authCredential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'demo-bearer-token'}},
      };
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        authScheme,
        authCredential,
      });

      const tools = await toolset.getTools();
      expect(tools).toHaveLength(2);
      expect(
        Transport.mock.calls.at(-1)?.[1]?.requestInit?.headers,
      ).not.toHaveProperty('Authorization');

      for (const tool of tools) {
        expect(isBaseAuthenticatedTool(tool)).toBe(true);
        const forwarded = (tool as unknown as {authConfig?: AuthConfig})
          .authConfig;
        expect(forwarded).toBeDefined();
        expect(forwarded?.authScheme).toEqual(authScheme);
        expect(forwarded?.rawAuthCredential).toEqual(authCredential);
        expect(forwarded?.credentialKey).toBeTruthy();
      }

      await tools[0].runAsync({
        args: {q: 'hello'},
        toolContext: createToolContext(),
      });

      expect(
        Transport.mock.calls.at(-1)?.[1]?.requestInit?.headers,
      ).toMatchObject({Authorization: 'Bearer demo-bearer-token'});
      expect(mockCallTool).toHaveBeenCalledWith(
        {name: 'search', arguments: {q: 'hello'}},
        undefined,
        expect.anything(),
      );
    });

    it('forwards API key auth and overlays it over headerProvider headers', async () => {
      const Transport = (
        await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      ).StreamableHTTPClientTransport as unknown as ReturnType<typeof vi.fn>;

      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        headerProvider: async () => ({
          'X-Trace': 'trace-1',
          'x-api-key': 'stale-key',
        }),
        authScheme: {type: 'apiKey', in: 'header', name: 'X-API-Key'},
        authCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'demo-api-key',
        },
        credentialKey: 'custom-api-key',
      });

      const [tool] = await toolset.getTools();
      const forwarded = (tool as unknown as {authConfig?: AuthConfig})
        .authConfig;
      expect(forwarded?.credentialKey).toBe('custom-api-key');

      await tool.runAsync({
        args: {},
        toolContext: createToolContext(),
      });

      const callHeaders =
        Transport.mock.calls.at(-1)?.[1]?.requestInit?.headers;
      expect(callHeaders).toMatchObject({
        'X-Trace': 'trace-1',
        'X-API-Key': 'demo-api-key',
      });
      expect(callHeaders).not.toHaveProperty('x-api-key');
    });

    it('forwards explicit authConfig and exposes authScheme and authCredential on the toolset', async () => {
      const authConfig: AuthConfig = {
        authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Token'},
        rawAuthCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'demo-token',
        },
        credentialKey: 'explicit-config-key',
      };
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        authConfig,
      });

      expect(toolset.authScheme).toEqual(authConfig.authScheme);
      expect(toolset.authCredential).toEqual(authConfig.rawAuthCredential);

      const [tool] = await toolset.getTools();
      expect((tool as unknown as {authConfig?: AuthConfig}).authConfig).toEqual(
        authConfig,
      );
    });

    it('forwards gcpAuthProviderScheme so tools request or load credentials via CredentialManager', async () => {
      const Transport = (
        await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      ).StreamableHTTPClientTransport as unknown as ReturnType<typeof vi.fn>;

      const gcpScheme = {
        type: 'gcpAuthProviderScheme',
        name: 'projects/p/locations/l/authProviders/ap-1',
        continueUri: 'https://app.example.com/continue',
      } as GcpAuthProviderScheme as unknown as AuthScheme;

      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
        authScheme: gcpScheme,
      });

      const [tool] = await toolset.getTools();
      const forwarded = (tool as unknown as {authConfig?: AuthConfig})
        .authConfig;
      expect(forwarded?.authScheme).toEqual(gcpScheme);

      const credentialService = new InMemoryCredentialService();
      const firstContext = createToolContext(credentialService);
      const pendingResult = await tool.runAsync({
        args: {},
        toolContext: firstContext,
      });
      expect(pendingResult).toBe('Pending User Authorization.');
      expect(firstContext.actions.requestedAuthConfigs['fc-1']).toEqual(
        forwarded,
      );
      expect(mockCallTool).not.toHaveBeenCalled();

      await credentialService.saveCredential(
        {
          ...forwarded!,
          exchangedAuthCredential: {
            authType: AuthCredentialTypes.OAUTH2,
            oauth2: {accessToken: 'demo-provider-token'},
          },
        },
        firstContext,
      );

      await tool.runAsync({
        args: {q: 'billing'},
        toolContext: createToolContext(credentialService),
      });

      expect(
        Transport.mock.calls.at(-1)?.[1]?.requestInit?.headers,
      ).toMatchObject({Authorization: 'Bearer demo-provider-token'});
      expect(mockCallTool).toHaveBeenCalledOnce();
    });

    it('leaves tool authConfig undefined when no auth options are configured', async () => {
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams: BASE_PARAMS,
      });

      const [tool] = await toolset.getTools();
      expect(
        (tool as unknown as {authConfig?: AuthConfig}).authConfig,
      ).toBeUndefined();

      await tool.runAsync({
        args: {},
        toolContext: createToolContext(),
      });
      expect(mockCallTool).toHaveBeenCalledOnce();
    });

    it('rejects authConfig given together with authScheme', () => {
      const authScheme: AuthScheme = {type: 'http', scheme: 'bearer'};
      expect(
        () =>
          new AgentRegistrySingleMCPToolset({
            connectionParams: BASE_PARAMS,
            authConfig: {
              authScheme,
              credentialKey: 'k1',
            },
            authScheme,
          }),
      ).toThrow(
        'AgentRegistrySingleMCPToolset takes either authConfig or authScheme, authCredential and credentialKey, not both.',
      );
    });

    it('rejects authCredential or credentialKey without authScheme', () => {
      expect(
        () =>
          new AgentRegistrySingleMCPToolset({
            connectionParams: BASE_PARAMS,
            authCredential: {
              authType: AuthCredentialTypes.API_KEY,
              apiKey: 'demo-api-key',
            },
          }),
      ).toThrow(
        'AgentRegistrySingleMCPToolset needs an authScheme when authCredential or credentialKey is set.',
      );

      expect(
        () =>
          new AgentRegistrySingleMCPToolset({
            connectionParams: BASE_PARAMS,
            credentialKey: 'only-key',
          }),
      ).toThrow(
        'AgentRegistrySingleMCPToolset needs an authScheme when authCredential or credentialKey is set.',
      );
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
