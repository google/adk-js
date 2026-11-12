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
  BigQueryToolConfig,
  type BigQueryToolConfigOptions,
  isBigQueryToolConfig,
} from './config.js';
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
import {
  executeSqlParameters,
  getExecuteSql,
  getExecuteSqlDescription,
} from './query_tool.js';

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

  /**
   * Optional BigQuery tool configuration (such as write mode) shared across all tools in the toolset.
   */
  toolConfig?: BigQueryToolConfig | BigQueryToolConfigOptions;
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
  toolConfig?: BigQueryToolConfig,
): BaseTool[] {
  return [
    new BigQueryTool({
      name: 'get_dataset_info',
      description:
        'Get metadata information about a BigQuery dataset. Returns an object ' +
        'with the properties of the dataset, such as datasetReference, ' +
        'description, location, creationTime and access. On failure, returns ' +
        "{status: 'ERROR', error_details}.",
      parameters: getDatasetInfoParameters,
      execute: getDatasetInfo,
      credentialsConfig,
      toolConfig,
    }),
    new BigQueryTool({
      name: 'get_table_info',
      description:
        'Get metadata information about a BigQuery table. Returns an object ' +
        'with the properties of the table, such as tableReference, description, schema ' +
        '(the table fields with their name, type and mode), numRows, ' +
        'numBytes, type and location. On failure, returns ' +
        "{status: 'ERROR', error_details}.",
      parameters: getTableInfoParameters,
      execute: getTableInfo,
      credentialsConfig,
      toolConfig,
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
      toolConfig,
    }),
    new BigQueryTool({
      name: 'list_table_ids',
      description:
        'List table ids in a BigQuery dataset. Returns an array of table ' +
        "ids, for example ['chronic_disease_indicators', 'local_data_for_better_health_county_data']. On failure, returns " +
        "{status: 'ERROR', error_details}.",
      parameters: listTableIdsParameters,
      execute: listTableIds,
      credentialsConfig,
      toolConfig,
    }),
    new BigQueryTool({
      name: 'execute_sql',
      description: getExecuteSqlDescription(toolConfig),
      parameters: executeSqlParameters,
      execute: getExecuteSql(toolConfig),
      credentialsConfig,
      toolConfig,
    }),
  ];
}

/**
 * Toolset providing first-party BigQuery metadata and SQL execution tools:
 * `get_dataset_info`, `get_table_info`, `list_dataset_ids`, `list_table_ids`,
 * and `execute_sql`.
 *
 * In default read-only mode, `execute_sql` verifies that queries are SELECT
 * statements before running. Configure `toolConfig` with `writeMode: WriteMode.ALLOWED`
 * to permit DDL and DML write queries.
 */
export class BigQueryToolset extends BaseToolset {
  readonly [BIGQUERY_TOOLSET_SIGNATURE_SYMBOL] = true;

  private readonly credentialsConfig?: BigQueryCredentialsConfig;
  readonly toolConfig: BigQueryToolConfig;

  constructor(options: BigQueryToolsetOptions = {}) {
    super(options.toolFilter);
    this.credentialsConfig = options.credentialsConfig;
    this.toolConfig = options.toolConfig
      ? isBigQueryToolConfig(options.toolConfig)
        ? options.toolConfig
        : new BigQueryToolConfig(options.toolConfig)
      : new BigQueryToolConfig();
  }

  /**
   * Returns the {@link BigQueryTool} instances selected by `toolFilter`.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return createBigQueryTools(this.credentialsConfig, this.toolConfig).filter(
      (tool) => this.isToolSelected(tool, context),
    );
  }

  /**
   * Releases any resources held by the toolset.
   */
  override async close(): Promise<void> {}
}
