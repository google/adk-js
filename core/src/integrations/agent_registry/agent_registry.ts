/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentCapabilities,
  AgentCard,
  AgentSkill,
  TransportProtocol,
} from '@a2a-js/sdk';
import {Client, ClientFactory} from '@a2a-js/sdk/client';
import {GoogleAuth} from 'google-auth-library';
import {RemoteA2AAgent} from '../../a2a/a2a_remote_agent.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {StreamableHTTPConnectionParams} from '../../tools/mcp/mcp_session_manager.js';
import {logger} from '../../utils/logger.js';
import {AgentRegistrySingleMCPToolset} from './agent_registry_mcp_toolset.js';
import {cleanName, isGoogleApi} from './helpers.js';
import {
  AGENT_REGISTRY_BASE_URL,
  AgentInfo,
  AgentSkillMetadata,
  ConnectionUriFilter,
  ConnectionUriResult,
  Endpoint,
  GcpAuthProviderScheme,
  ListAgentsResponse,
  ListBindingsResponse,
  ListEndpointsResponse,
  ListMcpServersResponse,
  McpServer,
  ProtocolType,
} from './types.js';

export * from './agent_registry_mcp_toolset.js';
export * from './helpers.js';
export * from './types.js';

const TRANSPORT_MAPPING: Record<string, TransportProtocol> = {
  'HTTP_JSON': 'HTTP+JSON',
  'JSONRPC': 'JSONRPC',
  'GRPC': 'GRPC',
};

/**
 * Client for interacting with the Google Cloud Agent Registry service.
 *
 * Unlike a standard REST client library, this class provides higher-level
 * abstractions for ADK integration. It surfaces the agent registry service
 * methods along with helper methods like `getMcpToolset` and
 * `getRemoteA2AAgent` that automatically resolve connection details,
 * manage OAuth authentication schemes, and handle GCP credentials to produce
 * ready-to-use ADK components.
 */
export class AgentRegistry {
  readonly projectId: string;
  readonly location: string;
  private readonly basePath: string;
  private readonly headerProvider?: (
    context: ReadonlyContext,
  ) => Record<string, string>;
  private readonly auth: GoogleAuth;

  constructor(options: {
    projectId?: string | null;
    location?: string | null;
    headerProvider?: (context: ReadonlyContext) => Record<string, string>;
  }) {
    if (!options.projectId || !options.location) {
      throw new Error('project_id and location must be provided');
    }
    this.projectId = options.projectId;
    this.location = options.location;
    this.basePath = `projects/${this.projectId}/locations/${this.location}`;
    this.headerProvider = options.headerProvider;

    // Set up Google Application Default Credentials (ADC) with core cloud platform scopes
    this.auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }

  /**
   * Resolves default Google Cloud credentials and returns standard headers.
   * Automatically caches, fetches, and handles refreshing expired OAuth tokens.
   * Injects the billing/quota project identifier `x-goog-user-project` if present.
   */
  async getAuthHeaders(): Promise<Record<string, string>> {
    try {
      const client = await this.auth.getClient();
      const headers = await client.getRequestHeaders(
        'https://agentregistry.googleapis.com',
      );
      const authHeaders: Record<string, string> = {};
      const rawHeaders = headers as unknown as Record<string, string>;
      const authKey = Object.keys(rawHeaders).find(
        (k) => k.toLowerCase() === 'authorization',
      );
      let token = authKey ? rawHeaders[authKey] : undefined;

      // Fallback directly to the populated credentials object if headers are empty
      if (
        !token &&
        client.credentials &&
        (client.credentials as {access_token?: string}).access_token
      ) {
        token = `Bearer ${(client.credentials as {access_token?: string}).access_token}`;
      }

      if (token) {
        authHeaders['Authorization'] = token;
      }
      authHeaders['Content-Type'] = 'application/json';

      // Inject quota project ID for usage and billing tracking
      const quotaProjectId =
        (client as unknown as {quotaProjectId?: string}).quotaProjectId ||
        (this.auth as unknown as {quotaProjectId?: string}).quotaProjectId;
      if (quotaProjectId) {
        authHeaders['x-goog-user-project'] = quotaProjectId;
      }
      return authHeaders;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to refresh Google Cloud credentials: ${msg}`);
    }
  }

  /**
   * Helper function to execute HTTP GET requests against the Agent Registry API.
   * Handles path resolution, search query params compilation, and auth headers fetching.
   */
  async makeRequest<T = unknown>(
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    let url: string;
    // Support absolute resource paths (starting with projects/) or relative paths (resolved inside base path)
    if (path.startsWith('projects/')) {
      url = `${AGENT_REGISTRY_BASE_URL}/${path}`;
    } else {
      url = `${AGENT_REGISTRY_BASE_URL}/${this.basePath}/${path}`;
    }

    if (params && Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }

    try {
      const headers = await this.getAuthHeaders();
      const res = await fetch(url, {
        method: 'GET',
        headers,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `API request failed with status ${res.status}: ${text}`,
        );
      }
      return (await res.json()) as T;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('API request failed')) {
        throw err;
      }
      throw new Error(`API request failed: ${msg}`);
    }
  }

  /**
   * Parses connection interfaces list from registry metadata and returns the first match
   * corresponding to requested protocol types and binding options.
   */
  getConnectionUri(
    resourceDetails: {
      interfaces?: Array<{url?: string; protocolBinding?: string}>;
      protocols?: Array<{
        type?: ProtocolType;
        protocolVersion?: string;
        interfaces?: Array<{url?: string; protocolBinding?: string}>;
      }>;
    },
    filters?: ConnectionUriFilter,
  ): ConnectionUriResult {
    const protocols: Array<{
      type?: ProtocolType;
      protocolVersion?: string;
      interfaces?: Array<{url?: string; protocolBinding?: string}>;
    }> = [];
    if (resourceDetails.protocols) {
      protocols.push(...resourceDetails.protocols);
    }
    if (resourceDetails.interfaces) {
      protocols.push({interfaces: resourceDetails.interfaces});
    }

    for (const p of protocols) {
      if (filters?.protocolType && p.type !== filters.protocolType) {
        continue;
      }
      const protocolVersion = p.protocolVersion;
      const interfaces = p.interfaces || [];
      for (const i of interfaces) {
        const mappedBinding = i.protocolBinding
          ? TRANSPORT_MAPPING[i.protocolBinding]
          : undefined;
        if (
          filters?.protocolBinding &&
          mappedBinding !== filters.protocolBinding
        ) {
          continue;
        }
        if (i.url) {
          return {url: i.url, protocolVersion, protocolBinding: mappedBinding};
        }
      }
    }

    return {};
  }

  // --- MCP Server Methods ---

  async listMcpServers(options?: {
    filterStr?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<ListMcpServersResponse> {
    const params: Record<string, string> = {};
    if (options?.filterStr) {
      params['filter'] = options.filterStr;
    }
    if (options?.pageSize) {
      params['pageSize'] = String(options.pageSize);
    }
    if (options?.pageToken) {
      params['pageToken'] = options.pageToken;
    }
    return this.makeRequest<ListMcpServersResponse>('mcpServers', params);
  }

  async getMcpServer(name: string): Promise<McpServer> {
    return this.makeRequest<McpServer>(name);
  }

  async getMcpToolset(
    mcpServerName: string,
    options?: {
      authScheme?: AuthScheme;
      authCredential?: AuthCredential;
      continueUri?: string;
    },
  ): Promise<AgentRegistrySingleMCPToolset> {
    const serverDetails = await this.getMcpServer(mcpServerName);
    const name = cleanName(serverDetails.displayName || mcpServerName);
    const mcpServerId = serverDetails.mcpServerId;

    let endpointUri = this.getConnectionUri(serverDetails, {
      protocolBinding: 'JSONRPC',
    }).url;

    if (!endpointUri) {
      endpointUri = this.getConnectionUri(serverDetails, {
        protocolBinding: 'HTTP+JSON',
      }).url;
    }

    if (!endpointUri) {
      throw new Error(
        `MCP Server endpoint URI not found for: ${mcpServerName}`,
      );
    }

    let authScheme = options?.authScheme;

    if (mcpServerId && !authScheme) {
      try {
        const bindingsData =
          await this.makeRequest<ListBindingsResponse>('bindings');
        const bindings = bindingsData.bindings || [];
        for (const b of bindings) {
          const targetId = b.target?.identifier || '';
          if (targetId.endsWith(mcpServerId)) {
            const authProvider = b.authProviderBinding?.authProvider;
            if (authProvider) {
              authScheme = {
                type: 'gcpAuthProviderScheme',
                name: authProvider,
                continueUri: options?.continueUri,
              } as GcpAuthProviderScheme as unknown as AuthScheme;
              break;
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `Failed to fetch bindings for MCP Server ${mcpServerName}: ${msg}`,
        );
      }
    }

    const connectionParams: StreamableHTTPConnectionParams = {
      type: 'StreamableHTTPConnectionParams',
      url: endpointUri,
    };

    const combinedHeaderProvider = async (context?: ReadonlyContext) => {
      const headers: Record<string, string> = {};
      if (
        !authScheme &&
        !options?.authCredential &&
        isGoogleApi(endpointUri!)
      ) {
        Object.assign(headers, await this.getAuthHeaders());
      }
      if (this.headerProvider && context) {
        Object.assign(headers, this.headerProvider(context));
      }
      return headers;
    };

    return new AgentRegistrySingleMCPToolset({
      destinationResourceId: mcpServerId,
      connectionParams,
      prefix: name,
      headerProvider: combinedHeaderProvider,
      authScheme,
      authCredential: options?.authCredential,
    });
  }

  // --- Endpoint Methods ---

  async listEndpoints(options?: {
    filterStr?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<ListEndpointsResponse> {
    const params: Record<string, string> = {};
    if (options?.filterStr) {
      params['filter'] = options.filterStr;
    }
    if (options?.pageSize) {
      params['pageSize'] = String(options.pageSize);
    }
    if (options?.pageToken) {
      params['pageToken'] = options.pageToken;
    }
    return this.makeRequest<ListEndpointsResponse>('endpoints', params);
  }

  async getEndpoint(name: string): Promise<Endpoint> {
    return this.makeRequest<Endpoint>(name);
  }

  async getModelName(endpointName: string): Promise<string> {
    const endpointDetails = await this.getEndpoint(endpointName);
    const {url} = this.getConnectionUri(endpointDetails);
    if (!url) {
      throw new Error(`Connection URI not found for endpoint: ${endpointName}`);
    }

    const uri = url.replace(/:\w+$/, '');
    if (uri.startsWith('projects/')) {
      return uri;
    }

    const match = uri.match(/(projects\/.+)/);
    if (match) {
      return match[1];
    }
    return uri;
  }

  // --- Agent Methods ---

  async listAgents(options?: {
    filterStr?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<ListAgentsResponse> {
    const params: Record<string, string> = {};
    if (options?.filterStr) {
      params['filter'] = options.filterStr;
    }
    if (options?.pageSize) {
      params['pageSize'] = String(options.pageSize);
    }
    if (options?.pageToken) {
      params['pageToken'] = options.pageToken;
    }
    return this.makeRequest<ListAgentsResponse>('agents', params);
  }

  async getAgentInfo(name: string): Promise<AgentInfo> {
    return this.makeRequest<AgentInfo>(name);
  }

  async getRemoteA2AAgent(
    agentName: string,
    options?: {
      client?: Client;
      clientFactory?: ClientFactory;
    },
  ): Promise<RemoteA2AAgent> {
    const agentInfo = await this.getAgentInfo(agentName);

    // Try to use the full agent card if available
    const card = agentInfo.card || {};
    const cardContent = card.content;
    if (card.type === 'A2A_AGENT_CARD' && cardContent) {
      const agentCard: AgentCard = cardContent;
      const name = cleanName(agentCard.name);

      return new RemoteA2AAgent({
        name,
        agentCard,
        description: agentCard.description,
        client: options?.client,
        clientFactory: options?.clientFactory,
      });
    }

    const name = cleanName(agentInfo.displayName || agentName);
    const description = agentInfo.description || '';
    const version = agentInfo.version || '';

    const {url, protocolVersion, protocolBinding} = this.getConnectionUri(
      agentInfo,
      {
        protocolType: ProtocolType.A2A_AGENT,
      },
    );

    if (!url) {
      throw new Error(`A2A connection URI not found for Agent: ${agentName}`);
    }

    const skills: AgentSkill[] = (agentInfo.skills || []).map(
      (s: AgentSkillMetadata) => ({
        id: s.id!,
        name: s.name!,
        description: s.description || '',
        tags: s.tags || [],
        examples: (s.examples as string[]) || [],
      }),
    );

    const agentCard: AgentCard = {
      name,
      description,
      version,
      preferredTransport: protocolBinding || 'HTTP+JSON',
      protocolVersion: protocolVersion || '0.3.0',
      url,
      skills,
      capabilities: {
        streaming: false,
      } as AgentCapabilities,
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
    };

    return new RemoteA2AAgent({
      name,
      agentCard,
      description,
      client: options?.client,
      clientFactory: options?.clientFactory,
    });
  }
}
