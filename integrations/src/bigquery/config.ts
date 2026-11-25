/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Write mode indicating what levels of write operations are allowed in BigQuery tools.
 */
export enum WriteMode {
  /**
   * No write operations are allowed. Only read operations (SELECT statements) are permitted.
   */
  BLOCKED = 'blocked',

  /**
   * Only protected write operations are allowed in a BigQuery session.
   *
   * Write operations in the anonymous dataset of a BigQuery session (such as
   * temporary tables and models) are permitted while permanent datasets are
   * protected. Non-SELECT statements with no destination dataset (such as
   * scripts, procedure calls, or exports) or targeting a permanent dataset are
   * rejected.
   */
  PROTECTED = 'protected',

  /**
   * All write operations (including DML and DDL) are permitted.
   */
  ALLOWED = 'allowed',
}

export const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;

/**
 * Validates `maxQueryResultRows` when provided and returns the effective
 * positive integer row limit, defaulting to {@link DEFAULT_MAX_QUERY_RESULT_ROWS}.
 */
export function resolveMaxQueryResultRows(value?: number): number {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new RangeError('maxQueryResultRows must be a positive integer.');
  }
  return value ?? DEFAULT_MAX_QUERY_RESULT_ROWS;
}

/**
 * Configuration options for {@link BigQueryToolConfig}.
 */
export interface BigQueryToolConfigOptions {
  /**
   * Write mode for BigQuery tools. Defaults to {@link WriteMode.BLOCKED}.
   */
  writeMode?: WriteMode;

  /**
   * Maximum number of rows to return from a query. Must be a positive integer;
   * defaults to `50`.
   */
  maxQueryResultRows?: number;
}

const BIGQUERY_TOOL_CONFIG_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.bigQueryToolConfig',
);

/**
 * Type guard to check if an object is an instance of {@link BigQueryToolConfig}.
 */
export function isBigQueryToolConfig(obj: unknown): obj is BigQueryToolConfig {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BIGQUERY_TOOL_CONFIG_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[BIGQUERY_TOOL_CONFIG_SIGNATURE_SYMBOL] ===
      true
  );
}

/**
 * Configuration settings for BigQuery tools.
 */
export class BigQueryToolConfig {
  readonly [BIGQUERY_TOOL_CONFIG_SIGNATURE_SYMBOL] = true;

  /**
   * Write mode specifying whether write queries are blocked, protected, or allowed.
   */
  readonly writeMode: WriteMode;

  /**
   * Maximum number of rows to return from a query. Must be a positive integer;
   * defaults to `50`.
   */
  readonly maxQueryResultRows: number;

  constructor(options: BigQueryToolConfigOptions = {}) {
    this.writeMode = options.writeMode ?? WriteMode.BLOCKED;
    this.maxQueryResultRows = resolveMaxQueryResultRows(
      options.maxQueryResultRows,
    );
  }
}

/**
 * Resolves effective tool settings from `args.settings`, falling back to
 * deprecated `args.config` only when `GoogleTool` has not injected both
 * `settings` and `credentials` onto `args`.
 */
export function resolveToolSettings(args: {
  settings?: BigQueryToolConfig | BigQueryToolConfigOptions;
  config?: BigQueryToolConfig | BigQueryToolConfigOptions;
  credentials?: unknown;
}): BigQueryToolConfig | BigQueryToolConfigOptions | undefined {
  if (Object.hasOwn(args, 'settings') && Object.hasOwn(args, 'credentials')) {
    return args.settings;
  }
  return args.settings ?? args.config;
}
