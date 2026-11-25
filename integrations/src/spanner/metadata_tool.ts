/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GoogleCredentials} from '@google/adk';
import {inspect} from 'node:util';
import {z} from 'zod';

import {getSpannerClient} from './client.js';
import type {
  SpannerToolSettings,
  SpannerToolSettingsOptions,
} from './settings.js';
import {
  type SpannerToolErrorResult,
  toSpannerToolErrorResult,
} from './tool_error.js';

const POSTGRES_UNSUPPORTED_ERROR = 'PostgreSQL dialect is not supported.';

function serializeOrInspect<T>(value: T): T | string {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return inspect(value, {depth: null});
  }
}

/**
 * Zod parameter schema for {@link listTableNames}.
 */
export const listTableNamesParameters = z.object({
  project_id: z.string().describe('The Google Cloud project id.'),
  instance_id: z.string().describe('The Spanner instance id.'),
  database_id: z.string().describe('The Spanner database id.'),
  named_schema: z
    .string()
    .optional()
    .describe(
      'The named schema to list tables in. Defaults to empty string "" to search for tables in the default schema of the database.',
    ),
});

/**
 * Arguments accepted by {@link listTableNames}.
 */
export interface ListTableNamesArgs {
  /**
   * Google Cloud project ID. Falls back to `GOOGLE_CLOUD_PROJECT` when omitted
   * or empty.
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
   * Optional named schema. Defaults to `""` on GoogleSQL and `"public"` on
   * PostgreSQL.
   */
  named_schema?: string;

  /**
   * Credentials injected by `GoogleTool`.
   */
  credentials?: GoogleCredentials;

  /**
   * Tool settings injected by `GoogleTool`.
   */
  settings?: SpannerToolSettings | SpannerToolSettingsOptions;
}

/**
 * Successful result returned by {@link listTableNames}.
 */
export interface ListTableNamesSuccessResult {
  status: 'SUCCESS';
  results: string[];
}

/**
 * Result returned by {@link listTableNames}.
 */
export type ListTableNamesResult =
  ListTableNamesSuccessResult | SpannerToolErrorResult;

/**
 * Zod parameter schema for {@link getTableSchema}.
 */
export const getTableSchemaParameters = z.object({
  project_id: z.string().describe('The Google Cloud project id.'),
  instance_id: z.string().describe('The Spanner instance id.'),
  database_id: z.string().describe('The Spanner database id.'),
  table_name: z.string().describe('The Spanner table name.'),
  named_schema: z
    .string()
    .optional()
    .describe(
      'The named schema containing the table. Defaults to empty string "" to search in the default schema of the database.',
    ),
});

/**
 * Arguments accepted by {@link getTableSchema}.
 */
export interface GetTableSchemaArgs {
  /**
   * Google Cloud project ID. Falls back to `GOOGLE_CLOUD_PROJECT` when omitted
   * or empty.
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
   * Cloud Spanner table name.
   */
  table_name: string;

  /**
   * Optional named schema. Defaults to `""`.
   */
  named_schema?: string;

  /**
   * Credentials injected by `GoogleTool`.
   */
  credentials?: GoogleCredentials;

  /**
   * Tool settings injected by `GoogleTool`.
   */
  settings?: SpannerToolSettings | SpannerToolSettingsOptions;
}

/**
 * Key constraint metadata entry attached to a column in {@link SpannerColumnSchema}.
 */
export interface SpannerKeyColumnUsage {
  CONSTRAINT_NAME: unknown;
  ORDINAL_POSITION: unknown;
  POSITION_IN_UNIQUE_CONSTRAINT: unknown;
}

/**
 * Column schema details returned by {@link getTableSchema}.
 */
export interface SpannerColumnSchema {
  SPANNER_TYPE: unknown;
  TABLE_SCHEMA: unknown;
  ORDINAL_POSITION: unknown;
  COLUMN_DEFAULT: unknown;
  IS_NULLABLE: unknown;
  IS_GENERATED: unknown;
  GENERATION_EXPRESSION: unknown;
  IS_STORED: unknown;
  KEY_COLUMN_USAGE?: SpannerKeyColumnUsage[];
}

/**
 * Table-level metadata returned by {@link getTableSchema}.
 */
export interface SpannerTableMetadata {
  TABLE_SCHEMA: unknown;
  TABLE_NAME: unknown;
  TABLE_TYPE: unknown;
  PARENT_TABLE_NAME: unknown;
  ON_DELETE_ACTION: unknown;
  SPANNER_STATE: unknown;
  INTERLEAVE_TYPE: unknown;
  ROW_DELETION_POLICY_EXPRESSION: unknown;
}

/**
 * Schema and metadata payload returned by {@link getTableSchema}.
 */
export interface SpannerTableSchemaDetails {
  schema: Record<string, SpannerColumnSchema>;
  metadata: SpannerTableMetadata[];
}

/**
 * Successful result returned by {@link getTableSchema}.
 */
export interface GetTableSchemaSuccessResult {
  status: 'SUCCESS';
  results: SpannerTableSchemaDetails | string;
}

/**
 * Result returned by {@link getTableSchema}.
 */
export type GetTableSchemaResult =
  GetTableSchemaSuccessResult | SpannerToolErrorResult;

/**
 * Zod parameter schema for {@link listTableIndexes}.
 */
export const listTableIndexesParameters = z.object({
  project_id: z.string().describe('The Google Cloud project id.'),
  instance_id: z.string().describe('The Spanner instance id.'),
  database_id: z.string().describe('The Spanner database id.'),
  table_id: z.string().describe('The Spanner table id.'),
});

/**
 * Arguments accepted by {@link listTableIndexes}.
 */
export interface ListTableIndexesArgs {
  /**
   * Google Cloud project ID. Falls back to `GOOGLE_CLOUD_PROJECT` when omitted
   * or empty.
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
   * Cloud Spanner table ID.
   */
  table_id: string;

  /**
   * Credentials injected by `GoogleTool`.
   */
  credentials?: GoogleCredentials;

  /**
   * Tool settings injected by `GoogleTool`.
   */
  settings?: SpannerToolSettings | SpannerToolSettingsOptions;
}

/**
 * Index entry returned by {@link listTableIndexes}.
 */
export interface SpannerTableIndex {
  INDEX_NAME: unknown;
  TABLE_SCHEMA: unknown;
  INDEX_TYPE: unknown;
  PARENT_TABLE_NAME: unknown;
  IS_UNIQUE: unknown;
  IS_NULL_FILTERED: unknown;
  INDEX_STATE: unknown;
}

/**
 * Successful result returned by {@link listTableIndexes}.
 */
export interface ListTableIndexesSuccessResult {
  status: 'SUCCESS';
  results: Array<SpannerTableIndex | string>;
}

/**
 * Result returned by {@link listTableIndexes}.
 */
export type ListTableIndexesResult =
  ListTableIndexesSuccessResult | SpannerToolErrorResult;

/**
 * Zod parameter schema for {@link listTableIndexColumns}.
 */
export const listTableIndexColumnsParameters = z.object({
  project_id: z.string().describe('The Google Cloud project id.'),
  instance_id: z.string().describe('The Spanner instance id.'),
  database_id: z.string().describe('The Spanner database id.'),
  table_id: z.string().describe('The Spanner table id.'),
});

/**
 * Arguments accepted by {@link listTableIndexColumns}.
 */
export type ListTableIndexColumnsArgs = ListTableIndexesArgs;

/**
 * Index column entry returned by {@link listTableIndexColumns}.
 */
export interface SpannerTableIndexColumn {
  INDEX_NAME: unknown;
  TABLE_SCHEMA: unknown;
  COLUMN_NAME: unknown;
  ORDINAL_POSITION: unknown;
  IS_NULLABLE: unknown;
  SPANNER_TYPE: unknown;
}

/**
 * Successful result returned by {@link listTableIndexColumns}.
 */
export interface ListTableIndexColumnsSuccessResult {
  status: 'SUCCESS';
  results: Array<SpannerTableIndexColumn | string>;
}

/**
 * Result returned by {@link listTableIndexColumns}.
 */
export type ListTableIndexColumnsResult =
  ListTableIndexColumnsSuccessResult | SpannerToolErrorResult;

/**
 * Zod parameter schema for {@link listNamedSchemas}.
 */
export const listNamedSchemasParameters = z.object({
  project_id: z.string().describe('The Google Cloud project id.'),
  instance_id: z.string().describe('The Spanner instance id.'),
  database_id: z.string().describe('The Spanner database id.'),
});

/**
 * Arguments accepted by {@link listNamedSchemas}.
 */
export interface ListNamedSchemasArgs {
  /**
   * Google Cloud project ID. Falls back to `GOOGLE_CLOUD_PROJECT` when omitted
   * or empty.
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
   * Credentials injected by `GoogleTool`.
   */
  credentials?: GoogleCredentials;

  /**
   * Tool settings injected by `GoogleTool`.
   */
  settings?: SpannerToolSettings | SpannerToolSettingsOptions;
}

/**
 * Successful result returned by {@link listNamedSchemas}.
 */
export interface ListNamedSchemasSuccessResult {
  status: 'SUCCESS';
  results: string[];
}

/**
 * Result returned by {@link listNamedSchemas}.
 */
export type ListNamedSchemasResult =
  ListNamedSchemasSuccessResult | SpannerToolErrorResult;

/**
 * Lists table names within a Cloud Spanner database.
 */
export async function listTableNames(
  args: ListTableNamesArgs,
): Promise<ListTableNamesResult> {
  try {
    const spannerClient = getSpannerClient({
      projectId: args.project_id,
      credentials: args.credentials,
    });
    return await spannerClient.withDatabase(
      {instanceId: args.instance_id, databaseId: args.database_id},
      async (db) => {
        const dialect = await db.getDialect();
        const isPostgres = dialect === 'POSTGRESQL';
        const namedSchema =
          args.named_schema !== undefined && args.named_schema.length > 0
            ? args.named_schema
            : isPostgres
              ? 'public'
              : '';
        const rows = isPostgres
          ? await db.runQuery({
              sql: 'SELECT table_name AS TABLE_NAME FROM information_schema.tables WHERE table_schema = $1',
              params: {p1: namedSchema},
              types: {p1: 'string'},
              columns: ['TABLE_NAME'],
            })
          : await db.runQuery({
              sql: "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_CATALOG = '' AND TABLE_SCHEMA = @named_schema AND SPANNER_STATE = 'COMMITTED'",
              params: {named_schema: namedSchema},
              types: {named_schema: 'string'},
              columns: ['TABLE_NAME'],
            });
        return {
          status: 'SUCCESS',
          results: rows.map((row) => String(row[0])),
        };
      },
    );
  } catch (error: unknown) {
    return toSpannerToolErrorResult(error);
  }
}

const COLUMNS_QUERY = `
  SELECT
    COLUMN_NAME,
    TABLE_SCHEMA,
    SPANNER_TYPE,
    ORDINAL_POSITION,
    COLUMN_DEFAULT,
    IS_NULLABLE,
    IS_GENERATED,
    GENERATION_EXPRESSION,
    IS_STORED
  FROM
    INFORMATION_SCHEMA.COLUMNS
  WHERE
    TABLE_NAME = @table_name
    AND TABLE_SCHEMA = @named_schema
  ORDER BY
    ORDINAL_POSITION
`;

const KEY_COLUMN_USAGE_QUERY = `
  SELECT
    COLUMN_NAME,
    CONSTRAINT_NAME,
    ORDINAL_POSITION,
    POSITION_IN_UNIQUE_CONSTRAINT
  FROM
    INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE
    TABLE_NAME = @table_name
    AND TABLE_SCHEMA = @named_schema
`;

const TABLE_METADATA_QUERY = `
  SELECT
    TABLE_SCHEMA,
    TABLE_NAME,
    TABLE_TYPE,
    PARENT_TABLE_NAME,
    ON_DELETE_ACTION,
    SPANNER_STATE,
    INTERLEAVE_TYPE,
    ROW_DELETION_POLICY_EXPRESSION
  FROM
    INFORMATION_SCHEMA.TABLES
  WHERE
    TABLE_NAME = @table_name
    AND TABLE_SCHEMA = @named_schema
`;

const COLUMNS_QUERY_FIELDS = [
  'COLUMN_NAME',
  'TABLE_SCHEMA',
  'SPANNER_TYPE',
  'ORDINAL_POSITION',
  'COLUMN_DEFAULT',
  'IS_NULLABLE',
  'IS_GENERATED',
  'GENERATION_EXPRESSION',
  'IS_STORED',
] as const;

const KEY_COLUMN_USAGE_FIELDS = [
  'COLUMN_NAME',
  'CONSTRAINT_NAME',
  'ORDINAL_POSITION',
  'POSITION_IN_UNIQUE_CONSTRAINT',
] as const;

const TABLE_METADATA_FIELDS = [
  'TABLE_SCHEMA',
  'TABLE_NAME',
  'TABLE_TYPE',
  'PARENT_TABLE_NAME',
  'ON_DELETE_ACTION',
  'SPANNER_STATE',
  'INTERLEAVE_TYPE',
  'ROW_DELETION_POLICY_EXPRESSION',
] as const;

/**
 * Gets column schema and table metadata for a Cloud Spanner table.
 */
export async function getTableSchema(
  args: GetTableSchemaArgs,
): Promise<GetTableSchemaResult> {
  try {
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
            error_details: POSTGRES_UNSUPPORTED_ERROR,
          };
        }

        const params = {
          table_name: args.table_name,
          named_schema: args.named_schema ?? '',
        };
        const types = {
          table_name: 'string',
          named_schema: 'string',
        };

        const schema: Record<string, SpannerColumnSchema> = {};
        const metadata: SpannerTableMetadata[] = [];

        await db.withSnapshot(async (snapshot) => {
          const columnRows = await snapshot.runQuery({
            sql: COLUMNS_QUERY,
            params,
            types,
            columns: COLUMNS_QUERY_FIELDS,
          });
          for (const row of columnRows) {
            const columnName = String(row[0]);
            const columnMetadata: SpannerColumnSchema = {
              SPANNER_TYPE: row[2],
              TABLE_SCHEMA: row[1],
              ORDINAL_POSITION: row[3],
              COLUMN_DEFAULT: row[4],
              IS_NULLABLE: row[5],
              IS_GENERATED: row[6],
              GENERATION_EXPRESSION: row[7],
              IS_STORED: row[8],
            };
            Object.defineProperty(schema, columnName, {
              value: columnMetadata,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }

          const keyColumnRows = await snapshot.runQuery({
            sql: KEY_COLUMN_USAGE_QUERY,
            params,
            types,
            columns: KEY_COLUMN_USAGE_FIELDS,
          });
          for (const row of keyColumnRows) {
            const columnName = String(row[0]);
            if (Object.hasOwn(schema, columnName)) {
              const columnEntry = schema[columnName];
              columnEntry.KEY_COLUMN_USAGE ??= [];
              columnEntry.KEY_COLUMN_USAGE.push({
                CONSTRAINT_NAME: row[1],
                ORDINAL_POSITION: row[2],
                POSITION_IN_UNIQUE_CONSTRAINT: row[3],
              });
            }
          }

          const metadataRows = await snapshot.runQuery({
            sql: TABLE_METADATA_QUERY,
            params,
            types,
            columns: TABLE_METADATA_FIELDS,
          });
          for (const row of metadataRows) {
            metadata.push({
              TABLE_SCHEMA: row[0],
              TABLE_NAME: row[1],
              TABLE_TYPE: row[2],
              PARENT_TABLE_NAME: row[3],
              ON_DELETE_ACTION: row[4],
              SPANNER_STATE: row[5],
              INTERLEAVE_TYPE: row[6],
              ROW_DELETION_POLICY_EXPRESSION: row[7],
            });
          }
        });

        return {
          status: 'SUCCESS',
          results: serializeOrInspect({schema, metadata}),
        };
      },
    );
  } catch (error: unknown) {
    return toSpannerToolErrorResult(error);
  }
}

const INDEXES_QUERY =
  'SELECT INDEX_NAME, TABLE_SCHEMA, INDEX_TYPE, ' +
  'PARENT_TABLE_NAME, IS_UNIQUE, IS_NULL_FILTERED, INDEX_STATE ' +
  'FROM INFORMATION_SCHEMA.INDEXES ' +
  'WHERE TABLE_NAME = @table_id';

const INDEXES_FIELDS = [
  'INDEX_NAME',
  'TABLE_SCHEMA',
  'INDEX_TYPE',
  'PARENT_TABLE_NAME',
  'IS_UNIQUE',
  'IS_NULL_FILTERED',
  'INDEX_STATE',
] as const;

/**
 * Lists index information for a Cloud Spanner table.
 */
export async function listTableIndexes(
  args: ListTableIndexesArgs,
): Promise<ListTableIndexesResult> {
  try {
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
            error_details: POSTGRES_UNSUPPORTED_ERROR,
          };
        }

        const rows = await db.runQuery({
          sql: INDEXES_QUERY,
          params: {table_id: args.table_id},
          types: {table_id: 'string'},
          columns: INDEXES_FIELDS,
        });

        const indexes: Array<SpannerTableIndex | string> = rows.map((row) =>
          serializeOrInspect({
            INDEX_NAME: row[0],
            TABLE_SCHEMA: row[1],
            INDEX_TYPE: row[2],
            PARENT_TABLE_NAME: row[3],
            IS_UNIQUE: row[4],
            IS_NULL_FILTERED: row[5],
            INDEX_STATE: row[6],
          }),
        );

        return {status: 'SUCCESS', results: indexes};
      },
    );
  } catch (error: unknown) {
    return toSpannerToolErrorResult(error);
  }
}

const INDEX_COLUMNS_QUERY =
  'SELECT INDEX_NAME, TABLE_SCHEMA, COLUMN_NAME, ' +
  'ORDINAL_POSITION, IS_NULLABLE, SPANNER_TYPE ' +
  'FROM INFORMATION_SCHEMA.INDEX_COLUMNS ' +
  'WHERE TABLE_NAME = @table_id';

const INDEX_COLUMNS_FIELDS = [
  'INDEX_NAME',
  'TABLE_SCHEMA',
  'COLUMN_NAME',
  'ORDINAL_POSITION',
  'IS_NULLABLE',
  'SPANNER_TYPE',
] as const;

/**
 * Lists columns in each index of a Cloud Spanner table.
 */
export async function listTableIndexColumns(
  args: ListTableIndexColumnsArgs,
): Promise<ListTableIndexColumnsResult> {
  try {
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
            error_details: POSTGRES_UNSUPPORTED_ERROR,
          };
        }

        const rows = await db.runQuery({
          sql: INDEX_COLUMNS_QUERY,
          params: {table_id: args.table_id},
          types: {table_id: 'string'},
          columns: INDEX_COLUMNS_FIELDS,
        });

        const indexColumns: Array<SpannerTableIndexColumn | string> = rows.map(
          (row) =>
            serializeOrInspect({
              INDEX_NAME: row[0],
              TABLE_SCHEMA: row[1],
              COLUMN_NAME: row[2],
              ORDINAL_POSITION: row[3],
              IS_NULLABLE: row[4],
              SPANNER_TYPE: row[5],
            }),
        );

        return {status: 'SUCCESS', results: indexColumns};
      },
    );
  } catch (error: unknown) {
    return toSpannerToolErrorResult(error);
  }
}

const NAMED_SCHEMAS_QUERY = `
  SELECT
    SCHEMA_NAME
  FROM
    INFORMATION_SCHEMA.SCHEMATA
  WHERE
    SCHEMA_NAME NOT IN ('', 'INFORMATION_SCHEMA', 'SPANNER_SYS')
`;

/**
 * Lists named schemas in a Cloud Spanner database.
 */
export async function listNamedSchemas(
  args: ListNamedSchemasArgs,
): Promise<ListNamedSchemasResult> {
  try {
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
            error_details: POSTGRES_UNSUPPORTED_ERROR,
          };
        }

        const rows = await db.runQuery({
          sql: NAMED_SCHEMAS_QUERY,
          columns: ['SCHEMA_NAME'],
        });

        return {
          status: 'SUCCESS',
          results: rows.map((row) => String(row[0])),
        };
      },
    );
  } catch (error: unknown) {
    return toSpannerToolErrorResult(error);
  }
}
