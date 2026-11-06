/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import type {GoogleOAuthCredentials} from './bigquery_credentials.js';
import {getBigQueryClient} from './client.js';
import {
  type BigQueryToolErrorResult,
  toBigQueryToolErrorResult,
} from './tool_error.js';

const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;

/**
 * Zod parameter schema for {@link executeSql}.
 */
export const executeSqlParameters = z.object({
  projectId: z
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
  projectId?: string;

  /**
   * BigQuery SQL query to run.
   */
  query: string;

  /**
   * Credentials injected by {@link BigQueryTool}.
   */
  credentials?: GoogleOAuthCredentials;
}

/**
 * Successful query result returned by {@link executeSql}.
 */
export interface ExecuteSqlSuccessResult {
  status: 'SUCCESS';
  rows: Array<Record<string, unknown>>;
  resultIsLikelyTruncated?: boolean;
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
 */
export async function executeSql(
  args: ExecuteSqlArgs,
): Promise<ExecuteSqlResult> {
  try {
    const bqClient = getBigQueryClient({
      projectId: args.projectId,
      credentials: args.credentials,
      userAgent: 'execute_sql',
    });
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
      result.resultIsLikelyTruncated = true;
    }
    return result;
  } catch (error: unknown) {
    return toBigQueryToolErrorResult(error);
  }
}
