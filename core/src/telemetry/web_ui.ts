/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Context} from '@opentelemetry/api';
import type {AnyValue} from '@opentelemetry/api-logs';
import type {
  LogRecordProcessor,
  ReadWriteLogRecord,
} from '@opentelemetry/sdk-logs';

import {base64Encode} from '../utils/env_aware_utils.js';

import {getInferenceScope} from './tracing.js';

/** Event name of the only records the trace view shows. */
const COMPLETION_DETAILS_EVENT_NAME =
  'gen_ai.client.inference.operation.details';

/** `user.id` attribute key, restored next to the content. */
const USER_ID_ATTRIBUTE = 'user.id';

/**
 * How many records are kept. Each one pins its model call's content, so only
 * the latest are kept.
 */
const MAX_LOGS = 1000;

/** One log record kept for the dev server trace view. */
export interface WebUiLog {
  /** Hex id of the span the record was emitted under. */
  readonly spanId: string;
  /** The record's event name. */
  readonly eventName: string;
  /** The record's body, with bytes base64-encoded. */
  readonly body: AnyValue;
  /**
   * The record's attributes with the message content and `user.id` restored,
   * and bytes base64-encoded.
   */
  readonly attributes: Readonly<Record<string, AnyValue>>;
}

/**
 * Keeps the latest `gen_ai.client.inference.operation.details` records for the
 * dev server trace view.
 *
 * It is a processor rather than an exporter because only `onEmit` receives
 * the context that carries the content of the model call. The stored copy
 * puts that content back even when content capture is off for export; the
 * record that other processors see is never changed.
 */
export class WebUiLogProcessor implements LogRecordProcessor {
  private readonly logs: WebUiLog[] = [];

  /**
   * Keeps a copy of a completion-details record, with the content from the
   * emit context restored.
   */
  onEmit(logRecord: ReadWriteLogRecord, otelContext?: Context): void {
    const spanId = logRecord.spanContext?.spanId;
    if (logRecord.eventName !== COMPLETION_DETAILS_EVENT_NAME || !spanId) {
      return;
    }
    const attributes: Record<string, AnyValue> = {...logRecord.attributes};
    const scope = getInferenceScope(otelContext);
    if (scope) {
      Object.assign(attributes, scope.contentAttributes);
      if (scope.userId !== undefined) {
        attributes[USER_ID_ATTRIBUTE] = scope.userId;
      }
    }
    this.logs.push({
      spanId,
      eventName: logRecord.eventName,
      body: serializeForWebUi(logRecord.body ?? null),
      attributes: Object.fromEntries(
        Object.entries(attributes).map(([key, value]) => [
          key,
          serializeForWebUi(value),
        ]),
      ),
    });
    if (this.logs.length > MAX_LOGS) {
      this.logs.shift();
    }
  }

  /** Returns the kept records, oldest first. */
  getFinishedLogs(): readonly WebUiLog[] {
    return [...this.logs];
  }

  /** Resolves at once; records are kept as they are emitted. */
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  /** Resolves at once; there is nothing to release. */
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Base64-encodes bytes, recursively, with the standard alphabet, which the
 * browser's `atob` accepts.
 */
function serializeForWebUi(value: AnyValue): AnyValue {
  if (value instanceof Uint8Array) {
    return base64Encode(value);
  }
  if (Array.isArray(value)) {
    return value.map((item: AnyValue) => serializeForWebUi(item));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        serializeForWebUi(item),
      ]),
    );
  }
  return value;
}
