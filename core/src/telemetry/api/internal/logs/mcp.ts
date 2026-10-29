/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Attributes, Context} from '@opentelemetry/api';
import {type AnyValueMap, SeverityNumber} from '@opentelemetry/api-logs';

import {logger} from '../../../../utils/logger.js';
import {ERROR_TYPE_ATTR, HttpAttr, McpAttr} from '../common/attributes.js';
import {isTruthyEnv, readEnv} from '../common/config.js';
import {captureHttpExchange} from '../common/http_exchange.js';
import {getTelemetryLogger} from './logger.js';

/** Event name of the log record that reports one MCP HTTP exchange. */
const MCP_HTTP_RESPONSE_END_EVENT =
  'adk.experimental.mcp.http.client.response.end';

/**
 * Opts in to recording MCP HTTP payloads. Separate from the GenAI content
 * setting: recording prompts is not the same decision as recording raw HTTP
 * payloads.
 */
const CAPTURE_BODIES_ENV = 'ADK_CAPTURE_MCP_HTTP_BODIES';

/**
 * The headers to record, as comma-separated regular expressions matched
 * against the whole header name. No header is recorded that these do not
 * name, because any header can carry a credential.
 */
const CAPTURE_REQUEST_HEADERS_ENV =
  'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_REQUEST';
const CAPTURE_RESPONSE_HEADERS_ENV =
  'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_RESPONSE';

/** The body value recorded when bodies are not captured. */
const ELIDED_BODY = '<elided>';

/** What to record about MCP HTTP exchanges, read from the environment. */
export interface McpHttpExchangeSettings {
  readonly captureBodies: boolean;
  readonly requestHeaderPatterns: readonly RegExp[];
  readonly responseHeaderPatterns: readonly RegExp[];
}

/** Compiles the header allowlist in `envName`, skipping malformed entries. */
function readHeaderPatterns(envName: string): RegExp[] {
  const patterns: RegExp[] = [];
  for (const entry of (readEnv(envName) ?? '').split(',')) {
    const pattern = entry.trim();
    if (!pattern) {
      continue;
    }
    try {
      patterns.push(new RegExp(`^(?:${pattern})$`, 'i'));
    } catch {
      logger.warn(`Ignoring malformed header pattern in ${envName}.`);
    }
  }
  return patterns;
}

/** Reads the MCP HTTP exchange settings from the environment. */
export function readMcpHttpExchangeSettings(): McpHttpExchangeSettings {
  return {
    captureBodies: isTruthyEnv(CAPTURE_BODIES_ENV),
    requestHeaderPatterns: readHeaderPatterns(CAPTURE_REQUEST_HEADERS_ENV),
    responseHeaderPatterns: readHeaderPatterns(CAPTURE_RESPONSE_HEADERS_ENV),
  };
}

/** The allowlisted headers, as `<prefix><lowercased name>` attributes. */
function headerAttributes(
  headers: ReadonlyMap<string, string>,
  patterns: readonly RegExp[],
  prefix: HttpAttr,
): Attributes {
  const attributes: Attributes = {};
  for (const [name, value] of headers) {
    if (patterns.some((pattern) => pattern.test(name))) {
      attributes[`${prefix}${name}`] = [value];
    }
  }
  return attributes;
}

/** Parameters for {@link reportMcpHttpExchange}. */
export interface ReportMcpHttpExchangeParams {
  readonly url: string | URL;
  readonly init?: Parameters<typeof fetch>[1];
  readonly response: Response;
  readonly settings: McpHttpExchangeSettings;
  /** The context the request was sent in, which parents the record. */
  readonly context: Context;
}

/**
 * Emits the `adk.experimental.mcp.http.client.response.end` record of one MCP
 * HTTP exchange.
 *
 * Takes what it needs from `response` before its first await, so the caller
 * can hand the response on at once and leave the returned promise running.
 */
export async function reportMcpHttpExchange({
  url,
  init,
  response,
  settings,
  context,
}: ReportMcpHttpExchangeParams): Promise<void> {
  const exchange = await captureHttpExchange({
    url,
    init,
    response,
    captureBodies: settings.captureBodies,
  });
  const sessionId =
    exchange.querySessionId ||
    exchange.responseHeaders.get('mcp-session-id') ||
    exchange.requestHeaders.get('mcp-session-id');
  const protocolVersion =
    exchange.responseHeaders.get('mcp-protocol-version') ||
    exchange.requestHeaders.get('mcp-protocol-version');
  const attributes: Attributes = {
    [HttpAttr.REQUEST_METHOD]: exchange.method,
    [HttpAttr.URL_FULL]: exchange.url,
    [HttpAttr.RESPONSE_STATUS_CODE]: exchange.statusCode,
    ...(exchange.serverAddress
      ? {[HttpAttr.SERVER_ADDRESS]: exchange.serverAddress}
      : {}),
    ...(exchange.serverPort === undefined
      ? {}
      : {[HttpAttr.SERVER_PORT]: exchange.serverPort}),
    ...(sessionId ? {[McpAttr.SESSION_ID]: sessionId} : {}),
    ...(protocolVersion ? {[McpAttr.PROTOCOL_VERSION]: protocolVersion} : {}),
    // HTTP semantic conventions name a failed response by its status code.
    ...(exchange.statusCode >= 400
      ? {[ERROR_TYPE_ATTR]: String(exchange.statusCode)}
      : {}),
    ...headerAttributes(
      exchange.requestHeaders,
      settings.requestHeaderPatterns,
      HttpAttr.REQUEST_HEADER_PREFIX,
    ),
    ...headerAttributes(
      exchange.responseHeaders,
      settings.responseHeaderPatterns,
      HttpAttr.RESPONSE_HEADER_PREFIX,
    ),
  };
  const body: AnyValueMap = settings.captureBodies
    ? {
        ...(exchange.requestBody === undefined
          ? {}
          : {[HttpAttr.REQUEST_BODY_CONTENT]: exchange.requestBody}),
        ...(exchange.responseBody === undefined
          ? {}
          : {[HttpAttr.RESPONSE_BODY_CONTENT]: exchange.responseBody}),
      }
    : {
        [HttpAttr.REQUEST_BODY_CONTENT]: ELIDED_BODY,
        [HttpAttr.RESPONSE_BODY_CONTENT]: ELIDED_BODY,
      };
  getTelemetryLogger().emit({
    eventName: MCP_HTTP_RESPONSE_END_EVENT,
    severityNumber: SeverityNumber.DEBUG,
    severityText: 'DEBUG',
    body,
    attributes,
    context,
  });
}
