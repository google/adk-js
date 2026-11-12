/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import type {BigQueryCredentials} from './bigquery_credentials.js';
import {getBigQueryClient} from './client.js';
import {
  BigQueryToolConfig,
  type BigQueryToolConfigOptions,
  isBigQueryToolConfig,
  WriteMode,
} from './config.js';
import {
  type BigQueryToolErrorResult,
  toBigQueryToolErrorResult,
} from './tool_error.js';

const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;

/**
 * Zod parameter schema for {@link executeSql}.
 */
export const executeSqlParameters = z.object({
  project_id: z
    .string()
    .describe('The GCP project id in which the query should be executed.'),
  query: z.string().describe('The BigQuery SQL query to be executed.'),
});

/**
 * Arguments accepted by {@link executeSql}.
 */
export interface ExecuteSqlArgs {
  /**
   * Google Cloud project ID in which to run the query. Falls back to
   * `GOOGLE_CLOUD_PROJECT` when omitted or empty.
   */
  project_id?: string;

  /**
   * BigQuery SQL query to run.
   */
  query: string;

  /**
   * Credentials injected by {@link BigQueryTool}.
   */
  credentials?: BigQueryCredentials;

  /**
   * Tool configuration specifying write mode and query settings.
   */
  config?: BigQueryToolConfig | BigQueryToolConfigOptions;
}

/**
 * Successful query result returned by {@link executeSql}.
 */
export interface ExecuteSqlSuccessResult {
  status: 'SUCCESS';
  rows: Array<Record<string, unknown>>;
  result_is_likely_truncated?: boolean;
}

/**
 * Result returned by {@link executeSql}.
 */
export type ExecuteSqlResult =
  ExecuteSqlSuccessResult | BigQueryToolErrorResult;

function toJsonSerializableValue(val: unknown): unknown {
  try {
    JSON.stringify(val);
    return val;
  } catch {
    return String(val);
  }
}

/**
 * Runs a BigQuery SQL query in the specified project and returns up to 50 rows.
 *
 * In read-only mode (when `config.writeMode` is {@link WriteMode.BLOCKED} or
 * omitted), a dry-run check verifies that the query is a SELECT statement before
 * execution. When `config.writeMode` is {@link WriteMode.ALLOWED}, write statements
 * (including DML and DDL) are permitted.
 */
export async function executeSql(
  args: ExecuteSqlArgs,
): Promise<ExecuteSqlResult> {
  try {
    const bqClient = getBigQueryClient({
      projectId: args.project_id,
      credentials: args.credentials,
      userAgent: 'execute_sql',
    });

    const writeMode = args.config?.writeMode ?? WriteMode.BLOCKED;
    if (writeMode !== WriteMode.ALLOWED) {
      const dryRunResult = await bqClient.dryRun({
        query: args.query,
        projectId: bqClient.projectId,
      });
      if (dryRunResult.statementType !== 'SELECT') {
        return {
          status: 'ERROR',
          error_details: 'Read-only mode only supports SELECT statements.',
        };
      }
    }

    const rawRows = await bqClient.query({
      query: args.query,
      projectId: bqClient.projectId,
      maxResults: DEFAULT_MAX_QUERY_RESULT_ROWS,
    });
    const rows: Array<Record<string, unknown>> = rawRows.map((row) => {
      const sanitized: Record<string, unknown> = {};
      for (const key of Object.keys(row)) {
        sanitized[key] = toJsonSerializableValue(row[key]);
      }
      return sanitized;
    });
    const result: ExecuteSqlSuccessResult = {status: 'SUCCESS', rows};
    if (rows.length === DEFAULT_MAX_QUERY_RESULT_ROWS) {
      result.result_is_likely_truncated = true;
    }
    return result;
  } catch (error: unknown) {
    return toBigQueryToolErrorResult(error);
  }
}

const EXECUTE_SQL_BASE_DESCRIPTION =
  'Run a BigQuery SQL query in the project and return the result. ' +
  "Returns {status: 'SUCCESS', rows}, where each row is an object that maps column names " +
  'to values. At most 50 rows are returned. If the result contains ' +
  'result_is_likely_truncated: true, more rows can match the query than ' +
  'the result contains; use aggregation, filters or LIMIT to get a ' +
  "smaller result. On failure, returns {status: 'ERROR', error_details}.";

const EXECUTE_SQL_WRITE_EXAMPLES =
  '\n\nExamples of write queries:\n' +
  'Create a table from the result of a query:\n' +
  'CREATE TABLE my_project.my_dataset.my_table AS SELECT island, COUNT(*) AS population FROM dataset.table GROUP BY island\n\n' +
  'Delete a table:\n' +
  'DROP TABLE my_project.my_dataset.my_table\n\n' +
  'Copy a table to another table:\n' +
  'CREATE TABLE my_project.my_dataset.my_table_clone CLONE my_project.my_dataset.my_table\n\n' +
  'Create a snapshot table:\n' +
  'CREATE SNAPSHOT TABLE my_project.my_dataset.my_table_snapshot CLONE my_project.my_dataset.my_table\n\n' +
  'Notes:\n' +
  '- To overwrite an existing table, use CREATE OR REPLACE TABLE or DROP TABLE followed by CREATE TABLE.\n' +
  '- To insert data into a table, use the INSERT INTO statement.';

/**
 * Returns the description for the `execute_sql` tool based on the configured write mode.
 */
export function getExecuteSqlDescription(
  config?: BigQueryToolConfig | BigQueryToolConfigOptions,
): string {
  if (config?.writeMode === WriteMode.ALLOWED) {
    return `${EXECUTE_SQL_BASE_DESCRIPTION}${EXECUTE_SQL_WRITE_EXAMPLES}`;
  }
  return EXECUTE_SQL_BASE_DESCRIPTION;
}

/**
 * Returns a configured `execute_sql` function respecting the provided {@link BigQueryToolConfig}.
 */
export function getExecuteSql(
  config?: BigQueryToolConfig | BigQueryToolConfigOptions,
): (args: ExecuteSqlArgs) => Promise<ExecuteSqlResult> {
  const resolvedConfig = config
    ? isBigQueryToolConfig(config)
      ? config
      : new BigQueryToolConfig(config)
    : undefined;
  return async function execute_sql(
    args: ExecuteSqlArgs,
  ): Promise<ExecuteSqlResult> {
    return executeSql({
      ...args,
      config: resolvedConfig ?? args.config,
    });
  };
}
