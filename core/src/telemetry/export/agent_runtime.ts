/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';

import {isRequestDrivenMetricReader} from './request_driven_metric_reader.js';
import type {OTelHooks} from './setup.js';

/**
 * Hooks a server calls at the start and end of every request, so telemetry is
 * exported while the request still holds the CPU.
 *
 * Neither hook throws, and {@link AgentRuntimeRequestHooks.onRequestEnd}
 * never rejects: a telemetry failure never breaks the request.
 *
 * @experimental (Experimental, subject to change)
 */
export interface AgentRuntimeRequestHooks {
  /** Call when a request arrives. */
  onRequestStart(): void;
  /**
   * Call when the handler ends the response, before the response completes.
   * Resolves once metrics are drained and spans and logs are flushed.
   */
  onRequestEnd(): Promise<void>;
}

/**
 * Builds the request hooks that drive export for the given processors and
 * readers on a runtime that throttles the CPU between requests.
 *
 * Each request start and end drives every request-driven metric reader in
 * `otelHooks.metricReaders`. Each request end also force-flushes every span and
 * log record processor in `otelHooks`. Other metric readers are left alone:
 * flushing them would collect outside the request-driven reader's spacing
 * rules.
 *
 * @experimental (Experimental, subject to change)
 *
 * @param otelHooks The processors and readers to drive, usually the result of
 *     {@link getGcpExporters}.
 */
export function agentRuntimeRequestHooks(
  otelHooks: OTelHooks,
): AgentRuntimeRequestHooks {
  const readers = (otelHooks.metricReaders ?? []).filter(
    isRequestDrivenMetricReader,
  );
  const flushables = [
    ...(otelHooks.spanProcessors ?? []),
    ...(otelHooks.logRecordProcessors ?? []),
  ];

  return {
    onRequestStart(): void {
      for (const reader of readers) {
        reader.onRequestStart();
      }
    },
    async onRequestEnd(): Promise<void> {
      const results = await Promise.allSettled([
        ...readers.map(async (reader) => reader.onRequestEnd()),
        ...flushables.map(async (processor) => processor.forceFlush()),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.warn(
            `Telemetry flush on request end failed: ${formatError(result.reason)}`,
          );
        }
      }
    },
  };
}
