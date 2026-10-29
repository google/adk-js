/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import type {GoogleOAuthCredentials} from './bigquery_credentials.js';
import {getBigQueryClient} from './client.js';
import type {BigQueryToolErrorResult} from './metadata_tool.js';

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
  project_id?: string;
  projectId?: string;
  query: string;
  credentials?: GoogleOAuthCredentials;
}

/**
 * Successful query result returned by {@link executeSql}.
 */
export interface ExecuteSqlSuccessResult {
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
 */
export async function executeSql(
  args: ExecuteSqlArgs,
): Promise<ExecuteSqlResult> {
  try {
    const projectId = args.project_id ?? args.projectId ?? '';
    const bqClient = getBigQueryClient({
      project: projectId,
      credentials: args.credentials,
      userAgent: 'execute_sql',
    });
    const rawRows = await bqClient.queryAndWait(args.query, {
      project: projectId,
      maxResults: DEFAULT_MAX_QUERY_RESULT_ROWS,
    });
    const rows: Array<Record<string, unknown>> = rawRows.map((row) => {
      const sanitized: Record<string, unknown> = {};
      for (const entry of Object.entries(row)) {
        sanitized[entry[0]] = toJsonSerializableValue(entry[1]);
      }
      return sanitized;
    });
    const result: ExecuteSqlSuccessResult = {rows};
    if (rows.length === DEFAULT_MAX_QUERY_RESULT_ROWS) {
      result.result_is_likely_truncated = true;
    }
    return result;
  } catch (error: unknown) {
    return {
      status: 'ERROR',
      error_details: error instanceof Error ? error.message : String(error),
    };
  }
}
