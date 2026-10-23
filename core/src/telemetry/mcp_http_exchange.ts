/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The experimental log record of one HTTP exchange with an MCP server.
 *
 * OTel's MCP conventions define attributes but no event for the transport
 * hop, so the event name is ADK's own and lives in the `adk.experimental.*`
 * namespace. The attributes on it are the semantic-convention ones.
 */

import type {AttributeValue, Context} from '@opentelemetry/api';
import {SeverityNumber, type LogAttributes} from '@opentelemetry/api-logs';

import {logger} from '../utils/logger.js';

import {readEnvVar} from './env.js';
import {otelLogger, USER_CONTENT_ELIDED} from './tracing.js';

/** Event name of the MCP HTTP exchange record. */
export const MCP_HTTP_RESPONSE_END_EVENT =
  'adk.experimental.mcp.http.client.response.end';

/** Attribute and body keys of the MCP HTTP exchange record. */
enum McpHttpAttr {
  HTTP_REQUEST_METHOD = 'http.request.method',
  URL_FULL = 'url.full',
  HTTP_RESPONSE_STATUS_CODE = 'http.response.status_code',
  SERVER_ADDRESS = 'server.address',
  SERVER_PORT = 'server.port',
  MCP_SESSION_ID = 'mcp.session.id',
  MCP_PROTOCOL_VERSION = 'mcp.protocol.version',
  ERROR_TYPE = 'error.type',
  HTTP_REQUEST_BODY_CONTENT = 'http.request.body.content',
  HTTP_RESPONSE_BODY_CONTENT = 'http.response.body.content',
}

const HTTP_REQUEST_HEADER_PREFIX = 'http.request.header.';
const HTTP_RESPONSE_HEADER_PREFIX = 'http.response.header.';

/**
 * Opt-in for the bodies on the record. Deliberately not the GenAI content
 * knob: agreeing to record prompt content is not the same decision as
 * agreeing to export raw HTTP payloads.
 */
const ADK_CAPTURE_MCP_HTTP_BODIES = 'ADK_CAPTURE_MCP_HTTP_BODIES';

/**
 * Which headers to record: comma-separated names or regular expressions,
 * matched case-insensitively against the whole header name. Nothing is
 * recorded that these do not name.
 */
const CAPTURE_HEADERS_CLIENT_REQUEST =
  'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_REQUEST';
const CAPTURE_HEADERS_CLIENT_RESPONSE =
  'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_RESPONSE';

/** One HTTP request and response pair with an MCP server. */
export interface McpHttpExchange {
  /** HTTP method of the request. */
  readonly method: string;
  /** Request URL, already sanitized. */
  readonly url: string;
  /** Host the request was sent to, if known. */
  readonly serverAddress?: string;
  /** Port the request was sent to, if explicit in the URL. */
  readonly serverPort?: number;
  /** HTTP status code of the response. */
  readonly statusCode: number;
  /** MCP session the exchange belongs to, if known. */
  readonly mcpSessionId?: string;
  /** MCP protocol version the exchange ran under, if known. */
  readonly mcpProtocolVersion?: string;
  /** Request headers, lowercased and already redacted. */
  readonly requestHeaders: Readonly<Record<string, string>>;
  /** Request body, already truncated, or null if unread. */
  readonly requestBody: string | null;
  /** Response headers, lowercased and already redacted. */
  readonly responseHeaders: Readonly<Record<string, string>>;
  /**
   * Response body, already truncated, `<SSE stream>` for a body that must not
   * be read, or null if unread.
   */
  readonly responseBody: string | null;
  /** The context the request was made in; the record is parented to it. */
  readonly context: Context;
}

/** Returns whether MCP HTTP bodies may be recorded. Off unless asked for. */
export function shouldCaptureMcpHttpBodies(): boolean {
  const value = readEnvVar(ADK_CAPTURE_MCP_HTTP_BODIES)?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/** Compiles the header allowlist `envVar` holds, one pattern per entry. */
function headerPatterns(envVar: string): RegExp[] {
  const patterns: RegExp[] = [];
  for (const rawEntry of (readEnvVar(envVar) ?? '').split(',')) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }
    try {
      patterns.push(new RegExp(`^(?:${entry})$`, 'i'));
    } catch {
      logger.warn(`Ignoring malformed header pattern '${entry}' in ${envVar}.`);
    }
  }
  return patterns;
}

/**
 * Returns the allowlisted headers in the semantic-convention
 * `http.*.header.<key>` shape, one string array per header.
 */
function capturedHeaders(
  headers: Readonly<Record<string, string>>,
  prefix: string,
  envVar: string,
): Record<string, AttributeValue> {
  const allowlist = headerPatterns(envVar);
  const captured: Record<string, AttributeValue> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowered = name.toLowerCase();
    if (allowlist.some((pattern) => pattern.test(lowered))) {
      captured[prefix + lowered] = [value];
    }
  }
  return captured;
}

/**
 * Emits one DEBUG log record for an MCP server HTTP request and response.
 *
 * Callers own the opt-in check, redaction and truncation. The bodies appear
 * only when `ADK_CAPTURE_MCP_HTTP_BODIES` asks for them, because MCP payloads
 * routinely carry user data.
 */
export function traceMcpHttpExchange(exchange: McpHttpExchange): void {
  const attributes: LogAttributes = {
    [McpHttpAttr.HTTP_REQUEST_METHOD]: exchange.method,
    [McpHttpAttr.URL_FULL]: exchange.url,
    [McpHttpAttr.HTTP_RESPONSE_STATUS_CODE]: exchange.statusCode,
  };
  if (exchange.serverAddress) {
    attributes[McpHttpAttr.SERVER_ADDRESS] = exchange.serverAddress;
  }
  if (exchange.serverPort) {
    attributes[McpHttpAttr.SERVER_PORT] = exchange.serverPort;
  }
  if (exchange.mcpSessionId) {
    attributes[McpHttpAttr.MCP_SESSION_ID] = exchange.mcpSessionId;
  }
  if (exchange.mcpProtocolVersion) {
    attributes[McpHttpAttr.MCP_PROTOCOL_VERSION] = exchange.mcpProtocolVersion;
  }
  // HTTP semantic conventions record `error.type` as the status code string.
  if (exchange.statusCode >= 400) {
    attributes[McpHttpAttr.ERROR_TYPE] = String(exchange.statusCode);
  }
  Object.assign(
    attributes,
    capturedHeaders(
      exchange.requestHeaders,
      HTTP_REQUEST_HEADER_PREFIX,
      CAPTURE_HEADERS_CLIENT_REQUEST,
    ),
    capturedHeaders(
      exchange.responseHeaders,
      HTTP_RESPONSE_HEADER_PREFIX,
      CAPTURE_HEADERS_CLIENT_RESPONSE,
    ),
  );

  const captureBodies = shouldCaptureMcpHttpBodies();
  otelLogger.emit({
    eventName: MCP_HTTP_RESPONSE_END_EVENT,
    severityNumber: SeverityNumber.DEBUG,
    body: {
      [McpHttpAttr.HTTP_REQUEST_BODY_CONTENT]: captureBodies
        ? exchange.requestBody
        : USER_CONTENT_ELIDED,
      [McpHttpAttr.HTTP_RESPONSE_BODY_CONTENT]: captureBodies
        ? exchange.responseBody
        : USER_CONTENT_ELIDED,
    },
    attributes,
    context: exchange.context,
  });
}
