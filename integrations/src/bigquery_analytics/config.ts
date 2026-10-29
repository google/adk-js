/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type ToolResultClassifier,
  validateToolResultClassifier,
} from './callback_helpers.js';

/**
 * Retry policy for failed BigQuery writes. Delays are in seconds, as in
 * adk-python.
 */
export interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  multiplier: number;
  maxDelay: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelay: 1,
  multiplier: 2,
  maxDelay: 10,
};

export type EvalViewMode = 'full' | 'conversation_only';

/**
 * A content formatter returns the value to log instead of the content. It is a
 * redaction boundary: a throw or an unsupported return writes
 * `[FORMATTER_FAILED]` instead of the original content.
 */
export type ContentFormatter = (content: unknown, eventType: string) => unknown;

/**
 * Port of adk-python `BigQueryLoggerConfig`; see its docstring for the full
 * semantics of each field. Durations are in seconds to keep values
 * interchangeable with Python deployments.
 */
export interface BigQueryLoggerConfig {
  enabled: boolean;
  eventAllowlist: ReadonlyArray<string> | null;
  eventDenylist: ReadonlyArray<string> | null;
  /** Max characters per text block; -1 is unlimited. */
  maxContentLength: number;
  tableId: string;
  clusteringFields: ReadonlyArray<string>;
  logMultiModalContent: boolean;
  retryConfig: RetryConfig;
  batchSize: number;
  batchFlushInterval: number;
  shutdownTimeout: number;
  queueMaxSize: number;
  contentFormatter: ContentFormatter | null;
  gcsBucketName: string | null;
  /** `location.connection_id`, the authorizer for ObjectRef columns. */
  connectionId: string | null;
  logSessionMetadata: boolean;
  customTags: Readonly<Record<string, unknown>>;
  autoSchemaUpgrade: boolean;
  createViews: boolean;
  viewPrefix: string;
  enableOtelCorrelation: boolean;
  customMetadataAllowlist: ReadonlyArray<string> | null;
  payloadColumnDenylist: ReadonlyArray<string> | null;
  finalResponseToolNames: ReadonlySet<string>;
  flushOnRunEnd: boolean;
  exactlyOnceDelivery: boolean;
  debugContentFormatterErrors: boolean;
  onSchemaError: ((error: unknown) => void) | null;
  onSchemaReady: (() => void) | null;
  createEvalViews: boolean;
  toolResultClassifier: ToolResultClassifier | null;
  evalViewMode: EvalViewMode;
  /**
   * Most `WORKFLOW_NODE_OBSERVATION_SUMMARY` rows written when a runner call
   * ends, one per workflow node path in first-observed order. Paths left out
   * are counted under the `workflow_observation_capacity` drop reason, and the
   * last summary written carries their number as
   * `attributes.adk.truncated_node_count`.
   */
  maxObservationSummariesPerSegment: number;
}

export const DEFAULT_LOGGER_CONFIG: BigQueryLoggerConfig = {
  enabled: true,
  eventAllowlist: null,
  eventDenylist: null,
  maxContentLength: 500 * 1024,
  tableId: 'agent_events',
  clusteringFields: ['event_type', 'agent', 'user_id'],
  logMultiModalContent: true,
  retryConfig: DEFAULT_RETRY_CONFIG,
  batchSize: 1,
  batchFlushInterval: 1,
  shutdownTimeout: 10,
  queueMaxSize: 10_000,
  contentFormatter: null,
  gcsBucketName: null,
  connectionId: null,
  logSessionMetadata: true,
  customTags: {},
  autoSchemaUpgrade: true,
  createViews: true,
  viewPrefix: 'v',
  enableOtelCorrelation: false,
  customMetadataAllowlist: null,
  payloadColumnDenylist: null,
  finalResponseToolNames: new Set(),
  flushOnRunEnd: true,
  exactlyOnceDelivery: false,
  debugContentFormatterErrors: false,
  onSchemaError: null,
  onSchemaReady: null,
  createEvalViews: false,
  toolResultClassifier: null,
  evalViewMode: 'full',
  maxObservationSummariesPerSegment: 200,
};

function definedEntries<T extends object>(
  value: Partial<T> | undefined,
): Partial<T> {
  // SAFETY: dropping entries keeps every remaining key's type.
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function copyList(
  list: ReadonlyArray<string> | null,
): ReadonlyArray<string> | null {
  return list === null ? null : [...list];
}

/**
 * Fills unset fields from the defaults. A field passed as `undefined` counts as
 * unset, and collections are copied so instances never share them.
 */
export function resolveLoggerConfig(
  config: Partial<BigQueryLoggerConfig> = {},
): BigQueryLoggerConfig {
  const merged: BigQueryLoggerConfig = {
    ...DEFAULT_LOGGER_CONFIG,
    ...definedEntries(config),
    retryConfig: {
      ...DEFAULT_RETRY_CONFIG,
      ...definedEntries(config.retryConfig),
    },
  };
  const bucket = merged.gcsBucketName;
  return {
    ...merged,
    gcsBucketName:
      typeof bucket === 'string' && bucket.trim() !== '' ? bucket : null,
    eventAllowlist: copyList(merged.eventAllowlist),
    eventDenylist: copyList(merged.eventDenylist),
    clusteringFields: [...merged.clusteringFields],
    customTags: {...merged.customTags},
    customMetadataAllowlist: copyList(merged.customMetadataAllowlist),
    payloadColumnDenylist: copyList(merged.payloadColumnDenylist),
    // A JavaScript caller may pass an array.
    finalResponseToolNames: new Set(merged.finalResponseToolNames),
  };
}

function requireCount({
  name,
  value,
  minimum,
}: {
  name: string;
  value: number;
  minimum: number;
}): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${name} must be an int, got ${String(value)}.`);
  }
  if (value < minimum) {
    throw new RangeError(`${name} must be >= ${minimum}, got ${value}.`);
  }
}

function requireFinite({
  name,
  value,
  minimumExclusive,
}: {
  name: string;
  value: number;
  minimumExclusive: number;
}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite, got ${String(value)}.`);
  }
  if (value <= minimumExclusive) {
    throw new RangeError(
      `${name} must be > ${minimumExclusive}, got ${value}.`,
    );
  }
  return value;
}

function isAsyncFunction(fn: unknown): boolean {
  return (
    typeof fn === 'function' &&
    (fn.constructor.name === 'AsyncFunction' ||
      fn.constructor.name === 'AsyncGeneratorFunction')
  );
}

/**
 * Port of `_validate_runtime_config`: rejects settings that would otherwise
 * misbehave silently at runtime.
 */
export function validateRuntimeConfig(config: BigQueryLoggerConfig): void {
  requireCount({name: 'batchSize', value: config.batchSize, minimum: 1});
  requireFinite({
    name: 'batchFlushInterval',
    value: config.batchFlushInterval,
    minimumExclusive: 0,
  });
  requireFinite({
    name: 'shutdownTimeout',
    value: config.shutdownTimeout,
    minimumExclusive: 0,
  });
  requireCount({name: 'queueMaxSize', value: config.queueMaxSize, minimum: 1});
  if (!Number.isInteger(config.maxContentLength)) {
    throw new RangeError(
      `maxContentLength must be an int, got ${String(config.maxContentLength)}.`,
    );
  }
  if (config.maxContentLength !== -1 && config.maxContentLength < 1) {
    throw new RangeError(
      `maxContentLength must be -1 (unlimited) or >= 1, got ${config.maxContentLength}.`,
    );
  }
  const retry = config.retryConfig;
  requireCount({
    name: 'retryConfig.maxRetries',
    value: retry.maxRetries,
    minimum: 0,
  });
  const initialDelay = requireFinite({
    name: 'retryConfig.initialDelay',
    value: retry.initialDelay,
    minimumExclusive: -1,
  });
  if (initialDelay < 0) {
    throw new RangeError(
      `retryConfig.initialDelay must be >= 0, got ${retry.initialDelay}.`,
    );
  }
  const multiplier = requireFinite({
    name: 'retryConfig.multiplier',
    value: retry.multiplier,
    minimumExclusive: 0,
  });
  if (multiplier < 1) {
    throw new RangeError(
      `retryConfig.multiplier must be >= 1, got ${retry.multiplier}.`,
    );
  }
  const maxDelay = requireFinite({
    name: 'retryConfig.maxDelay',
    value: retry.maxDelay,
    minimumExclusive: -1,
  });
  if (maxDelay < 0) {
    throw new RangeError(
      `retryConfig.maxDelay must be >= 0, got ${retry.maxDelay}.`,
    );
  }
  if (maxDelay < initialDelay) {
    throw new RangeError(
      `retryConfig.maxDelay must be >= initialDelay, got maxDelay=${retry.maxDelay} initialDelay=${retry.initialDelay}.`,
    );
  }
  for (const [name, callback] of [
    ['onSchemaError', config.onSchemaError],
    ['onSchemaReady', config.onSchemaReady],
  ] as const) {
    if (
      callback !== null &&
      (typeof callback !== 'function' || isAsyncFunction(callback))
    ) {
      throw new RangeError(`${name} must be a synchronous function or null.`);
    }
  }
  requireCount({
    name: 'maxObservationSummariesPerSegment',
    value: config.maxObservationSummariesPerSegment,
    minimum: 1,
  });
  validateToolResultClassifier(config.toolResultClassifier);
}
