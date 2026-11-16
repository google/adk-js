/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Context} from '@google/adk';
import {z} from 'zod';

import type {BigQueryCredentials} from './bigquery_credentials.js';
import {
  type BigQueryConnectionProperty,
  type BigQueryQueryOptions,
  getBigQueryClient,
} from './client.js';
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
const MAX_REMEMBERED_SESSIONS = 1024;

interface BigQuerySessionInfo {
  sessionId: string;
  datasetId?: string;
}

const bqSessionsByKey = new Map<string, BigQuerySessionInfo>();
const bqSessionsByContext = new WeakMap<Context, BigQuerySessionInfo>();

function getSessionKey(toolContext?: Context): string | undefined {
  if (!toolContext) {
    return undefined;
  }
  const session = toolContext.invocationContext?.session;
  const sessionId = session?.id ?? toolContext.sessionId;
  if (!sessionId) {
    return undefined;
  }
  const appName = session?.appName ?? '';
  const userId = session?.userId ?? toolContext.userId ?? '';
  return JSON.stringify([appName, userId, sessionId]);
}

function getRememberedBigQuerySession(
  toolContext?: Context,
): BigQuerySessionInfo | undefined {
  const sessionKey = getSessionKey(toolContext);
  if (sessionKey !== undefined) {
    return bqSessionsByKey.get(sessionKey);
  }
  if (toolContext !== undefined) {
    return bqSessionsByContext.get(toolContext);
  }
  return undefined;
}

function rememberBigQuerySession(
  toolContext: Context | undefined,
  sessionInfo: BigQuerySessionInfo,
): void {
  const sessionKey = getSessionKey(toolContext);
  if (sessionKey !== undefined) {
    if (bqSessionsByKey.has(sessionKey)) {
      bqSessionsByKey.delete(sessionKey);
    }
    bqSessionsByKey.set(sessionKey, sessionInfo);
    if (bqSessionsByKey.size > MAX_REMEMBERED_SESSIONS) {
      const oldestKey = bqSessionsByKey.keys().next().value;
      if (oldestKey !== undefined) {
        bqSessionsByKey.delete(oldestKey);
      }
    }
    return;
  }
  if (toolContext !== undefined) {
    bqSessionsByContext.set(toolContext, sessionInfo);
  }
}

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

  /**
   * Tool execution context used to scope BigQuery sessions in
   * {@link WriteMode.PROTECTED}.
   */
  toolContext?: Context;
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
 * Runs a BigQuery or BigQuery ML SQL query in the specified project and returns
 * up to 50 rows.
 *
 * In read-only mode (when `config.writeMode` is {@link WriteMode.BLOCKED} or
 * omitted), a dry-run check verifies that the query is a SELECT statement before
 * execution. In {@link WriteMode.PROTECTED}, a BigQuery session is created and
 * reused per ADK session, and only SELECT statements or writes targeting that
 * session's anonymous dataset are permitted. When `config.writeMode` is
 * {@link WriteMode.ALLOWED}, all write statements (including DML and DDL) are
 * permitted.
 */
export async function executeSql(
  args: ExecuteSqlArgs,
  toolContext?: Context,
): Promise<ExecuteSqlResult> {
  try {
    const bqClient = getBigQueryClient({
      projectId: args.project_id,
      credentials: args.credentials,
      userAgent: 'execute_sql',
    });

    const effectiveToolContext = toolContext ?? args.toolContext;
    const writeMode = args.config?.writeMode ?? WriteMode.BLOCKED;
    let connectionProperties: BigQueryConnectionProperty[] | undefined;

    if (writeMode === WriteMode.PROTECTED) {
      let bqSessionInfo = getRememberedBigQuerySession(effectiveToolContext);
      if (!bqSessionInfo) {
        const sessionCreatorJob = await bqClient.dryRun({
          query: 'SELECT 1',
          projectId: bqClient.projectId,
          createSession: true,
        });
        const sessionId = sessionCreatorJob.sessionInfo?.sessionId;
        if (!sessionId) {
          return {
            status: 'ERROR',
            error_details: 'BigQuery did not create a session for the query.',
          };
        }
        bqSessionInfo = {
          sessionId,
          datasetId: sessionCreatorJob.destinationTable?.datasetId,
        };
        rememberBigQuerySession(effectiveToolContext, bqSessionInfo);
      }

      connectionProperties = [
        {key: 'session_id', value: bqSessionInfo.sessionId},
      ];

      const dryRunResult = await bqClient.dryRun({
        query: args.query,
        projectId: bqClient.projectId,
        connectionProperties,
      });
      if (
        dryRunResult.statementType !== 'SELECT' &&
        (!bqSessionInfo.datasetId ||
          dryRunResult.destinationTable?.datasetId !== bqSessionInfo.datasetId)
      ) {
        return {
          status: 'ERROR',
          error_details:
            'Protected write mode only supports SELECT statements, or write operations in the anonymous dataset of a BigQuery session.',
        };
      }
    } else if (writeMode !== WriteMode.ALLOWED) {
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

    const queryOptions: BigQueryQueryOptions = {
      query: args.query,
      projectId: bqClient.projectId,
      maxResults: DEFAULT_MAX_QUERY_RESULT_ROWS,
    };
    if (connectionProperties !== undefined) {
      queryOptions.connectionProperties = connectionProperties;
    }

    const rawRows = await bqClient.query(queryOptions);
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
  'Run a BigQuery or BigQuery ML SQL query in the project and return the result. ' +
  "Returns {status: 'SUCCESS', rows}, where each row is an object that maps column names " +
  'to values. At most 50 rows are returned. If the result contains ' +
  'result_is_likely_truncated: true, more rows can match the query than ' +
  'the result contains; use aggregation, filters or LIMIT to get a ' +
  "smaller result. On failure, returns {status: 'ERROR', error_details}.";

const EXECUTE_SQL_WRITE_EXAMPLES =
  '\n\nExamples of write queries:\n' +
  'Create a table with schema prescribed:\n' +
  'CREATE TABLE my_project.my_dataset.my_table (island STRING, population INT64)\n\n' +
  'Insert data into an existing table:\n' +
  "INSERT INTO my_project.my_dataset.my_table (island, population) VALUES ('Dream', 124), ('Biscoe', 168)\n\n" +
  'Create a table from the result of a query:\n' +
  'CREATE TABLE my_project.my_dataset.my_table AS SELECT island, COUNT(*) AS population FROM bigquery-public-data.ml_datasets.penguins GROUP BY island\n\n' +
  'Delete a table:\n' +
  'DROP TABLE my_project.my_dataset.my_table\n\n' +
  'Copy a table to another table:\n' +
  'CREATE TABLE my_project.my_dataset.my_table_clone CLONE my_project.my_dataset.my_table\n\n' +
  'Create a snapshot table:\n' +
  'CREATE SNAPSHOT TABLE my_project.my_dataset.my_table_snapshot CLONE my_project.my_dataset.my_table\n\n' +
  'Create a BigQuery ML linear regression model:\n' +
  "CREATE MODEL `my_dataset.my_model` OPTIONS (model_type='linear_reg', input_label_cols=['body_mass_g']) AS SELECT * FROM `bigquery-public-data.ml_datasets.penguins` WHERE body_mass_g IS NOT NULL\n\n" +
  'Evaluate BigQuery ML model:\n' +
  'SELECT * FROM ML.EVALUATE(MODEL `my_dataset.my_model`)\n\n' +
  'Evaluate BigQuery ML model on custom data:\n' +
  'SELECT * FROM ML.EVALUATE(MODEL `my_dataset.my_model`, (SELECT * FROM `my_dataset.my_table`))\n\n' +
  'Predict using BigQuery ML model:\n' +
  'SELECT * FROM ML.PREDICT(MODEL `my_dataset.my_model`, (SELECT * FROM `my_dataset.my_table`))\n\n' +
  'Delete a BigQuery ML model:\n' +
  'DROP MODEL `my_dataset.my_model`\n\n' +
  'Notes:\n' +
  '- To overwrite an existing table, use CREATE OR REPLACE TABLE or DROP TABLE followed by CREATE TABLE.\n' +
  '- To overwrite an existing model, use CREATE OR REPLACE MODEL or DROP MODEL followed by CREATE MODEL.\n' +
  '- To insert data into a table, use the INSERT INTO statement.';

const EXECUTE_SQL_PROTECTED_WRITE_EXAMPLES =
  '\n\nExamples of protected write queries:\n' +
  'Create a temporary table with schema prescribed:\n' +
  'CREATE TEMP TABLE my_table (island STRING, population INT64)\n\n' +
  'Insert data into an existing temporary table:\n' +
  "INSERT INTO my_table (island, population) VALUES ('Dream', 124), ('Biscoe', 168)\n\n" +
  'Create a temporary table from the result of a query:\n' +
  'CREATE TEMP TABLE my_table AS SELECT island, COUNT(*) AS population FROM bigquery-public-data.ml_datasets.penguins GROUP BY island\n\n' +
  'Delete a temporary table:\n' +
  'DROP TABLE my_table\n\n' +
  'Copy a temporary table to another temporary table:\n' +
  'CREATE TEMP TABLE my_table_clone CLONE my_table\n\n' +
  'Create a temporary BigQuery ML linear regression model:\n' +
  "CREATE TEMP MODEL my_model OPTIONS (model_type='linear_reg', input_label_cols=['body_mass_g']) AS SELECT * FROM `bigquery-public-data.ml_datasets.penguins` WHERE body_mass_g IS NOT NULL\n\n" +
  'Evaluate BigQuery ML model:\n' +
  'SELECT * FROM ML.EVALUATE(MODEL my_model)\n\n' +
  'Evaluate BigQuery ML model on custom data:\n' +
  'SELECT * FROM ML.EVALUATE(MODEL my_model, (SELECT * FROM `my_dataset.my_table`))\n\n' +
  'Predict using BigQuery ML model:\n' +
  'SELECT * FROM ML.PREDICT(MODEL my_model, (SELECT * FROM `my_dataset.my_table`))\n\n' +
  'Delete a BigQuery ML model:\n' +
  'DROP MODEL my_model\n\n' +
  'Notes:\n' +
  '- To overwrite an existing temporary table, use CREATE OR REPLACE TEMP TABLE or DROP TABLE followed by CREATE TEMP TABLE.\n' +
  '- Only temporary tables can be created, inserted into or deleted. Do not try creating a permanent table (non-TEMP table), inserting into or deleting one.\n' +
  '- To overwrite an existing temporary model, use CREATE OR REPLACE TEMP MODEL or DROP MODEL followed by CREATE TEMP MODEL.\n' +
  '- Only temporary models can be created or deleted. Do not try creating a permanent model (non-TEMP model) or deleting one.';

/**
 * Returns the description for the `execute_sql` tool based on the configured write mode.
 */
export function getExecuteSqlDescription(
  config?: BigQueryToolConfig | BigQueryToolConfigOptions,
): string {
  if (config?.writeMode === WriteMode.PROTECTED) {
    return `${EXECUTE_SQL_BASE_DESCRIPTION}${EXECUTE_SQL_PROTECTED_WRITE_EXAMPLES}`;
  }
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
): (args: ExecuteSqlArgs, toolContext?: Context) => Promise<ExecuteSqlResult> {
  const resolvedConfig = config
    ? isBigQueryToolConfig(config)
      ? config
      : new BigQueryToolConfig(config)
    : undefined;
  return async function execute_sql(
    args: ExecuteSqlArgs,
    toolContext?: Context,
  ): Promise<ExecuteSqlResult> {
    return executeSql(
      {
        ...args,
        config: resolvedConfig ?? args.config,
      },
      toolContext,
    );
  };
}
