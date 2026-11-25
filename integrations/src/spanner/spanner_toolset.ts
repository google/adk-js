/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type BaseTool,
  BaseToolset,
  GoogleTool,
  type ReadonlyContext,
  type ToolPredicate,
} from '@google/adk';

import {
  getTableSchema,
  getTableSchemaParameters,
  listNamedSchemas,
  listNamedSchemasParameters,
  listTableIndexColumns,
  listTableIndexColumnsParameters,
  listTableIndexes,
  listTableIndexesParameters,
  listTableNames,
  listTableNamesParameters,
} from './metadata_tool.js';
import {
  executeSpannerSql,
  executeSpannerSqlParameters,
  getExecuteSpannerSqlDescription,
} from './query_tool.js';
import {
  isSpannerToolSettings,
  SpannerCapabilities,
  SpannerToolSettings,
  type SpannerToolSettingsOptions,
} from './settings.js';
import type {SpannerCredentialsConfig} from './spanner_credentials.js';

/**
 * Default tool name prefix applied by `BaseToolset.getToolsWithPrefix` for
 * {@link SpannerToolset}.
 */
export const DEFAULT_SPANNER_TOOL_NAME_PREFIX = 'spanner';

/**
 * Configuration options for {@link SpannerToolset}.
 */
export interface SpannerToolsetOptions {
  /**
   * Optional filter selecting which Spanner tools to expose: an array of
   * unprefixed tool names or a `ToolPredicate` function. When omitted or empty,
   * all enabled tools in the toolset are exposed.
   */
  toolFilter?: ToolPredicate | readonly string[];

  /**
   * Prefix prepended as `${toolNamePrefix}_` by `getToolsWithPrefix()`.
   * Defaults to {@link DEFAULT_SPANNER_TOOL_NAME_PREFIX} (`'spanner'`).
   */
  toolNamePrefix?: string;

  /**
   * Optional Spanner credentials configuration shared across all tools in the
   * toolset.
   */
  credentialsConfig?: SpannerCredentialsConfig;

  /**
   * Optional Spanner tool settings controlling capabilities and query row
   * limits.
   */
  spannerToolSettings?: SpannerToolSettings | SpannerToolSettingsOptions;
}

const SPANNER_TOOLSET_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.spannerToolset',
);

/**
 * Type guard checking whether a value is an instance of {@link SpannerToolset}.
 */
export function isSpannerToolset(obj: unknown): obj is SpannerToolset {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    SPANNER_TOOLSET_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[SPANNER_TOOLSET_SIGNATURE_SYMBOL] === true
  );
}

function createSpannerTools(
  credentialsConfig: SpannerCredentialsConfig | undefined,
  toolSettings: SpannerToolSettings,
): BaseTool[] {
  const tools: BaseTool[] = [
    new GoogleTool({
      name: 'list_table_names',
      description:
        'List tables within the Spanner database. Returns ' +
        "{status: 'SUCCESS', results: [...]} with the table names. On failure, " +
        "returns {status: 'ERROR', error_details}.",
      parameters: listTableNamesParameters,
      execute: listTableNames,
      credentialsConfig,
      toolSettings,
    }),
    new GoogleTool({
      name: 'list_table_indexes',
      description:
        'Get index information about a Spanner table. Returns ' +
        "{status: 'SUCCESS', results: [...]} with index metadata objects. On " +
        "failure, returns {status: 'ERROR', error_details}.",
      parameters: listTableIndexesParameters,
      execute: listTableIndexes,
      credentialsConfig,
      toolSettings,
    }),
    new GoogleTool({
      name: 'list_table_index_columns',
      description:
        'Get the columns in each index of a Spanner table. Returns ' +
        "{status: 'SUCCESS', results: [...]} with index column metadata objects. " +
        "On failure, returns {status: 'ERROR', error_details}.",
      parameters: listTableIndexColumnsParameters,
      execute: listTableIndexColumns,
      credentialsConfig,
      toolSettings,
    }),
    new GoogleTool({
      name: 'list_named_schemas',
      description:
        'Get the named schemas in the Spanner database. Returns ' +
        "{status: 'SUCCESS', results: [...]} with the schema names. On failure, " +
        "returns {status: 'ERROR', error_details}.",
      parameters: listNamedSchemasParameters,
      execute: listNamedSchemas,
      credentialsConfig,
      toolSettings,
    }),
    new GoogleTool({
      name: 'get_table_schema',
      description:
        'Get schema and metadata information about a Spanner table. Returns ' +
        "{status: 'SUCCESS', results: {schema, metadata}}. On failure, returns " +
        "{status: 'ERROR', error_details}.",
      parameters: getTableSchemaParameters,
      execute: getTableSchema,
      credentialsConfig,
      toolSettings,
    }),
  ];

  if (toolSettings.capabilities.includes(SpannerCapabilities.DATA_READ)) {
    tools.push(
      new GoogleTool({
        name: 'execute_sql',
        description: getExecuteSpannerSqlDescription(toolSettings),
        parameters: executeSpannerSqlParameters,
        execute: executeSpannerSql,
        credentialsConfig,
        toolSettings,
      }),
    );
  }

  return tools;
}

function cloneToolFilter(
  toolFilter?: ToolPredicate | readonly string[],
): ToolPredicate | string[] | undefined {
  if (toolFilter === undefined || typeof toolFilter === 'function') {
    return toolFilter;
  }
  return [...toolFilter];
}

/**
 * Toolset providing first-party Cloud Spanner schema inspection and read-only
 * SQL query tools: `list_table_names`, `list_table_indexes`,
 * `list_table_index_columns`, `list_named_schemas`, `get_table_schema`, and
 * `execute_sql`.
 */
export class SpannerToolset extends BaseToolset {
  readonly [SPANNER_TOOLSET_SIGNATURE_SYMBOL] = true;

  private readonly credentialsConfig?: SpannerCredentialsConfig;
  readonly toolSettings: SpannerToolSettings;

  constructor(options: SpannerToolsetOptions = {}) {
    super({
      toolFilter: cloneToolFilter(options.toolFilter),
      toolNamePrefix:
        options.toolNamePrefix ?? DEFAULT_SPANNER_TOOL_NAME_PREFIX,
    });
    this.credentialsConfig = options.credentialsConfig;
    this.toolSettings = options.spannerToolSettings
      ? isSpannerToolSettings(options.spannerToolSettings)
        ? options.spannerToolSettings
        : new SpannerToolSettings(options.spannerToolSettings)
      : new SpannerToolSettings();
  }

  /**
   * Returns the unprefixed `GoogleTool` instances selected by `toolFilter`.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return createSpannerTools(this.credentialsConfig, this.toolSettings).filter(
      (tool) => this.isToolSelected(tool, context),
    );
  }

  /**
   * Releases any resources held by the toolset.
   */
  override async close(): Promise<void> {}
}
