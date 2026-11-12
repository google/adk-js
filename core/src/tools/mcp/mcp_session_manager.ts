/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {SSEClientTransportOptions} from '@modelcontextprotocol/sdk/client/sse.js';
import type {StdioServerParameters} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {StreamableHTTPClientTransportOptions} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {instrumentMcpFetch} from '../../telemetry/api/instrumentation.js';
import {mergeTrackingHeaders} from '../../utils/client_labels.js';
import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer, OptionalPeer} from '../../utils/optional_peer.js';

/**
 * The optional peer backing every MCP connection.
 *
 * `@modelcontextprotocol/sdk` is the single largest transitive dependency
 * ADK ever pulled in, and it is only reachable through the MCP tools, so it
 * is loaded lazily from {@link MCPSessionManager.createSession}.
 */
const MCP_SDK: OptionalPeer = {
  packageName: '@modelcontextprotocol/sdk',
  feature: 'MCPSessionManager (and the MCP tools built on it)',
};

/** Surfaces a background transport error that would otherwise be dropped. */
function logTransportError(err: unknown): void {
  logger.error('MCP transport error: ' + formatError(err));
}

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
 * Defines the parameters for establishing a connection to an MCP server over
 * the HTTP+SSE transport.
 *
 * Usage:
 *  const connectionParams: SseConnectionParams = {
 *    type: 'SseConnectionParams',
 *    url: 'http://localhost:8090/sse'
 *  };
 */
export interface SseConnectionParams {
  type: 'SseConnectionParams';
  url: string;
  /**
   * @deprecated
   * Use transportOptions.requestInit.headers instead.
   * This field will be ignored if transportOptions is provided even if no headers are specified in transportOptions.
   */
  header?: Record<string, unknown>;
  /**
   * HTTP headers to send with the SSE and POST requests when
   * `transportOptions.requestInit` is not provided.
   */
  headers?: Record<string, unknown>;
  timeout?: number;
  sseReadTimeout?: number;
  transportOptions?: SSEClientTransportOptions;
}

/**
 * Alias for {@link SseConnectionParams}.
 */
export type SseServerParams = SseConnectionParams;

/**
 * A union of all supported MCP connection parameter types.
 */
export type MCPConnectionParams =
  StdioConnectionParams | SseConnectionParams | StreamableHTTPConnectionParams;

/**
 * Builds the options for a streamable HTTP transport, with the ADK tracking
 * headers merged into `requestInit.headers`.
 *
 * The deprecated `header` field is used only when
 * `transportOptions.requestInit` is undefined. The result is a new object, so
 * the caller's `transportOptions` is never modified.
 */
function buildTransportOptions(
  params: StreamableHTTPConnectionParams,
): StreamableHTTPClientTransportOptions {
  const {transportOptions, header} = params;
  const callerHeaders =
    transportOptions?.requestInit === undefined
      ? (header as Record<string, string> | undefined)
      : transportOptions.requestInit.headers;
  return {
    ...transportOptions,
    requestInit: {
      ...transportOptions?.requestInit,
      headers: mergeTrackingHeaders(callerHeaders),
    },
    fetch: instrumentMcpFetch(transportOptions?.fetch),
  };
}

/**
 * Builds the options for an SSE transport, with the ADK tracking headers
 * merged into `requestInit.headers`.
 */
function buildSseTransportOptions(
  params: SseConnectionParams,
): SSEClientTransportOptions {
  const {transportOptions, header, headers} = params;
  const callerHeaders =
    transportOptions?.requestInit === undefined
      ? ((header ?? headers) as Record<string, string> | undefined)
      : transportOptions.requestInit.headers;
  return {
    ...transportOptions,
    requestInit: {
      ...transportOptions?.requestInit,
      headers: mergeTrackingHeaders(callerHeaders),
    },
    fetch: instrumentMcpFetch(transportOptions?.fetch),
  };
}

const CONNECTION_CLOSED_ERROR_CODE = -32000;
const INVALID_REQUEST_ERROR_CODE = -32600;
const LEGACY_SESSION_TERMINATED_ERROR_CODE = 32600;
const HTTP_NOT_FOUND_STATUS = 404;

/**
 * Returns whether an MCP call error indicates that the server rejected the
 * request because the session was already terminated or expired (such as HTTP
 * 404 on Streamable HTTP or JSON-RPC session-terminated codes), meaning the
 * operation can be safely retried once on a fresh session.
 *
 * @internal
 */
export function isSessionTerminatedError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const code = (err as {code?: unknown}).code;
  const message = (err as {message?: unknown}).message;
  if (
    code === HTTP_NOT_FOUND_STATUS ||
    code === LEGACY_SESSION_TERMINATED_ERROR_CODE
  ) {
    return true;
  }
  return (
    code === INVALID_REQUEST_ERROR_CODE &&
    typeof message === 'string' &&
    message.includes('Session terminated')
  );
}

/**
 * Returns whether an MCP call error indicates that the underlying transport
 * disconnected or that a Streamable HTTP server no longer recognizes the
 * session ID, meaning the cached client should be discarded so the next call
 * reconnects cleanly.
 *
 * @internal
 */
export function isDisconnectedSessionError(err: unknown): boolean {
  if (isSessionTerminatedError(err)) {
    return true;
  }
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const code = (err as {code?: unknown}).code;
  const message = (err as {message?: unknown}).message;
  return code === CONNECTION_CLOSED_ERROR_CODE || message === 'Not connected';
}

/**
 * Manages Model Context Protocol (MCP) client sessions.
 *
 * This class establishes and manages connections to MCP servers across stdio,
 * Streamable HTTP, and HTTP+SSE transports. Call {@link getSession} to reuse a
 * single shared session across tool discovery, resource reads, and tool calls
 * until {@link close} shuts it down, or {@link createSession} when an isolated
 * client instance is explicitly needed.
 */
export class MCPSessionManager {
  private readonly connectionParams: MCPConnectionParams;
  private readonly activeSessions = new Set<Client>();
  private readonly sessionRefCounts = new Map<Client, number>();
  private readonly closingSessions = new Set<Client>();
  private sharedSession?: Client;
  private pendingSession?: Promise<Client>;
  private closeGeneration = 0;

  constructor(connectionParams: MCPConnectionParams) {
    this.connectionParams = connectionParams;
  }

  /**
   * Returns a shared MCP client session, connecting lazily on first use,
   * de-duplicating concurrent connection attempts, and reconnecting if the
   * previous session closed.
   */
  async getSession(): Promise<Client> {
    if (this.sharedSession && this.activeSessions.has(this.sharedSession)) {
      return this.sharedSession;
    }
    this.sharedSession = undefined;

    if (this.pendingSession) {
      return this.pendingSession;
    }

    const generation = this.closeGeneration;
    const connectPromise: Promise<Client> = this.createSession()
      .then(async (client) => {
        if (this.closeGeneration !== generation) {
          await this.closeSession(client).catch((err) => {
            logger.warn(
              'Failed to close canceled MCP session: ' + formatError(err),
            );
          });
          throw new Error('MCP session manager was closed while connecting.');
        }
        this.sharedSession = client;
        return client;
      })
      .finally(() => {
        if (this.pendingSession === connectPromise) {
          this.pendingSession = undefined;
        }
      });

    this.pendingSession = connectPromise;
    return connectPromise;
  }

  /**
   * Marks an active session as currently in use by an operation so {@link close}
   * defers closing it until all in-flight operations on it finish.
   *
   * @internal
   */
  retainSession(client: Client): void {
    if (!this.activeSessions.has(client)) {
      return;
    }
    this.sessionRefCounts.set(
      client,
      (this.sessionRefCounts.get(client) ?? 0) + 1,
    );
  }

  /**
   * Releases a session previously retained with {@link retainSession}, closing
   * it if {@link close} was called while the session was in use.
   *
   * @internal
   */
  async releaseSession(client: Client): Promise<void> {
    const count = this.sessionRefCounts.get(client) ?? 0;
    if (count <= 1) {
      this.sessionRefCounts.delete(client);
      if (this.closingSessions.delete(client)) {
        await this.closeSession(client).catch((err) => {
          logger.warn(
            'Failed to close deferred MCP session: ' + formatError(err),
          );
        });
      }
      return;
    }
    this.sessionRefCounts.set(client, count - 1);
  }

  async createSession(): Promise<Client> {
    const {Client} = await loadOptionalPeer(
      MCP_SDK,
      () => import('@modelcontextprotocol/sdk/client/index.js'),
    );
    const client = new Client({name: 'MCPClient', version: '1.0.0'});
    const onDisconnect = () => {
      this.activeSessions.delete(client);
      this.sessionRefCounts.delete(client);
      this.closingSessions.delete(client);
      if (this.sharedSession === client) {
        this.sharedSession = undefined;
      }
    };
    client.onclose = onDisconnect;

    try {
      switch (this.connectionParams.type) {
        case 'StdioConnectionParams': {
          const {StdioClientTransport} = await loadOptionalPeer(
            MCP_SDK,
            () => import('@modelcontextprotocol/sdk/client/stdio.js'),
          );
          const transport = new StdioClientTransport(
            this.connectionParams.serverParams,
          );
          transport.onerror = logTransportError;
          await client.connect(transport);
          break;
        }
        case 'StreamableHTTPConnectionParams': {
          const {StreamableHTTPClientTransport} = await loadOptionalPeer(
            MCP_SDK,
            () => import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
          );
          const transport = new StreamableHTTPClientTransport(
            new URL(this.connectionParams.url),
            buildTransportOptions(this.connectionParams),
          );
          transport.onerror = logTransportError;
          await client.connect(transport);
          break;
        }
        case 'SseConnectionParams': {
          const {SSEClientTransport} = await loadOptionalPeer(
            MCP_SDK,
            () => import('@modelcontextprotocol/sdk/client/sse.js'),
          );
          const transport = new SSEClientTransport(
            new URL(this.connectionParams.url),
            buildSseTransportOptions(this.connectionParams),
          );
          transport.onerror = logTransportError;
          await client.connect(transport);
          break;
        }
        default: {
          // Triggers compile error if a case is missing.
          const _exhaustiveCheck: never = this.connectionParams;
          break;
        }
      }
    } catch (err) {
      throw new Error('Failed to create MCP session: ' + formatError(err), {
        cause: err,
      });
    }

    this.activeSessions.add(client);
    return client;
  }

  async closeSession(client: Client): Promise<void> {
    const wasActive = this.activeSessions.delete(client);
    this.sessionRefCounts.delete(client);
    this.closingSessions.delete(client);
    if (this.sharedSession === client) {
      this.sharedSession = undefined;
    }
    if (wasActive) {
      await client.close();
    }
  }

  /**
   * Closes all idle active and in-flight MCP sessions managed by this instance,
   * and defers closing any session currently held by an in-flight operation
   * until that operation releases it.
   */
  async close(): Promise<void> {
    this.closeGeneration++;
    this.sharedSession = undefined;
    const inFlight = this.pendingSession;
    this.pendingSession = undefined;
    const idleSessions: Client[] = [];
    for (const session of this.activeSessions) {
      if ((this.sessionRefCounts.get(session) ?? 0) > 0) {
        this.closingSessions.add(session);
      } else {
        idleSessions.push(session);
      }
    }
    await Promise.allSettled([
      ...idleSessions.map((session) => this.closeSession(session)),
      ...(inFlight ? [inFlight] : []),
    ]);
  }

  getActiveSessions(): Client[] {
    return Array.from(this.activeSessions);
  }
}
