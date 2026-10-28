/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import type {Span} from '@opentelemetry/api';

import type {InvocationContext} from '../../../../agents/invocation_context.js';
import {GcpAttr} from '../common/attributes.js';
import {
  safeJsonSerialize,
  shouldAddRequestResponseToSpans,
} from '../common/serialization.js';

/** Parameters for recording live history `send_data` attributes on a span. */
export interface SetSendDataAttributesParams {
  /** The invocation context for the current agent run. */
  readonly invocationContext: InvocationContext;
  /** The ID of the event. */
  readonly eventId: string;
  /** A list of content objects. */
  readonly data: Content[];
}

/**
 * Sets `send_data` attributes on the given span.
 */
export function setSendDataAttributes(
  span: Span,
  {invocationContext, eventId, data}: SetSendDataAttributesParams,
): void {
  span.setAttributes({
    [GcpAttr.INVOCATION_ID]: invocationContext.invocationId,
    [GcpAttr.EVENT_ID]: eventId,
  });

  span.setAttribute(
    GcpAttr.DATA,
    shouldAddRequestResponseToSpans() ? safeJsonSerialize(data) : '{}',
  );
}
