/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retry settings for failed BigQuery writes.
 */
export interface RetryConfig {
  /** Maximum number of retries after the first attempt. Defaults to `3`. */
  readonly maxRetries: number;
  /** Delay before the first retry, in seconds. Defaults to `1.0`. */
  readonly initialDelay: number;
  /** Factor applied to the delay after each retry. Defaults to `2.0`. */
  readonly multiplier: number;
  /** Upper bound of a single retry delay, in seconds. Defaults to `10.0`. */
  readonly maxDelay: number;
}

/**
 * Options for configuring {@link BigQueryAgentAnalyticsPlugin}.
 */
export interface BigQueryAgentAnalyticsPluginOptions {
  /** Google Cloud project ID where the BigQuery dataset is located. */
  readonly projectId: string;
  /** BigQuery dataset ID. */
  readonly datasetId: string;
  /** Table ID for events. Defaults to `'agent_events'`. */
  readonly tableId?: string;
  /** Plugin configuration overrides. */
  readonly config?: Partial<BigQueryLoggerConfig>;
}

/**
 * Configuration of the {@link BigQueryAgentAnalyticsPlugin}.
 */
export interface BigQueryLoggerConfig {
  /** Whether logging is enabled. When `false`, no SDK is ever loaded. */
  readonly enabled: boolean;
  /** Event types to log. When unset, every event type is logged. */
  readonly eventAllowlist?: readonly string[];
  /** Event types never to log. */
  readonly eventDenylist?: readonly string[];
  /**
   * Maximum number of characters kept per text value before it is
   * truncated, or `-1` for no limit. Defaults to `500 * 1024`.
   */
  readonly maxContentLength: number;
  /** Table ID of the events table. Defaults to `'agent_events'`. */
  readonly tableId: string;
  /** Clustering fields used when the plugin creates the table. */
  readonly clusteringFields: readonly string[];
  /** Whether to write the `content_parts` column. Defaults to `true`. */
  readonly logMultiModalContent: boolean;
  /** Retry settings for writes. */
  readonly retryConfig: RetryConfig;
  /** Number of rows written per batch. Defaults to `1`. */
  readonly batchSize: number;
  /**
   * Maximum time a queued row waits before its batch is written, in
   * seconds. Defaults to `1.0`.
   */
  readonly batchFlushInterval: number;
  /** Maximum time `shutdown()` waits for the queue to drain, in seconds. */
  readonly shutdownTimeout: number;
  /**
   * Maximum number of queued rows. A few slots (1% of the queue, at least 2,
   * never all of them) are kept for `INVOCATION_COMPLETED` rows.
   */
  readonly queueMaxSize: number;
  /** Whether to write `attributes.session_metadata`. Defaults to `true`. */
  readonly logSessionMetadata: boolean;
  /** Static tags written to `attributes.custom_tags` on every row. */
  readonly customTags: Readonly<Record<string, unknown>>;
  /** Whether to flush queued rows when each run ends. Defaults to `true`. */
  readonly flushOnRunEnd: boolean;
  /**
   * Whether to write the active OpenTelemetry span and trace ids to
   * `attributes.otel`. Defaults to `false`.
   */
  readonly enableOtelCorrelation: boolean;
  /**
   * Whether to automatically add missing columns to an existing events table.
   * Defaults to `true`.
   */
  readonly autoSchemaUpgrade: boolean;
  /**
   * Whether to automatically create per-event-type BigQuery analytics views.
   * Defaults to `true`.
   */
  readonly createViews: boolean;
  /**
   * Prefix for auto-created per-event-type view names. Defaults to `'v'`.
   */
  readonly viewPrefix: string;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = Object.freeze({
  maxRetries: 3,
  initialDelay: 1.0,
  multiplier: 2.0,
  maxDelay: 10.0,
});

/**
 * Creates a {@link BigQueryLoggerConfig}, filling every unset option with its
 * default.
 */
export function createBigQueryLoggerConfig(
  partial: Partial<BigQueryLoggerConfig> = {},
): BigQueryLoggerConfig {
  return {
    enabled: true,
    maxContentLength: 500 * 1024,
    tableId: 'agent_events',
    clusteringFields: ['event_type', 'agent', 'user_id'],
    logMultiModalContent: true,
    batchSize: 1,
    batchFlushInterval: 1.0,
    shutdownTimeout: 10.0,
    queueMaxSize: 10000,
    logSessionMetadata: true,
    customTags: {},
    flushOnRunEnd: true,
    enableOtelCorrelation: false,
    autoSchemaUpgrade: true,
    createViews: true,
    viewPrefix: 'v',
    ...partial,
    retryConfig: {...DEFAULT_RETRY_CONFIG, ...partial.retryConfig},
  };
}

/**
 * Checks that the runtime settings of a config are usable.
 *
 * @throws Error naming the first invalid field and its value.
 */
export function validateLoggerConfig(config: BigQueryLoggerConfig): void {
  requireCount('batchSize', config.batchSize, 1);
  requirePositiveFinite('batchFlushInterval', config.batchFlushInterval);
  requirePositiveFinite('shutdownTimeout', config.shutdownTimeout);
  requireCount('queueMaxSize', config.queueMaxSize, 1);
  if (
    !Number.isInteger(config.maxContentLength) ||
    (config.maxContentLength !== -1 && config.maxContentLength < 1)
  ) {
    throw new Error(
      `maxContentLength must be -1 (unlimited) or an integer of at least 1, got ${config.maxContentLength}.`,
    );
  }
  const retry = config.retryConfig;
  requireCount('retryConfig.maxRetries', retry.maxRetries, 0);
  requireNonNegativeFinite('retryConfig.initialDelay', retry.initialDelay);
  if (!Number.isFinite(retry.multiplier) || retry.multiplier < 1) {
    throw new Error(
      `retryConfig.multiplier must be a finite number of at least 1, got ${retry.multiplier}.`,
    );
  }
  requireNonNegativeFinite('retryConfig.maxDelay', retry.maxDelay);
  if (retry.maxDelay < retry.initialDelay) {
    throw new Error(
      `retryConfig.maxDelay must be at least retryConfig.initialDelay, got maxDelay=${retry.maxDelay} and initialDelay=${retry.initialDelay}.`,
    );
  }
  if (typeof config.viewPrefix !== 'string' || config.viewPrefix.length === 0) {
    throw new Error('viewPrefix must be a non-empty string.');
  }
}

function requireCount(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `${name} must be an integer of at least ${minimum}, got ${value}.`,
    );
  }
}

function requirePositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${name} must be a finite number greater than 0, got ${value}.`,
    );
  }
}

function requireNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${name} must be a finite number of at least 0, got ${value}.`,
    );
  }
}
