/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const DEFAULT_MAX_EXECUTED_QUERY_RESULT_ROWS = 50;

/**
 * Capabilities indicating which categories of operations Spanner tools may perform.
 */
export enum SpannerCapabilities {
  /**
   * Read-only data operations are allowed.
   */
  DATA_READ = 'data_read',
}

/**
 * Validates `maxExecutedQueryResultRows` when provided and returns the
 * effective positive integer row limit, defaulting to `50`.
 */
export function resolveMaxExecutedQueryResultRows(value?: number): number {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new RangeError(
      'maxExecutedQueryResultRows must be a positive integer.',
    );
  }
  return value ?? DEFAULT_MAX_EXECUTED_QUERY_RESULT_ROWS;
}

/**
 * Configuration options for {@link SpannerToolSettings}.
 */
export interface SpannerToolSettingsOptions {
  /**
   * Allowed capabilities for tools in {@link SpannerToolset}. Defaults to
   * `[SpannerCapabilities.DATA_READ]`.
   */
  capabilities?: readonly SpannerCapabilities[];

  /**
   * Maximum number of rows to return from a query result. Must be a positive
   * integer; defaults to `50`.
   */
  maxExecutedQueryResultRows?: number;
}

const SPANNER_TOOL_SETTINGS_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.spannerToolSettings',
);

/**
 * Type guard checking whether a value is an instance of
 * {@link SpannerToolSettings}.
 */
export function isSpannerToolSettings(
  obj: unknown,
): obj is SpannerToolSettings {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    SPANNER_TOOL_SETTINGS_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[SPANNER_TOOL_SETTINGS_SIGNATURE_SYMBOL] ===
      true
  );
}

/**
 * Settings configuring capability guards and query limits for Spanner tools.
 */
export class SpannerToolSettings {
  readonly [SPANNER_TOOL_SETTINGS_SIGNATURE_SYMBOL] = true;

  /**
   * Allowed capabilities for Spanner tools.
   */
  readonly capabilities: readonly SpannerCapabilities[];

  /**
   * Maximum number of rows returned from an executed query.
   */
  readonly maxExecutedQueryResultRows: number;

  constructor(options: SpannerToolSettingsOptions = {}) {
    this.capabilities = options.capabilities
      ? [...options.capabilities]
      : [SpannerCapabilities.DATA_READ];
    this.maxExecutedQueryResultRows = resolveMaxExecutedQueryResultRows(
      options.maxExecutedQueryResultRows,
    );
  }
}
