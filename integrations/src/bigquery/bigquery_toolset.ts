/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type BaseTool,
  BaseToolset,
  type ReadonlyContext,
  type ToolPredicate,
} from '@google/adk';

import type {BigQueryCredentialsConfig} from './bigquery_credentials.js';
import {BigQueryTool} from './bigquery_tool.js';
import {
  getDatasetInfo,
  getDatasetInfoParameters,
  getTableInfo,
  getTableInfoParameters,
  listDatasetIds,
  listDatasetIdsParameters,
  listTableIds,
  listTableIdsParameters,
} from './metadata_tool.js';
import {executeSql, executeSqlParameters} from './query_tool.js';

/**
 * Configuration options for {@link BigQueryToolset}.
 */
export interface BigQueryToolsetOptions {
  /**
   * Optional filter selecting which BigQuery tools to expose: an array of tool
   * names or a {@link ToolPredicate} function. When omitted or empty, all
   * tools in the toolset are exposed.
   */
  toolFilter?: ToolPredicate | string[];

  /**
   * Optional BigQuery credentials configuration shared across all tools in the toolset.
   */
  credentialsConfig?: BigQueryCredentialsConfig;
}

const BIGQUERY_TOOLSET_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.bigQueryToolset',
);

/**
 * Type guard to check if an object is an instance of {@link BigQueryToolset}.
 */
export function isBigQueryToolset(obj: unknown): obj is BigQueryToolset {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BIGQUERY_TOOLSET_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[BIGQUERY_TOOLSET_SIGNATURE_SYMBOL] === true
  );
}

function createBigQueryTools(
  credentialsConfig?: BigQueryCredentialsConfig,
): BaseTool[] {
  return [
    new BigQueryTool({
      name: 'get_dataset_info',
      description:
        'Get metadata information about a BigQuery dataset. Returns an object ' +
        'with the properties of the dataset, such as datasetReference, ' +
        'location, creationTime and access. On failure, returns ' +
        "{status: 'ERROR', error_details}.",
      parameters: getDatasetInfoParameters,
      execute: getDatasetInfo,
      credentialsConfig,
    }),
    new BigQueryTool({
      name: 'get_table_info',
      description:
        'Get metadata information about a BigQuery table. Returns an object ' +
        'with the properties of the table, such as tableReference, schema ' +
        '(the table fields with their name, type and mode), numRows, ' +
        'numBytes, type and location. On failure, returns ' +
        "{status: 'ERROR', error_details}.",
      parameters: getTableInfoParameters,
      execute: getTableInfo,
      credentialsConfig,
    }),
    new BigQueryTool({
      name: 'list_dataset_ids',
      description:
        'List BigQuery dataset ids in a Google Cloud project. Returns an ' +
        "array of dataset ids, for example ['austin_311', 'baseball']. On " +
        "failure, returns {status: 'ERROR', error_details}.",
      parameters: listDatasetIdsParameters,
      execute: listDatasetIds,
      credentialsConfig,
    }),
    new BigQueryTool({
      name: 'list_table_ids',
      description:
        'List table ids in a BigQuery dataset. Returns an array of table ' +
        "ids, for example ['iris', 'penguins']. On failure, returns " +
        "{status: 'ERROR', error_details}.",
      parameters: listTableIdsParameters,
      execute: listTableIds,
      credentialsConfig,
    }),
    new BigQueryTool({
      name: 'execute_sql',
      description:
        'Run a BigQuery SQL query in the project and return the result. ' +
        "Returns {status: 'SUCCESS', rows}, where each row is an object that maps column names " +
        'to values. At most 50 rows are returned. If the result contains ' +
        'result_is_likely_truncated: true, more rows can match the query than ' +
        'the result contains; use aggregation, filters or LIMIT to get a ' +
        "smaller result. On failure, returns {status: 'ERROR', error_details}.",
      parameters: executeSqlParameters,
      execute: executeSql,
      credentialsConfig,
    }),
  ];
}

/**
 * Toolset providing first-party BigQuery metadata and SQL execution tools:
 * `get_dataset_info`, `get_table_info`, `list_dataset_ids`, `list_table_ids`,
 * and `execute_sql`.
 *
 * `execute_sql` executes any SQL statement permitted by the configured
 * credentials, including DML and DDL statements, without a read-only dry-run
 * check. Grant read-only IAM roles or scopes when write access is not intended.
 */
export class BigQueryToolset extends BaseToolset {
  readonly [BIGQUERY_TOOLSET_SIGNATURE_SYMBOL] = true;

  private readonly credentialsConfig?: BigQueryCredentialsConfig;

  constructor(options: BigQueryToolsetOptions = {}) {
    super(options.toolFilter);
    this.credentialsConfig = options.credentialsConfig;
  }

  /**
   * Returns the {@link BigQueryTool} instances selected by `toolFilter`.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return createBigQueryTools(this.credentialsConfig).filter((tool) =>
      this.isToolSelected(tool, context),
    );
  }

  /**
   * Releases any resources held by the toolset.
   */
  override async close(): Promise<void> {}
}
