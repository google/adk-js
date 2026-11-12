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
   * All write operations (including DML and DDL) are permitted.
   */
  ALLOWED = 'allowed',
}

/**
 * Configuration options for {@link BigQueryToolConfig}.
 */
export interface BigQueryToolConfigOptions {
  /**
   * Write mode for BigQuery tools. Defaults to {@link WriteMode.BLOCKED}.
   */
  writeMode?: WriteMode;
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
   * Write mode specifying whether write queries are blocked or allowed.
   */
  readonly writeMode: WriteMode;

  constructor(options: BigQueryToolConfigOptions = {}) {
    this.writeMode = options.writeMode ?? WriteMode.BLOCKED;
  }
}
