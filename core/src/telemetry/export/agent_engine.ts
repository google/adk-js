/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  context,
  createContextKey,
  trace,
  type SpanContext,
} from '@opentelemetry/api';

/** Header carrying the W3C traceparent of the Agent Engine request span. */
const AGENT_ENGINE_TRACEPARENT_HEADER = 'google-agent-engine-traceparent';

/** Header whose value is recorded as the support id. */
const TRACEPARENT_HEADER = 'traceparent';

/** Longest `traceparent` value recorded as the support id. */
const MAX_SUPPORT_ID_LENGTH = 256;

/**
 * Context key holding the support id. The invocation scope reads it by the
 * same name; `createContextKey` uses `Symbol.for`, so both resolve to one key.
 */
const SUPPORT_ID_KEY = createContextKey('google.adk.agent_engine.support_id');

const TRACEPARENT_PATTERN =
  /^\s?([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?\s?$/;

/**
 * Parses a W3C traceparent into a remote span context, with the same rules as
 * the W3C trace context propagator. Returns undefined for an invalid value.
 */
function parseTraceparent(value: string): SpanContext | undefined {
  const match = TRACEPARENT_PATTERN.exec(value);
  if (!match) {
    return undefined;
  }
  const [, version, traceId, spanId, flags, rest] = match;
  if (version === 'ff' || (version === '00' && rest)) {
    return undefined;
  }
  const spanContext: SpanContext = {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
    isRemote: true,
  };
  return trace.isSpanContextValid(spanContext) ? spanContext : undefined;
}

/**
 * Returns the first value of a header, matching its name case-insensitively.
 */
function getHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/**
 * Runs `fn` in a context that continues an Agent Engine request trace.
 *
 * When `Google-Agent-Engine-Traceparent` holds a valid W3C traceparent and no
 * span is active, the Agent Engine span becomes the remote parent of the
 * spans `fn` starts. An invalid value is ignored. The `traceparent` header is
 * recorded as the `supportID` attribute of the invocation's top span.
 *
 * Without either header, `fn` runs in the active context unchanged.
 *
 * @experimental (Experimental, subject to change)
 *
 * @param headers The incoming request headers, such as Node's
 *     `IncomingMessage.headers`.
 * @param fn The request handler to run.
 * @returns What `fn` returns.
 */
export function runWithAgentEngineContext<T>(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  fn: () => T,
): T {
  let ctx = context.active();
  const agentEngineTraceparent = getHeader(
    headers,
    AGENT_ENGINE_TRACEPARENT_HEADER,
  );
  const remoteParent =
    agentEngineTraceparent === undefined
      ? undefined
      : parseTraceparent(agentEngineTraceparent);
  if (remoteParent && !trace.getSpan(ctx)) {
    ctx = trace.setSpanContext(ctx, remoteParent);
  }
  const supportId = getHeader(headers, TRACEPARENT_HEADER)?.trim();
  if (supportId && supportId.length <= MAX_SUPPORT_ID_LENGTH) {
    ctx = ctx.setValue(SUPPORT_ID_KEY, supportId);
  }
  return context.with(ctx, fn);
}
