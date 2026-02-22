/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Defines the parameters for establishing a connection to an MCP server using
 * standard input/output (stdio). This is typically used for running MCP servers
 * as local child processes.
 */
export interface StdioConnectionParams {
  type: 'StdioConnectionParams';
  serverParams: StdioServerParameters;
  timeout?: number;
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
  /**
   * @deprecated
   * Use transportOptions.requestInit.headers instead.
   * This field will be ignored if transportOptions is provided even if no headers are specified in transportOptions.
   */
  header?: Record<string, unknown>;
  timeout?: number;
  sseReadTimeout?: number;
  terminateOnClose?: boolean;
  transportOptions?: StreamableHTTPClientTransportOptions;
}

/**
 * A union of all supported MCP connection parameter types.
 */
export type MCPConnectionParams =
  | StdioConnectionParams
  | StreamableHTTPConnectionParams;

/**
 * Manages Model Context Protocol (MCP) client sessions.
 *
 * This class is responsible for establishing and managing connections to MCP
 * servers. It supports different transport protocols like Standard I/O (Stdio)
 * and Server-Sent Events (SSE) over HTTP, determined by the provided
 * connection parameters.
 *
 * Sessions are cached and reused across calls. A new session is only created
 * when no cached session exists (first call or after {@link close}). This
 * follows the MCP spec pattern where clients connect once and only re-list
 * tools on `notifications/tools/list_changed`.
 *
 * Concurrent {@link createSession} calls are coalesced — only one connection
 * attempt runs at a time; additional callers await the same result. If the
 * underlying transport disconnects, the cached state is cleared reactively
 * via the MCP SDK's `onclose` callback so the next call reconnects.
 */
export class MCPSessionManager {
  private readonly connectionParams: MCPConnectionParams;
  private cachedClient?: Client;
  private cachedInstructions?: string;
  private sessionPromise?: Promise<Client>;

  constructor(connectionParams: MCPConnectionParams) {
    this.connectionParams = connectionParams;
  }

  /**
   * Returns a cached MCP client session, creating one if needed.
   *
   * Concurrent callers are coalesced onto a single in-flight connection
   * attempt. If the attempt fails, subsequent calls will retry.
   */
  async createSession(): Promise<Client> {
    if (this.cachedClient) {
      return this.cachedClient;
    }

    if (!this.sessionPromise) {
      this.sessionPromise = this.doConnect();
    }

    return this.sessionPromise;
  }

  /**
   * Returns the MCP server instructions received during initialization.
   * Available after the first {@link createSession} call.
   */
  getInstructions(): string | undefined {
    return this.cachedInstructions;
  }

  /**
   * Closes the cached session and clears all cached state. The next
   * {@link createSession} call will establish a fresh connection.
   */
  async close(): Promise<void> {
    this.sessionPromise = undefined;

    if (this.cachedClient) {
      const client = this.cachedClient;
      this.cachedClient = undefined;
      this.cachedInstructions = undefined;
      try {
        await client.close();
      } catch {
        // Swallow close errors to avoid blocking cleanup.
      }
    }
  }

  private async doConnect(): Promise<Client> {
    try {
      const client = new Client({name: 'MCPClient', version: '1.0.0'});

      switch (this.connectionParams.type) {
        case 'StdioConnectionParams':
          await client.connect(
            new StdioClientTransport(this.connectionParams.serverParams),
          );
          break;
        case 'StreamableHTTPConnectionParams': {
          const options = this.connectionParams.transportOptions ?? {};

          if (
            !options.requestInit &&
            this.connectionParams.header !== undefined
          ) {
            options.requestInit = {
              headers: this.connectionParams.header as Record<string, string>,
            };
          }

          await client.connect(
            new StreamableHTTPClientTransport(
              new URL(this.connectionParams.url),
              options,
            ),
          );
          break;
        }
        default: {
          const _exhaustiveCheck: never = this.connectionParams;
          break;
        }
      }

      client.onclose = () => {
        if (this.cachedClient === client) {
          this.cachedClient = undefined;
          this.cachedInstructions = undefined;
        }
      };

      this.cachedInstructions = client.getInstructions();
      this.cachedClient = client;
      return client;
    } finally {
      this.sessionPromise = undefined;
    }
  }
}
