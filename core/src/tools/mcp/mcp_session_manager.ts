/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport, StdioServerParameters} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Defines the parameters for establishing a connection to an MCP server using
 * standard input/output (stdio). This is typically used for running MCP servers
 * as local child processes.
 */
export interface StdioConnectionParams {
  type: 'StdioConnectionParams';
  serverParams: StdioServerParameters;
  timeout?: Number;
}

/**
 * Defines the parameters for establishing a connection to an MCP server over
 * HTTP using Server-Sent Events (SSE) for streaming.
 *
 * Usage:
 *  const connectionParams: StreamableHTTPConnectionParams = {
 *    type: 'StreamableHTTPConnectionParams',
 *    url: 'http://localhost:8788/mcp'
 *  };
 */
export interface StreamableHTTPConnectionParams {
  type: 'StreamableHTTPConnectionParams';
  url: string;
  header?: Record<string, unknown>;
  timeout?: Number;
  sseReadTimeout?: Number;
  terminateOnClose?: boolean;
}

/**
 * A union of all supported MCP connection parameter types.
 */
export type MCPConnectionParams =
    StdioConnectionParams|StreamableHTTPConnectionParams;

/**
 * Manages Model Context Protocol (MCP) client sessions.
 *
 * This class is responsible for establishing and managing connections to MCP
 * servers. It supports different transport protocols like Standard I/O (Stdio)
 * and Server-Sent Events (SSE) over HTTP, determined by the provided
 * connection parameters.
 *
 * The primary purpose of this manager is to abstract away the details of
 * session creation and connection handling, providing a simple interface for
 * creating new MCP client instances that can be used to interact with
 * remote tools.
 */
export class MCPSessionManager {
  private readonly connectionParams: MCPConnectionParams;

  constructor(connectionParams: MCPConnectionParams) {
    this.connectionParams = connectionParams;
  }

  async createSession(): Promise<Client> {
    const client = new Client({name: 'MCPClient', version: '1.0.0'});

    switch (this.connectionParams.type) {
      case 'StdioConnectionParams':
        await client.connect(
            new StdioClientTransport(this.connectionParams.serverParams));
        break;
      case 'StreamableHTTPConnectionParams':
        await client.connect(new StreamableHTTPClientTransport(
            new URL(this.connectionParams.url)));
        break;
      default:
        // Triggers compile error if a case is missing.
        const _exhaustiveCheck: never = this.connectionParams;
        break;
    }

    return client;
  }
}
