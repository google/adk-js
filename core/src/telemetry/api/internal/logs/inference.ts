/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {context, type Span, trace} from '@opentelemetry/api';
import type {LogAttributes} from '@opentelemetry/api-logs';

import {getTelemetryLogger} from './logger.js';

/** Event name of the log record that details one model call. */
const INFERENCE_OPERATION_DETAILS_EVENT =
  'gen_ai.client.inference.operation.details';

/**
 * Emits the `gen_ai.client.inference.operation.details` record of one model
 * call, parented to its `generate_content` span.
 *
 * The span is named explicitly rather than taken from the active context,
 * which need not hold it when the call ends.
 */
export function emitInferenceOperationDetails(
  span: Span,
  attributes: LogAttributes,
): void {
  getTelemetryLogger().emit({
    eventName: INFERENCE_OPERATION_DETAILS_EVENT,
    attributes,
    context: trace.setSpan(context.active(), span),
  });
}
