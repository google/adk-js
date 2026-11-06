/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  RequestContext,
  ServerCallContext,
} from '@a2a-js/sdk/server';

/** Type for HTTP request headers map. */
export type HttpHeadersRecord = Record<string, string | string[] | undefined>;

interface RequestContextWithRequest extends RequestContext {
  request?: {
    metadata?: Record<string, unknown>;
    headers?: HttpHeadersRecord;
  };
}

/**
 * Request-scoped metadata store for A2A request metadata propagation.
 * Bridges SDK versions (such as 0.3.x) where DefaultRequestHandler does not attach
 * params.metadata to RequestContext, while SDK >= 1.0.0 provides ctx.request.metadata natively.
 */
const requestMetadataStore = new Map<string, Record<string, unknown>>();

/**
 * In-flight request headers store keyed by message ID.
 */
const requestHeadersStore = new Map<string, HttpHeadersRecord>();

/**
 * Stores incoming request headers keyed by message ID.
 *
 * @param messageId - The A2A message ID.
 * @param headers - The incoming request headers.
 */
export function setA2aRequestHeaders(
  messageId: string,
  headers: HttpHeadersRecord,
): void {
  requestHeadersStore.set(messageId, headers);
}

/**
 * Removes stored request headers for a message ID.
 *
 * @param messageId - The A2A message ID.
 */
export function deleteA2aRequestHeaders(messageId: string): void {
  requestHeadersStore.delete(messageId);
}

/**
 * Extracts request-level HTTP headers from a RequestContext.
 *
 * Checks `ctx.request.headers` first, then falls back to the in-flight headers store.
 *
 * @param ctx - The A2A RequestContext.
 * @returns The incoming request headers, or undefined if not available.
 */
export function getA2aRequestHeaders(
  ctx: RequestContext,
): Record<string, string | string[] | undefined> | undefined {
  const reqContext = ctx as RequestContextWithRequest;
  if (reqContext.request?.headers) {
    return reqContext.request.headers;
  }
  const messageId = ctx.userMessage?.messageId;
  if (messageId && requestHeadersStore.has(messageId)) {
    return requestHeadersStore.get(messageId);
  }
  return undefined;
}

/**
 * Extracts request-level A2A metadata from a RequestContext.
 *
 * Supports @a2a-js/sdk >= 1.0.0 (`ctx.request.metadata`) and @a2a-js/sdk 0.3.x via
 * `AdkDefaultRequestHandler`.
 */
export function getA2aRequestMetadata(
  ctx: RequestContext,
): Record<string, unknown> | undefined {
  const reqContext = ctx as RequestContextWithRequest;
  if (reqContext.request?.metadata) {
    return reqContext.request.metadata;
  }
  const messageId = ctx.userMessage?.messageId;
  if (messageId && requestMetadataStore.has(messageId)) {
    return requestMetadataStore.get(messageId);
  }
  return undefined;
}

/**
 * A2A DefaultRequestHandler extension that preserves request-level metadata (`params.metadata`)
 * and headers across agent executions regardless of @a2a-js/sdk version.
 */
export class AdkDefaultRequestHandler extends DefaultRequestHandler {
  override async sendMessage(
    params: MessageSendParams,
    context?: ServerCallContext,
  ): Promise<Message | Task> {
    const messageId = params.message?.messageId;
    if (messageId && params.metadata) {
      requestMetadataStore.set(
        messageId,
        params.metadata as Record<string, unknown>,
      );
    }
    const configHeaders = (
      params.configuration as {headers?: HttpHeadersRecord} | undefined
    )?.headers;
    let didStoreConfigHeaders = false;
    if (messageId && configHeaders && !requestHeadersStore.has(messageId)) {
      requestHeadersStore.set(messageId, configHeaders);
      didStoreConfigHeaders = true;
    }
    try {
      return await super.sendMessage(params, context);
    } finally {
      if (messageId) {
        requestMetadataStore.delete(messageId);
        if (didStoreConfigHeaders) {
          requestHeadersStore.delete(messageId);
        }
      }
    }
  }

  override async *sendMessageStream(
    params: MessageSendParams,
    context?: ServerCallContext,
  ): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
    void,
    undefined
  > {
    const messageId = params.message?.messageId;
    if (messageId && params.metadata) {
      requestMetadataStore.set(
        messageId,
        params.metadata as Record<string, unknown>,
      );
    }
    const configHeaders = (
      params.configuration as {headers?: HttpHeadersRecord} | undefined
    )?.headers;
    let didStoreConfigHeaders = false;
    if (messageId && configHeaders && !requestHeadersStore.has(messageId)) {
      requestHeadersStore.set(messageId, configHeaders);
      didStoreConfigHeaders = true;
    }
    try {
      yield* super.sendMessageStream(params, context);
    } finally {
      if (messageId) {
        requestMetadataStore.delete(messageId);
        if (didStoreConfigHeaders) {
          requestHeadersStore.delete(messageId);
        }
      }
    }
  }
}
