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

/**
 * Request-scoped metadata store for A2A request metadata propagation.
 * Bridges SDK versions (such as 0.3.x) where DefaultRequestHandler does not attach
 * params.metadata to RequestContext, while SDK >= 1.0.0 provides ctx.request.metadata natively.
 */
export const requestMetadataStore = new Map<string, Record<string, unknown>>();

/**
 * Extracts request-level A2A metadata from a RequestContext.
 *
 * Supports @a2a-js/sdk >= 1.0.0 (`ctx.request.metadata`), custom RequestContext
 * instances (`ctx.metadata` or `ctx.params.metadata`), and @a2a-js/sdk 0.3.x via
 * `AdkDefaultRequestHandler` (`requestMetadataStore`).
 */
export function getA2aRequestMetadata(
  ctx: RequestContext,
): Record<string, unknown> | undefined {
  const req = (
    ctx as unknown as {request?: {metadata?: Record<string, unknown>}}
  ).request;
  if (req?.metadata) {
    return req.metadata;
  }
  const directMetadata = (
    ctx as unknown as {metadata?: Record<string, unknown>}
  ).metadata;
  if (directMetadata) {
    return directMetadata;
  }
  const paramsMetadata = (
    ctx as unknown as {params?: {metadata?: Record<string, unknown>}}
  ).params?.metadata;
  if (paramsMetadata) {
    return paramsMetadata;
  }
  const messageId = ctx.userMessage?.messageId;
  if (messageId && requestMetadataStore.has(messageId)) {
    return requestMetadataStore.get(messageId);
  }
  return undefined;
}

/**
 * A2A DefaultRequestHandler extension that preserves request-level metadata (`params.metadata`)
 * across agent executions regardless of @a2a-js/sdk version.
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
    try {
      return await super.sendMessage(params, context);
    } finally {
      if (messageId) {
        requestMetadataStore.delete(messageId);
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
    try {
      yield* super.sendMessageStream(params, context);
    } finally {
      if (messageId) {
        requestMetadataStore.delete(messageId);
      }
    }
  }
}
