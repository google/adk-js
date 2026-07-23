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

import {logger} from '../../utils/logger.js';

/**
 * Maximum number of characters of an HTTP response body surfaced by
 * {@link formatError} before it is truncated. Bounds both log volume and the
 * exposure of potentially sensitive response payloads.
 */
const MAX_RESPONSE_BODY_LENGTH = 1000;

/** Marker appended to a response body that exceeds {@link MAX_RESPONSE_BODY_LENGTH}. */
const TRUNCATION_MARKER = '... [truncated]';

/** Returned by {@link formatError} when the input carries no usable message. */
const UNKNOWN_ERROR = 'Unknown error';

/** Lowest and highest values treated as an HTTP status code. */
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;

/**
 * Narrows an arbitrary value to an indexable record, or `undefined` when it is
 * not a non-null object. Used to safely inspect duck-typed error shapes without
 * resorting to `any`.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Returns the first argument that is a string, or `undefined` if none are. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

/** Truncates a response body to {@link MAX_RESPONSE_BODY_LENGTH} characters. */
function truncateBody(body: string): string {
  return body.length > MAX_RESPONSE_BODY_LENGTH
    ? body.slice(0, MAX_RESPONSE_BODY_LENGTH) + TRUNCATION_MARKER
    : body;
}

/** Returns the plain, non-recursive message for a single value. */
function baseMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  return String(err);
}

/**
 * Extracts synchronously-available HTTP details (status, status text and a
 * truncated response body) from a duck-typed error, or `undefined` when none
 * are present. Handles the MCP SDK `StreamableHTTPError` (status on `.code`),
 * axios/httpx-style errors (`.response`), and errors carrying `.status`
 * directly. A body is only read when it is already a string, so no async
 * `Response.text()` is ever invoked.
 */
function extractHttpDetails(err: unknown): string | undefined {
  const record = asRecord(err);
  if (record === undefined) {
    return undefined;
  }
  const response = asRecord(record['response']);
  const rawStatus = record['status'] ?? record['code'] ?? response?.['status'];
  const status =
    typeof rawStatus === 'number' &&
    rawStatus >= MIN_HTTP_STATUS &&
    rawStatus <= MAX_HTTP_STATUS
      ? rawStatus
      : undefined;
  const statusText = firstString(
    record['statusText'],
    response?.['statusText'],
  );
  const body = firstString(
    response?.['data'],
    response?.['body'],
    response?.['text'],
  );
  if (status === undefined && body === undefined) {
    return undefined;
  }
  const head =
    status === undefined
      ? 'HTTP error'
      : `HTTP ${status}${statusText === undefined ? '' : ` ${statusText}`}`;
  return body === undefined ? head : `${head}: ${truncateBody(body)}`;
}

/**
 * Recursively flattens aggregate and wrapped errors into a single message.
 * `seen` guards against cyclic `cause`/`errors` graphs.
 */
function formatErrorRecursive(err: unknown, seen: Set<unknown>): string {
  if (err === null || err === undefined) {
    return UNKNOWN_ERROR;
  }
  if (typeof err === 'object') {
    if (seen.has(err)) {
      return baseMessage(err);
    }
    seen.add(err);
  }
  if (err instanceof AggregateError && err.errors.length > 0) {
    return err.errors.map((sub) => formatErrorRecursive(sub, seen)).join(' | ');
  }
  const http = extractHttpDetails(err);
  const base = baseMessage(err);
  const cause = asRecord(err)?.['cause'];
  const causeMessage =
    cause !== undefined && cause !== err
      ? formatErrorRecursive(cause, seen)
      : undefined;
  let message = base.length > 0 ? base : UNKNOWN_ERROR;
  if (http !== undefined) {
    message = `${message} (${http})`;
  }
  if (
    causeMessage !== undefined &&
    http === undefined &&
    !message.includes(causeMessage)
  ) {
    message = `${message}: ${causeMessage}`;
  }
  return message;
}

/**
 * Formats an arbitrary thrown value into a readable, root-cause message.
 *
 * Recursively flattens `AggregateError.errors` (joining leaves with ` | `) and
 * unwraps the `Error.cause` chain, and — when HTTP details are synchronously
 * available — appends the status code and a response-body snippet truncated to
 * 1000 characters with a `... [truncated]` marker. It never throws and is safe
 * on `null`/`undefined` and cyclic error graphs.
 *
 * @param err The thrown or rejected value to format.
 * @return A single human-readable message describing the root cause(s).
 */
export function formatError(err: unknown): string {
  return formatErrorRecursive(err, new Set<unknown>());
}

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
 * The primary purpose of this manager is to abstract away the details of
 * session creation and connection handling, providing a simple interface for
 * creating new MCP client instances that can be used to interact with
 * remote tools.
 */
export class MCPSessionManager {
  private readonly connectionParams: MCPConnectionParams;
  private readonly activeSessions = new Set<Client>();

  constructor(connectionParams: MCPConnectionParams) {
    this.connectionParams = connectionParams;
  }

  async createSession(): Promise<Client> {
    const client = new Client({name: 'MCPClient', version: '1.0.0'});

    try {
      switch (this.connectionParams.type) {
        case 'StdioConnectionParams': {
          const transport = new StdioClientTransport(
            this.connectionParams.serverParams,
          );
          transport.onerror = logTransportError;
          await client.connect(transport);
          break;
        }
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

          const transport = new StreamableHTTPClientTransport(
            new URL(this.connectionParams.url),
            options,
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
    if (this.activeSessions.has(client)) {
      this.activeSessions.delete(client);
      await client.close();
    }
  }

  getActiveSessions(): Client[] {
    return Array.from(this.activeSessions);
  }
}
