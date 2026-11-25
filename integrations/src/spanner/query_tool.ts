/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Context, GoogleCredentials} from '@google/adk';
import {inspect} from 'node:util';
import {z} from 'zod';

import {getSpannerClient} from './client.js';
import {
  resolveMaxExecutedQueryResultRows,
  type SpannerToolSettings,
  type SpannerToolSettingsOptions,
} from './settings.js';
import {
  type SpannerToolErrorResult,
  toSpannerToolErrorResult,
} from './tool_error.js';

/**
 * Zod parameter schema for {@link executeSpannerSql}.
 */
export const executeSpannerSqlParameters = z.object({
  project_id: z
    .string()
    .describe('The GCP project id in which the spanner database resides.'),
  instance_id: z.string().describe('The instance id of the spanner database.'),
  database_id: z.string().describe('The database id of the spanner database.'),
  query: z.string().describe('The Spanner SQL query to be executed.'),
});

/**
 * Arguments accepted by {@link executeSpannerSql}.
 */
export interface ExecuteSpannerSqlArgs {
  /**
   * Google Cloud project ID in which the Spanner database resides. Falls back
   * to `GOOGLE_CLOUD_PROJECT` when omitted or empty.
   */
  project_id?: string;

  /**
   * Cloud Spanner instance ID.
   */
  instance_id: string;

  /**
   * Cloud Spanner database ID.
   */
  database_id: string;

  /**
   * Read-only Spanner SQL query to execute.
   */
  query: string;

  /**
   * Credentials injected by `GoogleTool`.
   */
  credentials?: GoogleCredentials;

  /**
   * Spanner tool settings injected by `GoogleTool`.
   */
  settings?: SpannerToolSettings | SpannerToolSettingsOptions;

  /**
   * Tool execution context passed by `GoogleTool`.
   */
  toolContext?: Context;
}

/**
 * Successful query result returned by {@link executeSpannerSql}.
 */
export interface ExecuteSpannerSqlSuccessResult {
  status: 'SUCCESS';
  rows: unknown[];
  result_is_likely_truncated?: boolean;
}

/**
 * Result returned by {@link executeSpannerSql}.
 */
export type ExecuteSpannerSqlResult =
  ExecuteSpannerSqlSuccessResult | SpannerToolErrorResult;

function serializeQueryRow(row: unknown[]): unknown[] | string {
  try {
    JSON.stringify(row);
    return row;
  } catch {
    return inspect(row, {depth: null});
  }
}

/**
 * Returns the model-facing description for the Spanner `execute_sql` tool,
 * reflecting the configured `maxExecutedQueryResultRows` limit.
 */
export function getExecuteSpannerSqlDescription(
  settings?: SpannerToolSettings | SpannerToolSettingsOptions,
): string {
  const maxRows = resolveMaxExecutedQueryResultRows(
    settings?.maxExecutedQueryResultRows,
  );
  return (
    'Run a Spanner Read-Only query in the spanner database and return the result. ' +
    "Returns {status: 'SUCCESS', rows}, where each row is an array of column values. " +
    `At most ${maxRows} ${maxRows === 1 ? 'row is' : 'rows are'} returned. ` +
    'If the result contains result_is_likely_truncated: true, more rows can match the query ' +
    'than the result contains; use aggregation, filters or LIMIT to get a smaller result. ' +
    "On failure, returns {status: 'ERROR', error_details}. " +
    'Note: This is running with Read-Only Transaction for query that only read data.'
  );
}

/**
 * Runs a read-only SQL query against a Cloud Spanner database using a snapshot
 * transaction and returns at most `settings.maxExecutedQueryResultRows` rows
 * (`50` by default).
 */
export async function executeSpannerSql(
  args: ExecuteSpannerSqlArgs,
  _toolContext?: Context,
): Promise<ExecuteSpannerSqlResult> {
  try {
    const maxRows = resolveMaxExecutedQueryResultRows(
      args.settings?.maxExecutedQueryResultRows,
    );
    const spannerClient = getSpannerClient({
      projectId: args.project_id,
      credentials: args.credentials,
    });

    return await spannerClient.withDatabase(
      {instanceId: args.instance_id, databaseId: args.database_id},
      async (db) => {
        const dialect = await db.getDialect();
        if (dialect === 'POSTGRESQL') {
          return {
            status: 'ERROR',
            error_details: 'PostgreSQL dialect is not supported.',
          };
        }

        const rawRows = await db.runQuery({
          sql: args.query,
          maxRows,
        });
        const rows = rawRows.map((row) => serializeQueryRow(row));

        const result: ExecuteSpannerSqlSuccessResult = {
          status: 'SUCCESS',
          rows,
        };
        if (rows.length >= maxRows) {
          result.result_is_likely_truncated = true;
        }
        return result;
      },
    );
  } catch (error: unknown) {
    return toSpannerToolErrorResult(error);
  }
}
