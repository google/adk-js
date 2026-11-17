/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {DefaultRequestHandler, RequestContext} from '@a2a-js/sdk/server';

/**
 * Extracts request-level A2A metadata (`SendMessageRequest.metadata`) from a
 * RequestContext.
 */
export function getA2aRequestMetadata(
  ctx: RequestContext,
): Record<string, unknown> | undefined {
  return ctx.request?.metadata || undefined;
}

/**
 * The `DefaultRequestHandler` of `@a2a-js/sdk`, configured for
 * {@link A2AAgentExecutor}.
 *
 * {@link A2AAgentExecutor} returns once a run pauses for input or a credential,
 * and the client resumes the task with a new message. So unless the caller
 * passes its own `keepBusAliveStates`, this handler keeps no event bus alive
 * after the executor returns: with the SDK default, a stream that ends on
 * `TASK_STATE_AUTH_REQUIRED` would stay open with nothing left to publish.
 *
 * Request-level metadata reaches the executor natively through
 * `RequestContext.request.metadata`; see {@link getA2aRequestMetadata}.
 */
export class AdkDefaultRequestHandler extends DefaultRequestHandler {
  constructor(...args: ConstructorParameters<typeof DefaultRequestHandler>) {
    const [
      agentCard,
      taskStore,
      agentExecutor,
      eventBusManager,
      pushNotificationStore,
      pushNotificationSender,
      extendedAgentCardProvider,
      agentCardSignatureGenerator,
      options,
    ] = args;
    super(
      agentCard,
      taskStore,
      agentExecutor,
      eventBusManager,
      pushNotificationStore,
      pushNotificationSender,
      extendedAgentCardProvider,
      agentCardSignatureGenerator,
      {keepBusAliveStates: [], ...options},
    );
  }
}
