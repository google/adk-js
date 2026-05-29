/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AgentRegistry,
  AgentRegistrySingleMCPToolset,
  cleanName,
  GCP_MCP_SERVER_DESTINATION_ID,
  isGoogleApi,
  ProtocolType,
  ReadonlyContext,
  RemoteA2AAgent,
  StreamableHTTPConnectionParams,
} from '../../src/index.js';

// Mock google-auth-library
let shouldAuthThrow = false;
let mockQuotaProjectId: string | undefined = 'quota-project-123';
let mockClientQuotaProjectId: string | undefined = 'quota-project-123';

vi.mock('google-auth-library', () => {
  return {
    GoogleAuth: vi.fn().mockImplementation(() => {
      return {
        getClient: vi.fn().mockImplementation(() => {
          if (shouldAuthThrow) {
            return Promise.reject(new Error('Auth error'));
          }
          return Promise.resolve({
            getRequestHeaders: vi.fn().mockResolvedValue({
              'Authorization': 'Bearer fake-token',
            }),
            quotaProjectId: mockClientQuotaProjectId,
          });
        }),
        get quotaProjectId() {
          return mockQuotaProjectId;
        },
      };
    }),
  };
});

const mockMcpClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue({
    tools: [
      {name: 'tool1', description: 'desc1', inputSchema: {}},
      {name: 'tool2', description: 'desc2', inputSchema: {}},
    ],
  }),
};

// Mock MCP Client
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => mockMcpClient),
  };
});

describe('AgentRegistry Helpers', () => {
  describe('isGoogleApi', () => {
    it('should return true for Google APIs', () => {
      expect(isGoogleApi('https://agentregistry.googleapis.com/v1')).toBe(true);
      expect(isGoogleApi('https://googleapis.com')).toBe(true);
    });

    it('should return false for non-Google APIs', () => {
      expect(isGoogleApi('https://example.com')).toBe(false);
      expect(isGoogleApi('invalid-url')).toBe(false);
    });
  });

  describe('cleanName', () => {
    it('should clean string to valid JS identifiers', () => {
      expect(cleanName('my-agent-name')).toBe('my_agent_name');
      expect(cleanName('agent@123')).toBe('agent_123');
      expect(cleanName('__agent__')).toBe('agent');
      expect(cleanName('123agent')).toBe('_123agent');
    });
  });
});

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
    registry = new AgentRegistry({
      projectId: 'test-project',
      location: 'global',
    });
  });

  describe('Initialization', () => {
    it('should initialize correctly and build base path', () => {
      expect(registry.projectId).toBe('test-project');
      expect(registry.location).toBe('global');
    });

    it('should throw error if params are missing', () => {
      expect(
        () => new AgentRegistry({projectId: null, location: 'global'}),
      ).toThrow();
      expect(
        () => new AgentRegistry({projectId: 'test', location: null}),
      ).toThrow();
    });
  });

  describe('getAuthHeaders', () => {
    it('should return authorization headers and quota project ID', async () => {
      const headers = await registry.getAuthHeaders();
      expect(headers['Authorization']).toBe('Bearer fake-token');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['x-goog-user-project']).toBe('quota-project-123');
    });

    it('should return quota project ID from auth if not on client', async () => {
      mockClientQuotaProjectId = undefined;
      mockQuotaProjectId = 'quota-project-auth';
      try {
        const headers = await registry.getAuthHeaders();
        expect(headers['x-goog-user-project']).toBe('quota-project-auth');
      } finally {
        mockClientQuotaProjectId = 'quota-project-123';
        mockQuotaProjectId = 'quota-project-123';
      }
    });

    it('should not attach x-goog-user-project if quota project ID is missing', async () => {
      mockClientQuotaProjectId = undefined;
      mockQuotaProjectId = undefined;
      try {
        const headers = await registry.getAuthHeaders();
        expect(headers['x-goog-user-project']).toBeUndefined();
      } finally {
        mockClientQuotaProjectId = 'quota-project-123';
        mockQuotaProjectId = 'quota-project-123';
      }
    });
  });

  describe('makeRequest', () => {
    it('should fetch and return JSON data', async () => {
      const mockResponse = {data: 'test'};
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockResponse),
      });

      const res = await registry.makeRequest('mcpServers', {filter: 'name'});
      expect(res).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://agentregistry.googleapis.com/v1alpha/projects/test-project/locations/global/mcpServers?filter=name',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer fake-token',
          }),
        }),
      );
    });

    it('should use full project path if starting with projects/', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });

      await registry.makeRequest(
        'projects/other-p/locations/other-l/endpoints/e',
      );
      expect(global.fetch).toHaveBeenCalledWith(
        'https://agentregistry.googleapis.com/v1alpha/projects/other-p/locations/other-l/endpoints/e',
        expect.any(Object),
      );
    });

    it('should throw error if response is not ok', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 404,
        text: vi.fn().mockResolvedValue('Not Found'),
      });

      await expect(registry.makeRequest('mcpServers')).rejects.toThrow(
        'API request failed with status 404: Not Found',
      );
    });

    it('should throw wrapped error on fetch error', async () => {
      (global.fetch as any).mockRejectedValue(new Error('Network Error'));
      await expect(registry.makeRequest('mcpServers')).rejects.toThrow(
        'API request failed: Network Error',
      );
    });
  });

  describe('getConnectionUri', () => {
    it('should return connection details matching protocol type and binding', () => {
      const resource = {
        protocols: [
          {
            type: ProtocolType.A2A_AGENT,
            protocolVersion: '0.4.0',
            interfaces: [
              {url: 'https://agent-endpoint.com', protocolBinding: 'HTTP_JSON'},
            ],
          },
        ],
      };

      const connection = registry.getConnectionUri(resource, {
        protocolType: ProtocolType.A2A_AGENT,
      });
      expect(connection.url).toBe('https://agent-endpoint.com');
      expect(connection.protocolVersion).toBe('0.4.0');
      expect(connection.protocolBinding).toBe('HTTP+JSON');
    });

    it('should default if interfaces are top-level', () => {
      const resource = {
        interfaces: [{url: 'https://mcp.com', protocolBinding: 'JSONRPC'}],
      };

      const connection = registry.getConnectionUri(resource);
      expect(connection.url).toBe('https://mcp.com');
      expect(connection.protocolBinding).toBe('JSONRPC');
    });

    it('should return empty if no match', () => {
      const resource = {};
      const connection = registry.getConnectionUri(resource);
      expect(connection.url).toBeUndefined();
    });

    it('should return empty if interfaces has no url', () => {
      const resource = {
        interfaces: [{protocolBinding: 'JSONRPC'}],
      };
      const connection = registry.getConnectionUri(resource);
      expect(connection.url).toBeUndefined();
    });

    it('should skip protocol if interfaces is missing', () => {
      const resource = {
        protocols: [
          {
            type: ProtocolType.A2A_AGENT,
          },
        ],
      };
      const connection = registry.getConnectionUri(resource, {
        protocolType: ProtocolType.A2A_AGENT,
      });
      expect(connection.url).toBeUndefined();
    });
  });

  describe('MCP Server Methods', () => {
    it('should list MCP servers with params', async () => {
      vi.spyOn(registry, 'makeRequest').mockResolvedValue({mcpServers: []});
      const res = await registry.listMcpServers({
        filterStr: 'name',
        pageSize: 10,
        pageToken: 'token',
      });
      expect(res).toEqual({mcpServers: []});
      expect(registry.makeRequest).toHaveBeenCalledWith('mcpServers', {
        filter: 'name',
        pageSize: '10',
        pageToken: 'token',
      });
    });

    it('should get MCP server details', async () => {
      vi.spyOn(registry, 'makeRequest').mockResolvedValue({name: 'mcp-1'});
      const res = await registry.getMcpServer('mcpServers/mcp-1');
      expect(res).toEqual({name: 'mcp-1'});
      expect(registry.makeRequest).toHaveBeenCalledWith('mcpServers/mcp-1');
    });

    it('should get MCP toolset with combined headers and destination ID', async () => {
      const serverDetails = {
        displayName: 'My BigQuery Server',
        mcpServerId: 'urn:mcp:1234:bigquery',
        interfaces: [
          {
            url: 'https://bigquery-mcp.googleapis.com/v1',
            protocolBinding: 'JSONRPC',
          },
        ],
      };

      vi.spyOn(registry, 'getMcpServer').mockResolvedValue(serverDetails);

      const toolset = await registry.getMcpToolset('mcpServers/bigquery');
      expect(toolset.prefix).toBe('My_BigQuery_Server');
      expect(toolset.destinationResourceId).toBe('urn:mcp:1234:bigquery');

      const tools = await toolset.getTools({} as ReadonlyContext);
      expect(tools.length).toBe(2);
      expect(
        (tools[0] as any).customMetadata[GCP_MCP_SERVER_DESTINATION_ID],
      ).toBe('urn:mcp:1234:bigquery');
    });

    it('should throw if connection URI not found', async () => {
      vi.spyOn(registry, 'getMcpServer').mockResolvedValue({});
      await expect(
        registry.getMcpToolset('mcpServers/invalid'),
      ).rejects.toThrow('MCP Server endpoint URI not found');
    });

    it('should resolve auth scheme from bindings if available', async () => {
      const serverDetails = {
        mcpServerId: 'urn:mcp:1234:bigquery',
        interfaces: [{url: 'https://example.com', protocolBinding: 'JSONRPC'}],
      };
      const bindingsData = {
        bindings: [
          {
            target: {identifier: 'urn:mcp:1234:bigquery'},
            authProviderBinding: {
              authProvider: 'projects/p/locations/l/authProviders/ap-1',
            },
          },
        ],
      };

      vi.spyOn(registry, 'getMcpServer').mockResolvedValue(serverDetails);
      vi.spyOn(registry, 'makeRequest').mockImplementation(async (path) => {
        if (path === 'bindings') return bindingsData;
        return {};
      });

      const toolset = await registry.getMcpToolset('mcpServers/bigquery');
      expect(toolset.authScheme).toEqual({
        type: 'gcpAuthProviderScheme',
        name: 'projects/p/locations/l/authProviders/ap-1',
        continueUri: undefined,
      });
    });

    it('should resolve auth scheme from bindings when empty options are passed', async () => {
      const serverDetails = {
        mcpServerId: 'urn:mcp:1234:bigquery',
        interfaces: [{url: 'https://example.com', protocolBinding: 'JSONRPC'}],
      };
      const bindingsData = {
        bindings: [
          {
            target: {identifier: 'urn:mcp:1234:bigquery'},
            authProviderBinding: {
              authProvider: 'projects/p/locations/l/authProviders/ap-1',
            },
          },
        ],
      };

      vi.spyOn(registry, 'getMcpServer').mockResolvedValue(serverDetails);
      vi.spyOn(registry, 'makeRequest').mockImplementation(async (path) => {
        if (path === 'bindings') return bindingsData;
        return {};
      });

      const toolset = await registry.getMcpToolset('mcpServers/bigquery', {});
      expect(toolset.authScheme).toEqual({
        type: 'gcpAuthProviderScheme',
        name: 'projects/p/locations/l/authProviders/ap-1',
        continueUri: undefined,
      });
    });

    it('should skip auth scheme resolution if bindings target mismatch', async () => {
      const serverDetails = {
        mcpServerId: 'urn:mcp:1234:bigquery',
        interfaces: [{url: 'https://example.com', protocolBinding: 'JSONRPC'}],
      };
      const bindingsData = {
        bindings: [
          {
            target: {identifier: 'urn:mcp:other'},
            authProviderBinding: {
              authProvider: 'projects/p/locations/l/authProviders/ap-1',
            },
          },
        ],
      };

      vi.spyOn(registry, 'getMcpServer').mockResolvedValue(serverDetails);
      vi.spyOn(registry, 'makeRequest').mockImplementation(async (path) => {
        if (path === 'bindings') return bindingsData;
        return {};
      });

      const toolset = await registry.getMcpToolset('mcpServers/bigquery');
      expect(toolset.authScheme).toBeUndefined();
    });

    it('should skip auth scheme resolution if authProviderBinding is missing', async () => {
      const serverDetails = {
        mcpServerId: 'urn:mcp:1234:bigquery',
        interfaces: [{url: 'https://example.com', protocolBinding: 'JSONRPC'}],
      };
      const bindingsData = {
        bindings: [
          {
            target: {identifier: 'urn:mcp:1234:bigquery'},
          },
        ],
      };

      vi.spyOn(registry, 'getMcpServer').mockResolvedValue(serverDetails);
      vi.spyOn(registry, 'makeRequest').mockImplementation(async (path) => {
        if (path === 'bindings') return bindingsData;
        return {};
      });

      const toolset = await registry.getMcpToolset('mcpServers/bigquery');
      expect(toolset.authScheme).toBeUndefined();
    });

    it('should skip auth scheme resolution if target identifier is missing', async () => {
      const serverDetails = {
        mcpServerId: 'urn:mcp:1234:bigquery',
        interfaces: [{url: 'https://example.com', protocolBinding: 'JSONRPC'}],
      };
      const bindingsData = {
        bindings: [
          {
            target: {},
            authProviderBinding: {
              authProvider: 'projects/p/locations/l/authProviders/ap-1',
            },
          },
        ],
      };

      vi.spyOn(registry, 'getMcpServer').mockResolvedValue(serverDetails);
      vi.spyOn(registry, 'makeRequest').mockImplementation(async (path) => {
        if (path === 'bindings') return bindingsData;
        return {};
      });

      const toolset = await registry.getMcpToolset('mcpServers/bigquery');
      expect(toolset.authScheme).toBeUndefined();
    });

    it('should skip auth scheme resolution if bindings list is missing', async () => {
      const serverDetails = {
        mcpServerId: 'urn:mcp:1234:bigquery',
        interfaces: [{url: 'https://example.com', protocolBinding: 'JSONRPC'}],
      };
      const bindingsData = {};

      vi.spyOn(registry, 'getMcpServer').mockResolvedValue(serverDetails);
      vi.spyOn(registry, 'makeRequest').mockImplementation(async (path) => {
        if (path === 'bindings') return bindingsData;
        return {};
      });

      const toolset = await registry.getMcpToolset('mcpServers/bigquery');
      expect(toolset.authScheme).toBeUndefined();
    });
  });

  describe('Endpoint Methods', () => {
    it('should list endpoints with page token', async () => {
      vi.spyOn(registry, 'makeRequest').mockResolvedValue({endpoints: []});
      await registry.listEndpoints({
        pageToken: 'token-789',
        pageSize: 5,
        filterStr: 'test',
      });
      expect(registry.makeRequest).toHaveBeenCalledWith('endpoints', {
        filter: 'test',
        pageSize: '5',
        pageToken: 'token-789',
      });
    });

    it('should get endpoint directly', async () => {
      vi.spyOn(registry, 'makeRequest').mockResolvedValue({
        name: 'endpoints/ep-1',
      });
      const res = await registry.getEndpoint('endpoints/ep-1');
      expect(res.name).toBe('endpoints/ep-1');
      expect(registry.makeRequest).toHaveBeenCalledWith('endpoints/ep-1');
    });

    it('should get model name from endpoint Connection URI', async () => {
      const endpointDetails = {
        interfaces: [
          {
            url: 'https://vertexai.googleapis.com/v1/projects/p-1/locations/l-1/models/m-1:predict',
          },
        ],
      };

      vi.spyOn(registry, 'getEndpoint').mockResolvedValue(endpointDetails);
      const modelName = await registry.getModelName('endpoints/ep-1');
      expect(modelName).toBe('projects/p-1/locations/l-1/models/m-1');
    });

    it('should return full projects/ path directly', async () => {
      const endpointDetails = {
        interfaces: [{url: 'projects/p-1/locations/l-1/models/m-1'}],
      };

      vi.spyOn(registry, 'getEndpoint').mockResolvedValue(endpointDetails);
      const modelName = await registry.getModelName('endpoints/ep-1');
      expect(modelName).toBe('projects/p-1/locations/l-1/models/m-1');
    });

    it('should return fallback URI if it does not contain projects/', async () => {
      const endpointDetails = {
        interfaces: [{url: 'https://custom-model-endpoint.com/v1/models/m-1'}],
      };

      vi.spyOn(registry, 'getEndpoint').mockResolvedValue(endpointDetails);
      const modelName = await registry.getModelName('endpoints/ep-1');
      expect(modelName).toBe('https://custom-model-endpoint.com/v1/models/m-1');
    });

    it('should throw if connection URI not found for model', async () => {
      vi.spyOn(registry, 'getEndpoint').mockResolvedValue({});
      await expect(registry.getModelName('endpoints/ep-1')).rejects.toThrow(
        'Connection URI not found',
      );
    });
  });

  describe('Agent Methods', () => {
    it('should list agents', async () => {
      vi.spyOn(registry, 'makeRequest').mockResolvedValue({agents: []});
      await registry.listAgents();
      expect(registry.makeRequest).toHaveBeenCalledWith('agents', {});
    });

    it('should construct RemoteA2AAgent from agent card content directly', async () => {
      const agentInfo = {
        card: {
          type: 'A2A_AGENT_CARD',
          content: {
            name: 'CustomAgent',
            description: 'Desc',
            version: '2.0.0',
            url: 'https://agent.com',
            preferredTransport: 'JSONRPC',
            protocolVersion: '0.3.0',
            skills: [],
          },
        },
      };

      vi.spyOn(registry, 'getAgentInfo').mockResolvedValue(agentInfo);
      const agent = await registry.getRemoteA2AAgent('agents/agent-1');
      expect(agent).toBeInstanceOf(RemoteA2AAgent);
      expect(agent.name).toBe('CustomAgent');
    });

    it('should construct RemoteA2AAgent dynamically from agent info and protocol connection', async () => {
      const agentInfo = {
        displayName: 'DynamicAgent',
        description: 'Dynamic Desc',
        protocols: [
          {
            type: ProtocolType.A2A_AGENT,
            interfaces: [
              {
                url: 'https://my-dynamic-agent.com',
                protocolBinding: 'HTTP_JSON',
              },
            ],
          },
        ],
        skills: [
          {
            id: 's-1',
            name: 'Translate',
            description: 'Translates text',
            tags: ['tag1'],
          },
          {id: 's-2', name: 'NoDescTagsExamples'},
        ],
      };

      vi.spyOn(registry, 'getAgentInfo').mockResolvedValue(agentInfo);
      const agent = await registry.getRemoteA2AAgent('agents/agent-1');
      expect(agent).toBeInstanceOf(RemoteA2AAgent);
      expect(agent.name).toBe('DynamicAgent');
      expect((agent as any).a2aConfig.agentCard.skills[1]).toEqual({
        id: 's-2',
        name: 'NoDescTagsExamples',
        description: '',
        tags: [],
        examples: [],
      });
    });

    it('should construct RemoteA2AAgent dynamically with empty options passed', async () => {
      const agentInfo = {
        displayName: 'DynamicAgentEmptyOptions',
        description: 'Empty options',
        protocols: [
          {
            type: ProtocolType.A2A_AGENT,
            interfaces: [
              {
                url: 'https://my-dynamic-agent.com',
                protocolBinding: 'HTTP_JSON',
              },
            ],
          },
        ],
      };

      vi.spyOn(registry, 'getAgentInfo').mockResolvedValue(agentInfo);
      const agent = await registry.getRemoteA2AAgent('agents/agent-1', {});
      expect(agent).toBeInstanceOf(RemoteA2AAgent);
      expect((agent as any).a2aConfig.client).toBeUndefined();
      expect((agent as any).a2aConfig.clientFactory).toBeUndefined();
    });

    it('should get agent info directly', async () => {
      vi.spyOn(registry, 'makeRequest').mockResolvedValue({
        displayName: 'AgentName',
      });
      const res = await registry.getAgentInfo('agents/agent-1');
      expect(res.displayName).toBe('AgentName');
      expect(registry.makeRequest).toHaveBeenCalledWith('agents/agent-1');
    });

    it('should list agents with all parameters', async () => {
      vi.spyOn(registry, 'makeRequest').mockResolvedValue({agents: []});
      const res = await registry.listAgents({
        filterStr: 'active',
        pageSize: 20,
        pageToken: 'token123',
      });
      expect(res).toEqual({agents: []});
      expect(registry.makeRequest).toHaveBeenCalledWith('agents', {
        filter: 'active',
        pageSize: '20',
        pageToken: 'token123',
      });
    });

    it('should throw if connection URI not found for dynamic agent construction', async () => {
      vi.spyOn(registry, 'getAgentInfo').mockResolvedValue({});
      await expect(
        registry.getRemoteA2AAgent('agents/agent-1'),
      ).rejects.toThrow('A2A connection URI not found');
    });

    it('should construct RemoteA2AAgent dynamically with no skills and fallback protocol binding', async () => {
      const agentInfo = {
        displayName: 'DynamicAgentNoSkills',
        description: 'No skills',
        protocols: [
          {
            type: ProtocolType.A2A_AGENT,
            interfaces: [
              {url: 'https://my-dynamic-agent.com'}, // protocolBinding is missing
            ],
          },
        ],
      };

      vi.spyOn(registry, 'getAgentInfo').mockResolvedValue(agentInfo);
      const agent = await registry.getRemoteA2AAgent('agents/agent-1');
      expect(agent).toBeInstanceOf(RemoteA2AAgent);
      expect(agent.name).toBe('DynamicAgentNoSkills');
      expect((agent as any).a2aConfig.agentCard.preferredTransport).toBe(
        'HTTP+JSON',
      );
      expect((agent as any).a2aConfig.agentCard.skills).toEqual([]);
    });

    it('should pass client and clientFactory when card type matches and options are provided', async () => {
      const agentInfo = {
        card: {
          type: 'A2A_AGENT_CARD',
          content: {
            name: 'CustomAgentWithOptions',
            description: 'Desc',
            url: 'https://agent.com',
            preferredTransport: 'JSONRPC',
            protocolVersion: '0.3.0',
            skills: [],
          },
        },
      };

      const dummyClient = {};
      const dummyClientFactory = () => {};

      vi.spyOn(registry, 'getAgentInfo').mockResolvedValue(agentInfo);
      const agent = await registry.getRemoteA2AAgent('agents/agent-1', {
        client: dummyClient,
        clientFactory: dummyClientFactory,
      });
      expect(agent).toBeInstanceOf(RemoteA2AAgent);
      expect((agent as any).a2aConfig.client).toBe(dummyClient);
      expect((agent as any).a2aConfig.clientFactory).toBe(dummyClientFactory);
    });
  });

  describe('AgentRegistrySingleMCPToolset Lifecycle', () => {
    it('should support closing the toolset', async () => {
      const connectionParams: any = {
        type: 'StreamableHTTPConnectionParams',
        url: 'https://example.com',
      };
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams,
      } as any);
      await expect(toolset.close()).resolves.toBeUndefined();
    });

    it('should support custom header providers and merge headers', async () => {
      const customHeaderRegistry = new AgentRegistry({
        projectId: 'test-project',
        location: 'global',
        headerProvider: () => ({'Custom-Header': 'value'}),
      });

      const serverDetails = {
        mcpServerId: 'urn:mcp:1234:bigquery',
        interfaces: [
          {
            url: 'https://bigquery-mcp.googleapis.com/v1',
            protocolBinding: 'JSONRPC',
          },
        ],
      };
      vi.spyOn(customHeaderRegistry, 'getMcpServer').mockResolvedValue(
        serverDetails,
      );

      const toolset = await customHeaderRegistry.getMcpToolset('mcpServers/bq');
      const tools = await toolset.getTools({} as ReadonlyContext);
      expect(tools.length).toBe(2);
    });

    it('should support getMcpToolset with empty options and verify auth headers added for Google API', async () => {
      const customHeaderRegistry = new AgentRegistry({
        projectId: 'test-project',
        location: 'global',
      });

      const serverDetails = {
        mcpServerId: 'urn:mcp:1234:bigquery',
        interfaces: [
          {
            url: 'https://bigquery-mcp.googleapis.com/v1',
            protocolBinding: 'JSONRPC',
          },
        ],
      };
      vi.spyOn(customHeaderRegistry, 'getMcpServer').mockResolvedValue(
        serverDetails,
      );

      const toolset = await customHeaderRegistry.getMcpToolset(
        'mcpServers/bq',
        {},
      );
      const tools = await toolset.getTools({} as ReadonlyContext);
      expect(tools.length).toBe(2);
    });

    it('should filter tools if toolFilter option is provided', async () => {
      const connectionParams: any = {
        type: 'StreamableHTTPConnectionParams',
        url: 'https://example.com',
      };
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams,
        toolFilter: ['tool1'],
      });

      const context = {} as ReadonlyContext;
      const tools = await toolset.getTools(context);
      expect(tools.length).toBe(1);
      expect(tools[0].name).toBe('tool1');
    });

    it('should successfully getTools when transportOptions and requestInit are missing', async () => {
      const connectionParams: StreamableHTTPConnectionParams = {
        type: 'StreamableHTTPConnectionParams',
        url: 'https://example.com',
        // transportOptions is completely omitted
      };
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams,
      });

      const context = {} as ReadonlyContext;
      const tools = await toolset.getTools(context);
      expect(tools.length).toBe(2);
      expect(tools[0].name).toBe('tool1');
    });

    it('should successfully getTools when transportOptions is defined but requestInit is missing', async () => {
      const connectionParams: StreamableHTTPConnectionParams = {
        type: 'StreamableHTTPConnectionParams',
        url: 'https://example.com',
        transportOptions: {
          // requestInit is completely omitted
        },
      };
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams,
      });

      const context = {} as ReadonlyContext;
      const tools = await toolset.getTools(context);
      expect(tools.length).toBe(2);
      expect(tools[0].name).toBe('tool1');
    });

    it('should successfully getTools when requestInit is defined but headers are missing', async () => {
      const connectionParams: StreamableHTTPConnectionParams = {
        type: 'StreamableHTTPConnectionParams',
        url: 'https://example.com',
        transportOptions: {
          requestInit: {
            // headers is completely omitted
          },
        },
      };
      const toolset = new AgentRegistrySingleMCPToolset({
        connectionParams,
      });

      const context = {} as ReadonlyContext;
      const tools = await toolset.getTools(context);
      expect(tools.length).toBe(2);
      expect(tools[0].name).toBe('tool1');
    });
  });

  describe('Edge cases for auth headers and connection URI filters', () => {
    it('should throw error if getClient throws an error in getAuthHeaders', async () => {
      shouldAuthThrow = true;

      const badRegistry = new AgentRegistry({
        projectId: 'test-project',
        location: 'global',
      });

      try {
        await expect(badRegistry.getAuthHeaders()).rejects.toThrow(
          'Failed to refresh Google Cloud credentials: Auth error',
        );
      } finally {
        shouldAuthThrow = false;
      }
    });

    it('should skip protocol if type does not match in getConnectionUri', () => {
      const resource = {
        protocols: [
          {
            type: ProtocolType.CUSTOM,
            interfaces: [
              {url: 'https://custom.com', protocolBinding: 'HTTP_JSON'},
            ],
          },
        ],
      };

      const connection = registry.getConnectionUri(resource, {
        protocolType: ProtocolType.A2A_AGENT,
      });
      expect(connection.url).toBeUndefined();
    });

    it('should skip interface if protocolBinding does not match in getConnectionUri', () => {
      const resource = {
        protocols: [
          {
            type: ProtocolType.A2A_AGENT,
            interfaces: [{url: 'https://agent.com', protocolBinding: 'GRPC'}],
          },
        ],
      };

      const connection = registry.getConnectionUri(resource, {
        protocolType: ProtocolType.A2A_AGENT,
        protocolBinding: 'HTTP+JSON',
      });
      expect(connection.url).toBeUndefined();
    });
  });
});
