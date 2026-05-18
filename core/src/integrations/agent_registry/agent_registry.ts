/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  AgentCapabilities,
  AgentCard,
  AgentSkill,
  TransportProtocol,
} from '@a2a-js/sdk';
import {ListToolsResult} from '@modelcontextprotocol/sdk/types.js';
import {GoogleAuth} from 'google-auth-library';
import {RemoteA2AAgent} from '../../a2a/a2a_remote_agent.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseToolset, ToolPredicate} from '../../tools/base_toolset.js';
import {
  MCPSessionManager,
  StreamableHTTPConnectionParams,
} from '../../tools/mcp/mcp_session_manager.js';
import {MCPTool} from '../../tools/mcp/mcp_tool.js';
import {logger} from '../../utils/logger.js';

export const AGENT_REGISTRY_BASE_URL =
  'https://agentregistry.googleapis.com/v1alpha';
export const GCP_MCP_SERVER_DESTINATION_ID = 'gcp.mcp.server.destination.id';

const TRANSPORT_MAPPING: Record<string, TransportProtocol> = {
  'HTTP_JSON': 'HTTP+JSON',
  'JSONRPC': 'JSONRPC',
  'GRPC': 'GRPC',
};

export enum ProtocolType {
  TYPE_UNSPECIFIED = 'TYPE_UNSPECIFIED',
  A2A_AGENT = 'A2A_AGENT',
  CUSTOM = 'CUSTOM',
}

export interface Interface {
  url?: string;
  protocolBinding?: string;
}

export interface Endpoint {
  name?: string;
  endpointId?: string;
  displayName?: string;
  description?: string;
  interfaces?: Interface[];
  createTime?: string;
  updateTime?: string;
  attributes?: Record<string, any>;
}

export interface GcpAuthProviderScheme {
  type: 'gcpAuthProviderScheme';
  name: string;
  scopes?: string[];
  continueUri?: string;
}

export function _isGoogleApi(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === 'googleapis.com' ||
      parsed.hostname.endsWith('.googleapis.com')
    );
  } catch {
    return false;
  }
}

export function _cleanName(name: string): string {
  let clean = name.replace(/[^a-zA-Z0-9_]/g, '_');
  clean = clean.replace(/_+/g, '_');
  clean = clean.replace(/^_+|_+$/g, '');
  if (clean && !/^[a-zA-Z_]/.test(clean)) {
    clean = '_' + clean;
  }
  return clean;
}

/**
 * A specialized BaseToolset subclass designed to represent a single registered MCP server.
 *
 * Unlike a standard MCPToolset, this class:
 * 1. Supports a dynamic `headerProvider` to fetch/refresh authorization and custom headers
 *    immediately before establishing the MCP connection session.
 * 2. Automatically injects the special `gcp.mcp.server.destination.id` telemetry metadata
 *    identifier into all resolved tools' custom metadata, allowing downstream execute_tool
 *    traces to be correctly attributed.
 */
export class AgentRegistrySingleMCPToolset extends BaseToolset {
  readonly destinationResourceId?: string;
  readonly connectionParams: StreamableHTTPConnectionParams;
  readonly headerProvider?: (
    context?: ReadonlyContext,
  ) => Promise<Record<string, string>> | Record<string, string>;
  readonly authScheme?: AuthScheme;
  readonly authCredential?: AuthCredential;

  constructor(options: {
    destinationResourceId?: string;
    connectionParams: StreamableHTTPConnectionParams;
    toolFilter?: ToolPredicate | string[];
    prefix?: string;
    headerProvider?: (
      context?: ReadonlyContext,
    ) => Promise<Record<string, string>> | Record<string, string>;
    authScheme?: AuthScheme;
    authCredential?: AuthCredential;
  }) {
    super(options.toolFilter || [], options.prefix);
    this.destinationResourceId = options.destinationResourceId;
    this.connectionParams = options.connectionParams;
    this.headerProvider = options.headerProvider;
    this.authScheme = options.authScheme;
    this.authCredential = options.authCredential;
  }

  /**
   * Connects to the underlying MCP server, retrieves tool definitions, prefixes tool names,
   * and injects destination telemetry metadata.
   */
  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const headers: Record<string, string> = {};

    // Resolve dynamic headers from the header provider (e.g., refreshing GCP tokens)
    if (this.headerProvider) {
      const providerHeaders = await this.headerProvider(context);
      Object.assign(headers, providerHeaders);
    }

    // Merge resolved headers into transport request options
    const connectionParamsCopy: StreamableHTTPConnectionParams = {
      ...this.connectionParams,
      transportOptions: {
        ...this.connectionParams.transportOptions,
        requestInit: {
          ...this.connectionParams.transportOptions?.requestInit,
          headers: {
            ...this.connectionParams.transportOptions?.requestInit?.headers,
            ...headers,
          } as Record<string, string>,
        },
      },
    };

    // Establish session using MCPSessionManager
    const sessionManager = new MCPSessionManager(connectionParamsCopy);
    const session = await sessionManager.createSession();

    // Retrieve tools from the remote server and map them to MCPTools
    const listResult = (await session.listTools()) as ListToolsResult;
    const tools = listResult.tools.map((tool) => {
      const prefixedName = this.prefix
        ? `${this.prefix}_${tool.name}`
        : tool.name;
      const mcpTool = new MCPTool(
        {...tool, name: prefixedName},
        sessionManager,
        tool.name,
      );

      // Inject gcp.mcp.server.destination.id telemetry key for tracing tools execution
      const toolAsAny = mcpTool as any;
      if (this.destinationResourceId) {
        if (!toolAsAny.customMetadata) {
          toolAsAny.customMetadata = {};
        }
        toolAsAny.customMetadata[GCP_MCP_SERVER_DESTINATION_ID] =
          this.destinationResourceId;
      }
      return mcpTool;
    });

    // Apply toolFilter selection when specified
    const filter = this.toolFilter;
    if (!filter || (Array.isArray(filter) && filter.length === 0)) {
      return tools;
    }

    return tools.filter((t) => this.isToolSelected(t, context!));
  }

  async close(): Promise<void> {}
}

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
  private readonly _basePath: string;
  private readonly _headerProvider?: (
    context: ReadonlyContext,
  ) => Record<string, string>;
  private readonly _auth: GoogleAuth;

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
    this._basePath = `projects/${this.projectId}/locations/${this.location}`;
    this._headerProvider = options.headerProvider;

    // Set up Google Application Default Credentials (ADC) with core cloud platform scopes
    this._auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }

  /**
   * Resolves default Google Cloud credentials and returns standard headers.
   * Automatically caches, fetches, and handles refreshing expired OAuth tokens.
   * Injects the billing/quota project identifier `x-goog-user-project` if present.
   */
  async _getAuthHeaders(): Promise<Record<string, string>> {
    try {
      const client = await this._auth.getClient();
      const headers = await client.getRequestHeaders(
        'https://agentregistry.googleapis.com',
      );
      const authHeaders: Record<string, string> = {};
      const rawHeaders = headers as any;
      const authKey = Object.keys(rawHeaders).find(
        (k) => k.toLowerCase() === 'authorization',
      );
      let token = authKey ? rawHeaders[authKey] : undefined;

      // Fallback directly to the populated credentials object if headers are empty
      if (
        !token &&
        client.credentials &&
        (client.credentials as any).access_token
      ) {
        token = `Bearer ${(client.credentials as any).access_token}`;
      }

      if (token) {
        authHeaders['Authorization'] = token;
      }
      authHeaders['Content-Type'] = 'application/json';

      // Inject quota project ID for usage and billing tracking
      const quotaProjectId =
        (client as any).quotaProjectId || (this._auth as any).quotaProjectId;
      if (quotaProjectId) {
        authHeaders['x-goog-user-project'] = quotaProjectId;
      }
      return authHeaders;
    } catch (err: any) {
      throw new Error(
        `Failed to refresh Google Cloud credentials: ${err.message}`,
      );
    }
  }

  /**
   * Helper function to execute HTTP GET requests against the Agent Registry API.
   * Handles path resolution, search query params compilation, and auth headers fetching.
   */
  async _makeRequest(
    path: string,
    params?: Record<string, string>,
  ): Promise<any> {
    let url: string;
    // Support absolute resource paths (starting with projects/) or relative paths (resolved inside base path)
    if (path.startsWith('projects/')) {
      url = `${AGENT_REGISTRY_BASE_URL}/${path}`;
    } else {
      url = `${AGENT_REGISTRY_BASE_URL}/${this._basePath}/${path}`;
    }

    if (params && Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }

    try {
      const headers = await this._getAuthHeaders();
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
      return await res.json();
    } catch (err: any) {
      if (err.message.includes('API request failed')) {
        throw err;
      }
      throw new Error(`API request failed: ${err.message}`);
    }
  }

  /**
   * Parses connection interfaces list from registry metadata and returns the first match
   * corresponding to requested protocol types and binding options.
   */
  _getConnectionUri(
    resourceDetails: any,
    filters?: {
      protocolType?: ProtocolType;
      protocolBinding?: string;
    },
  ): {
    url?: string;
    protocolVersion?: string;
    protocolBinding?: TransportProtocol;
  } {
    const protocols: any[] = [];
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
        const mappedBinding = TRANSPORT_MAPPING[i.protocolBinding];
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
  }): Promise<any> {
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
    return this._makeRequest('mcpServers', params);
  }

  async getMcpServer(name: string): Promise<any> {
    return this._makeRequest(name);
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
    const name = _cleanName(serverDetails.displayName || mcpServerName);
    const mcpServerId = serverDetails.mcpServerId;

    let endpointUri = this._getConnectionUri(serverDetails, {
      protocolBinding: 'JSONRPC',
    }).url;

    if (!endpointUri) {
      endpointUri = this._getConnectionUri(serverDetails, {
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
        const bindingsData = await this._makeRequest('bindings');
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
              } as any;
              break;
            }
          }
        }
      } catch (err: any) {
        logger.warn(
          `Failed to fetch bindings for MCP Server ${mcpServerName}: ${err.message}`,
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
        _isGoogleApi(endpointUri!)
      ) {
        Object.assign(headers, await this._getAuthHeaders());
      }
      if (this._headerProvider && context) {
        Object.assign(headers, this._headerProvider(context));
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
  }): Promise<any> {
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
    return this._makeRequest('endpoints', params);
  }

  async getEndpoint(name: string): Promise<Endpoint> {
    return this._makeRequest(name);
  }

  async getModelName(endpointName: string): Promise<string> {
    const endpointDetails = await this.getEndpoint(endpointName);
    const {url} = this._getConnectionUri(endpointDetails);
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
  }): Promise<any> {
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
    return this._makeRequest('agents', params);
  }

  async getAgentInfo(name: string): Promise<any> {
    return this._makeRequest(name);
  }

  async getRemoteA2AAgent(
    agentName: string,
    options?: {
      client?: any;
      clientFactory?: any;
    },
  ): Promise<RemoteA2AAgent> {
    const agentInfo = await this.getAgentInfo(agentName);

    // Try to use the full agent card if available
    const card = agentInfo.card || {};
    const cardContent = card.content;
    if (card.type === 'A2A_AGENT_CARD' && cardContent) {
      const agentCard: AgentCard = cardContent;
      const name = _cleanName(agentCard.name);

      return new RemoteA2AAgent({
        name,
        agentCard,
        description: agentCard.description,
        client: options?.client,
        clientFactory: options?.clientFactory,
      });
    }

    const name = _cleanName(agentInfo.displayName || agentName);
    const description = agentInfo.description || '';
    const version = agentInfo.version || '';

    const {url, protocolVersion, protocolBinding} = this._getConnectionUri(
      agentInfo,
      {
        protocolType: ProtocolType.A2A_AGENT,
      },
    );

    if (!url) {
      throw new Error(`A2A connection URI not found for Agent: ${agentName}`);
    }

    const skills: AgentSkill[] = (agentInfo.skills || []).map((s: any) => ({
      id: s.id,
      name: s.name,
      description: s.description || '',
      tags: s.tags || [],
      examples: s.examples || [],
    }));

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
