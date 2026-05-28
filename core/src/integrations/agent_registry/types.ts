/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard, TransportProtocol} from '@a2a-js/sdk';

export const AGENT_REGISTRY_BASE_URL =
  'https://agentregistry.googleapis.com/v1alpha';
export const GCP_MCP_SERVER_DESTINATION_ID = 'gcp.mcp.server.destination.id';

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
  attributes?: Record<string, unknown>;
}

export interface GcpAuthProviderScheme {
  type: 'gcpAuthProviderScheme';
  name: string;
  scopes?: string[];
  continueUri?: string;
}

export interface McpServer {
  name?: string;
  displayName?: string;
  mcpServerId?: string;
  interfaces?: Interface[];
  protocols?: Array<{
    type?: ProtocolType;
    protocolVersion?: string;
    interfaces?: Interface[];
  }>;
  [key: string]: unknown;
}

export interface Binding {
  target?: {
    identifier?: string;
  };
  authProviderBinding?: {
    authProvider?: string;
  };
}

export interface ListBindingsResponse {
  bindings?: Binding[];
}

export interface ListMcpServersResponse {
  mcpServers?: Array<Record<string, unknown>>;
  nextPageToken?: string;
}

export interface ListEndpointsResponse {
  endpoints?: Array<Endpoint>;
  nextPageToken?: string;
}

export interface ListAgentsResponse {
  agents?: Array<Record<string, unknown>>;
  nextPageToken?: string;
}

export interface AgentSkillMetadata {
  id?: string;
  name?: string;
  description?: string;
  tags?: string[];
  examples?: unknown[];
}

export interface AgentInfo {
  displayName?: string;
  description?: string;
  version?: string;
  card?: {
    type?: string;
    content?: AgentCard;
  };
  interfaces?: Interface[];
  protocols?: Array<{
    type?: ProtocolType;
    protocolVersion?: string;
    interfaces?: Interface[];
  }>;
  skills?: AgentSkillMetadata[];
  [key: string]: unknown;
}

export interface ConnectionUriFilter {
  protocolType?: ProtocolType;
  protocolBinding?: string;
}

export interface ConnectionUriResult {
  url?: string;
  protocolVersion?: string;
  protocolBinding?: TransportProtocol;
}
