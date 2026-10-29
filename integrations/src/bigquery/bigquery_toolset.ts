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
import {BigQueryTool, type BigQueryToolCallable} from './bigquery_tool.js';
import {
  getDatasetInfo,
  getTableInfo,
  listDatasetIds,
  listTableIds,
} from './metadata_tool.js';
import {executeSql} from './query_tool.js';

/**
 * Configuration options for {@link BigQueryToolset}.
 */
export interface BigQueryToolsetOptions {
  /**
   * Optional filter selecting which BigQuery tools to expose: an array of tool
   * names or a {@link ToolPredicate} function. When omitted (`undefined`), all
   * tools in the toolset are exposed; an empty array (`[]`) exposes zero tools.
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

const BIGQUERY_TOOL_FUNCS: readonly BigQueryToolCallable[] = Object.freeze([
  getDatasetInfo,
  getTableInfo,
  listDatasetIds,
  listTableIds,
  executeSql,
]);

/**
 * Toolset providing first-party BigQuery metadata and SQL execution tools:
 * `get_dataset_info`, `get_table_info`, `list_dataset_ids`, `list_table_ids`,
 * and `execute_sql`.
 */
export class BigQueryToolset extends BaseToolset {
  readonly [BIGQUERY_TOOLSET_SIGNATURE_SYMBOL] = true;

  private readonly credentialsConfig?: BigQueryCredentialsConfig;
  private readonly hasExplicitToolFilter: boolean;

  constructor(options: BigQueryToolsetOptions = {}) {
    super(options.toolFilter ?? []);
    this.hasExplicitToolFilter = options.toolFilter !== undefined;
    this.credentialsConfig = options.credentialsConfig;
  }

  /**
   * Returns whether the given tool is selected by the configured `toolFilter`.
   */
  protected override isToolSelected(
    tool: BaseTool,
    context?: ReadonlyContext,
  ): boolean {
    if (!this.hasExplicitToolFilter) {
      return true;
    }

    if (typeof this.toolFilter === 'function') {
      return this.toolFilter(tool, context);
    }

    if (Array.isArray(this.toolFilter)) {
      return this.toolFilter.includes(tool.name);
    }

    return false;
  }

  /**
   * Returns the filtered list of {@link BigQueryTool} instances in this toolset.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const allTools = BIGQUERY_TOOL_FUNCS.map(
      (func) =>
        new BigQueryTool({
          func,
          credentials: this.credentialsConfig,
        }),
    );

    return allTools.filter((tool) => this.isToolSelected(tool, context));
  }

  /**
   * Releases any resources held by the toolset.
   */
  override async close(): Promise<void> {}
}
