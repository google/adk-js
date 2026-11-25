/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GoogleOAuthCredentials} from '@google/adk';
import {
  getTableSchema,
  type GetTableSchemaArgs,
  getTableSchemaParameters,
  type GetTableSchemaResult,
  type GetTableSchemaSuccessResult,
  listNamedSchemas,
  type ListNamedSchemasArgs,
  listNamedSchemasParameters,
  type ListNamedSchemasResult,
  type ListNamedSchemasSuccessResult,
  listTableIndexColumns,
  type ListTableIndexColumnsArgs,
  listTableIndexColumnsParameters,
  type ListTableIndexColumnsResult,
  type ListTableIndexColumnsSuccessResult,
  listTableIndexes,
  type ListTableIndexesArgs,
  listTableIndexesParameters,
  type ListTableIndexesResult,
  type ListTableIndexesSuccessResult,
  listTableNames,
  type ListTableNamesArgs,
  listTableNamesParameters,
  type ListTableNamesResult,
  type ListTableNamesSuccessResult,
  type SpannerColumnSchema,
  type SpannerDatabaseDialect,
  type SpannerKeyColumnUsage,
  type SpannerTableIndex,
  type SpannerTableIndexColumn,
  type SpannerTableMetadata,
  type SpannerTableSchemaDetails,
  type SpannerToolErrorResult,
} from '@google/adk-integrations';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

interface QueryCall {
  sql: string;
  params?: Record<string, unknown>;
  types?: Record<string, string>;
}

interface FakeSpannerBehavior {
  dialect?: SpannerDatabaseDialect;
  dialectError?: Error;
  instanceError?: Error;
  snapshotError?: Error;
  runHandler?: (query: QueryCall) => unknown[] | Promise<unknown[]>;
}

interface MetadataTestState {
  behavior: FakeSpannerBehavior;
  capturedClientOptions: Array<Record<string, unknown>>;
  capturedQueries: QueryCall[];
  snapshotEndSpy: Mock<() => void>;
  databaseCloseSpy: Mock<() => void>;
  clientCloseSpy: Mock<() => void>;
}

const state: MetadataTestState = {
  behavior: {},
  capturedClientOptions: [],
  capturedQueries: [],
  snapshotEndSpy: vi.fn(() => {}),
  databaseCloseSpy: vi.fn(() => {}),
  clientCloseSpy: vi.fn(() => {}),
};

vi.mock('@google-cloud/spanner', () => ({
  Spanner: class {
    constructor(options: Record<string, unknown>) {
      state.capturedClientOptions.push(options);
      return {
        instance: () => {
          if (state.behavior.instanceError) {
            throw state.behavior.instanceError;
          }
          return {
            database: () => ({
              getDatabaseDialect: async () => {
                if (state.behavior.dialectError) {
                  throw state.behavior.dialectError;
                }
                return state.behavior.dialect ?? 'GOOGLE_STANDARD_SQL';
              },
              getSnapshot: async () => {
                if (state.behavior.snapshotError) {
                  throw state.behavior.snapshotError;
                }
                return [
                  {
                    run: async (query: QueryCall) => {
                      state.capturedQueries.push(query);
                      const rows = state.behavior.runHandler
                        ? await state.behavior.runHandler(query)
                        : [];
                      return [rows];
                    },
                    end: () => {
                      state.snapshotEndSpy();
                    },
                  },
                ];
              },
              close: async () => {
                state.databaseCloseSpy();
              },
            }),
          };
        },
        close: async () => {
          state.clientCloseSpy();
        },
      };
    }
  },
}));

const testCredentials: GoogleOAuthCredentials = {
  token: 'test-spanner-token',
  valid: true,
};

const baseTarget = {
  project_id: 'test-project',
  instance_id: 'test-instance',
  database_id: 'test-database',
  credentials: testCredentials,
};

describe('Spanner metadata tools', () => {
  beforeEach(() => {
    state.behavior = {};
    state.capturedClientOptions = [];
    state.capturedQueries = [];
    state.snapshotEndSpy.mockClear();
    state.databaseCloseSpy.mockClear();
    state.clientCloseSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('validates parameter schemas for all five metadata tools', () => {
    expect(
      listTableNamesParameters.parse({
        project_id: 'p',
        instance_id: 'i',
        database_id: 'd',
      }),
    ).toEqual({project_id: 'p', instance_id: 'i', database_id: 'd'});
    expect(
      getTableSchemaParameters.parse({
        project_id: 'p',
        instance_id: 'i',
        database_id: 'd',
        table_name: 'Singers',
      }),
    ).toEqual({
      project_id: 'p',
      instance_id: 'i',
      database_id: 'd',
      table_name: 'Singers',
    });
    expect(
      listTableIndexesParameters.parse({
        project_id: 'p',
        instance_id: 'i',
        database_id: 'd',
        table_id: 'Singers',
      }),
    ).toEqual({
      project_id: 'p',
      instance_id: 'i',
      database_id: 'd',
      table_id: 'Singers',
    });
    expect(
      listTableIndexColumnsParameters.parse({
        project_id: 'p',
        instance_id: 'i',
        database_id: 'd',
        table_id: 'Singers',
      }),
    ).toEqual({
      project_id: 'p',
      instance_id: 'i',
      database_id: 'd',
      table_id: 'Singers',
    });
    expect(
      listNamedSchemasParameters.parse({
        project_id: 'p',
        instance_id: 'i',
        database_id: 'd',
      }),
    ).toEqual({project_id: 'p', instance_id: 'i', database_id: 'd'});
    expect(listTableNamesParameters.shape.named_schema.description).toBe(
      'The named schema to list tables in. Defaults to empty string "" to search for tables in the default schema of the database.',
    );
    expect(getTableSchemaParameters.shape.named_schema.description).toBe(
      'The named schema containing the table. Defaults to empty string "" to search in the default schema of the database.',
    );
  });

  describe('listTableNames', () => {
    it('queries INFORMATION_SCHEMA.TABLES with default empty schema for GoogleSQL', async () => {
      state.behavior = {
        dialect: 'GOOGLE_STANDARD_SQL',
        runHandler: () => [['Singers'], ['Albums']],
      };

      const args: ListTableNamesArgs = baseTarget;
      const result: ListTableNamesResult = await listTableNames(args);
      const expected: ListTableNamesSuccessResult = {
        status: 'SUCCESS',
        results: ['Singers', 'Albums'],
      };

      expect(result).toEqual(expected);
      expect(state.capturedQueries).toEqual([
        {
          sql: "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_CATALOG = '' AND TABLE_SCHEMA = @named_schema AND SPANNER_STATE = 'COMMITTED'",
          params: {named_schema: ''},
          types: {named_schema: 'string'},
        },
      ]);
      expect(state.snapshotEndSpy).toHaveBeenCalledOnce();
      expect(state.databaseCloseSpy).toHaveBeenCalledOnce();
      expect(state.clientCloseSpy).toHaveBeenCalledOnce();
    });

    it('passes explicit named_schema for GoogleSQL', async () => {
      state.behavior = {
        dialect: 'GOOGLE_STANDARD_SQL',
        runHandler: () => [['CustomTable']],
      };

      const result = await listTableNames({
        ...baseTarget,
        named_schema: 'customSchema',
      });

      expect(result).toEqual({status: 'SUCCESS', results: ['CustomTable']});
      expect(state.capturedQueries[0]?.params).toEqual({
        named_schema: 'customSchema',
      });
    });

    it('uses public default schema and positional $1 parameter for PostgreSQL', async () => {
      state.behavior = {
        dialect: 'POSTGRESQL',
        runHandler: () => [[{name: 'table_name', value: 'pgSingers'}]],
      };

      const result = await listTableNames(baseTarget);

      expect(result).toEqual({status: 'SUCCESS', results: ['pgSingers']});
      expect(state.capturedQueries).toEqual([
        {
          sql: 'SELECT table_name AS TABLE_NAME FROM information_schema.tables WHERE table_schema = $1',
          params: {p1: 'public'},
          types: {p1: 'string'},
        },
      ]);
    });

    it('returns structured error and still closes client when SDK call fails', async () => {
      state.behavior = {
        instanceError: new Error('Request failed'),
      };

      const result: ListTableNamesResult = await listTableNames(baseTarget);
      const expectedError: SpannerToolErrorResult = {
        status: 'ERROR',
        error_details: 'Request failed',
      };

      expect(result).toEqual(expectedError);
      expect(state.databaseCloseSpy).not.toHaveBeenCalled();
      expect(state.clientCloseSpy).toHaveBeenCalledOnce();
    });

    it('formats plain error objects and string throws cleanly on failure', async () => {
      state.behavior = {
        runHandler: () => {
          throw {code: 7, details: 'Permission denied'};
        },
      };
      const objectErr = await listTableNames(baseTarget);
      expect(objectErr).toEqual({
        status: 'ERROR',
        error_details: '{"code":7,"details":"Permission denied"}',
      });

      state.behavior = {
        runHandler: () => {
          throw 'Direct failure string';
        },
      };
      const stringErr = await listTableNames(baseTarget);
      expect(stringErr).toEqual({
        status: 'ERROR',
        error_details: 'Direct failure string',
      });

      const cyclicError: Record<string, unknown> = {};
      cyclicError['cycle'] = cyclicError;
      state.behavior = {
        runHandler: () => {
          throw cyclicError;
        },
      };
      const cyclicResult = await listTableNames(baseTarget);
      expect(cyclicResult.status).toBe('ERROR');
    });
  });

  describe('getTableSchema', () => {
    it('returns schema with KEY_COLUMN_USAGE array and table metadata in a single snapshot', async () => {
      let queryCall = 0;
      state.behavior = {
        dialect: 'GOOGLE_STANDARD_SQL',
        runHandler: () => {
          queryCall += 1;
          if (queryCall === 1) {
            return [
              ['col1', '', 'STRING(MAX)', 1, null, 'NO', 'NEVER', null, null],
            ];
          }
          if (queryCall === 2) {
            return [
              ['col1', 'PK_Table', 1, null],
              ['col1', 'FK_Other', 1, 1],
            ];
          }
          return [
            [
              '',
              'testTable',
              'BASE TABLE',
              null,
              null,
              'COMMITTED',
              null,
              'OLDER_THAN(CreatedAt, INTERVAL 1 DAY)',
            ],
          ];
        },
      };

      const schemaArgs: GetTableSchemaArgs = {
        ...baseTarget,
        table_name: 'testTable',
      };
      const result: GetTableSchemaResult = await getTableSchema(schemaArgs);

      const expectedKeyUsage: SpannerKeyColumnUsage[] = [
        {
          CONSTRAINT_NAME: 'PK_Table',
          ORDINAL_POSITION: 1,
          POSITION_IN_UNIQUE_CONSTRAINT: null,
        },
        {
          CONSTRAINT_NAME: 'FK_Other',
          ORDINAL_POSITION: 1,
          POSITION_IN_UNIQUE_CONSTRAINT: 1,
        },
      ];
      const expectedColumn: SpannerColumnSchema = {
        SPANNER_TYPE: 'STRING(MAX)',
        TABLE_SCHEMA: '',
        ORDINAL_POSITION: 1,
        COLUMN_DEFAULT: null,
        IS_NULLABLE: 'NO',
        IS_GENERATED: 'NEVER',
        GENERATION_EXPRESSION: null,
        IS_STORED: null,
        KEY_COLUMN_USAGE: expectedKeyUsage,
      };
      const expectedMetadata: SpannerTableMetadata[] = [
        {
          TABLE_SCHEMA: '',
          TABLE_NAME: 'testTable',
          TABLE_TYPE: 'BASE TABLE',
          PARENT_TABLE_NAME: null,
          ON_DELETE_ACTION: null,
          SPANNER_STATE: 'COMMITTED',
          INTERLEAVE_TYPE: null,
          ROW_DELETION_POLICY_EXPRESSION:
            'OLDER_THAN(CreatedAt, INTERVAL 1 DAY)',
        },
      ];
      const expectedDetails: SpannerTableSchemaDetails = {
        schema: {col1: expectedColumn},
        metadata: expectedMetadata,
      };
      const expectedSuccess: GetTableSchemaSuccessResult = {
        status: 'SUCCESS',
        results: expectedDetails,
      };

      expect(result).toEqual(expectedSuccess);
      expect(state.capturedQueries).toHaveLength(3);
      expect(state.snapshotEndSpy).toHaveBeenCalledOnce();
      expect(state.databaseCloseSpy).toHaveBeenCalledOnce();
      expect(state.clientCloseSpy).toHaveBeenCalledOnce();
    });

    it('rejects PostgreSQL dialect with structured error', async () => {
      state.behavior = {dialect: 'POSTGRESQL'};

      const result = await getTableSchema({
        ...baseTarget,
        table_name: 'testTable',
      });

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'PostgreSQL dialect is not supported.',
      });
      expect(state.databaseCloseSpy).toHaveBeenCalledOnce();
      expect(state.clientCloseSpy).toHaveBeenCalledOnce();
    });

    it('falls back to inspect string when schema results contain circular or BigInt values', async () => {
      const circular: unknown[] = [];
      circular.push(circular);
      let queryCall = 0;
      state.behavior = {
        dialect: 'GOOGLE_STANDARD_SQL',
        runHandler: () => {
          queryCall += 1;
          if (queryCall === 1) {
            return [
              [
                'col1',
                '',
                circular,
                BigInt(1),
                null,
                'NO',
                'NEVER',
                null,
                null,
              ],
            ];
          }
          return [];
        },
      };

      const result = await getTableSchema({
        ...baseTarget,
        table_name: 'testTable',
      });

      expect(result.status).toBe('SUCCESS');
      if (result.status === 'SUCCESS') {
        expect(typeof result.results).toBe('string');
        expect(result.results).toContain('Circular');
        expect(result.results).toContain('1n');
      }
    });
  });

  describe('listTableIndexes', () => {
    it('returns table indexes on GoogleSQL', async () => {
      state.behavior = {
        dialect: 'GOOGLE_STANDARD_SQL',
        runHandler: () => [
          ['PRIMARY_KEY', '', 'PRIMARY_KEY', '', true, false, null],
        ],
      };

      const indexArgs: ListTableIndexesArgs = {
        ...baseTarget,
        table_id: 'testTable',
      };
      const result: ListTableIndexesResult = await listTableIndexes(indexArgs);
      const expectedIndex: SpannerTableIndex = {
        INDEX_NAME: 'PRIMARY_KEY',
        TABLE_SCHEMA: '',
        INDEX_TYPE: 'PRIMARY_KEY',
        PARENT_TABLE_NAME: '',
        IS_UNIQUE: true,
        IS_NULL_FILTERED: false,
        INDEX_STATE: null,
      };
      const expectedResult: ListTableIndexesSuccessResult = {
        status: 'SUCCESS',
        results: [expectedIndex],
      };

      expect(result).toEqual(expectedResult);
      expect(state.capturedQueries[0]?.params).toEqual({table_id: 'testTable'});
    });

    it('rejects PostgreSQL dialect', async () => {
      state.behavior = {dialect: 'POSTGRESQL'};

      const result = await listTableIndexes({
        ...baseTarget,
        table_id: 'testTable',
      });

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'PostgreSQL dialect is not supported.',
      });
    });

    it('stringifies index rows containing circular references', async () => {
      const circular: unknown[] = [];
      circular.push(circular);
      state.behavior = {
        dialect: 'GOOGLE_STANDARD_SQL',
        runHandler: () => [
          [circular, '', 'PRIMARY_KEY', '', true, false, null],
        ],
      };

      const result = await listTableIndexes({
        ...baseTarget,
        table_id: 'testTable',
      });

      expect(result.status).toBe('SUCCESS');
      if (result.status === 'SUCCESS') {
        expect(typeof result.results[0]).toBe('string');
        expect(result.results[0]).toContain('Circular');
      }
    });
  });

  describe('listTableIndexColumns', () => {
    it('returns table index columns on GoogleSQL', async () => {
      state.behavior = {
        dialect: 'GOOGLE_STANDARD_SQL',
        runHandler: () => [['PRIMARY_KEY', '', 'col1', 1, 'NO', 'STRING(MAX)']],
      };

      const indexColArgs: ListTableIndexColumnsArgs = {
        ...baseTarget,
        table_id: 'testTable',
      };
      const result: ListTableIndexColumnsResult =
        await listTableIndexColumns(indexColArgs);
      const expectedCol: SpannerTableIndexColumn = {
        INDEX_NAME: 'PRIMARY_KEY',
        TABLE_SCHEMA: '',
        COLUMN_NAME: 'col1',
        ORDINAL_POSITION: 1,
        IS_NULLABLE: 'NO',
        SPANNER_TYPE: 'STRING(MAX)',
      };
      const expectedResult: ListTableIndexColumnsSuccessResult = {
        status: 'SUCCESS',
        results: [expectedCol],
      };

      expect(result).toEqual(expectedResult);
    });

    it('rejects PostgreSQL dialect', async () => {
      state.behavior = {dialect: 'POSTGRESQL'};

      const result = await listTableIndexColumns({
        ...baseTarget,
        table_id: 'testTable',
      });

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'PostgreSQL dialect is not supported.',
      });
    });

    it('stringifies index column rows containing circular references', async () => {
      const circular: unknown[] = [];
      circular.push(circular);
      state.behavior = {
        dialect: 'GOOGLE_STANDARD_SQL',
        runHandler: () => [
          ['PRIMARY_KEY', '', circular, 1, 'NO', 'STRING(MAX)'],
        ],
      };

      const result = await listTableIndexColumns({
        ...baseTarget,
        table_id: 'testTable',
      });

      expect(result.status).toBe('SUCCESS');
      if (result.status === 'SUCCESS') {
        expect(typeof result.results[0]).toBe('string');
        expect(result.results[0]).toContain('Circular');
      }
    });
  });

  describe('listNamedSchemas', () => {
    it('returns named schemas on GoogleSQL and falls back to GOOGLE_CLOUD_PROJECT', async () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-spanner-project');
      state.behavior = {
        dialect: 'GOOGLE_STANDARD_SQL',
        runHandler: () => [['schemaOne'], ['schemaTwo']],
      };

      const namedSchemaArgs: ListNamedSchemasArgs = {
        instance_id: 'test-instance',
        database_id: 'test-database',
        credentials: testCredentials,
      };
      const result: ListNamedSchemasResult =
        await listNamedSchemas(namedSchemaArgs);
      const expectedSchemas: ListNamedSchemasSuccessResult = {
        status: 'SUCCESS',
        results: ['schemaOne', 'schemaTwo'],
      };

      expect(result).toEqual(expectedSchemas);
      expect(state.capturedClientOptions[0]?.['projectId']).toBe(
        'env-spanner-project',
      );
    });

    it('rejects PostgreSQL dialect and closes resources on SDK error', async () => {
      state.behavior = {dialect: 'POSTGRESQL'};
      const pgResult = await listNamedSchemas(baseTarget);
      expect(pgResult).toEqual({
        status: 'ERROR',
        error_details: 'PostgreSQL dialect is not supported.',
      });

      state.behavior = {
        dialect: 'GOOGLE_STANDARD_SQL',
        snapshotError: new Error('Snapshot failed'),
      };
      const errorResult = await listNamedSchemas(baseTarget);
      expect(errorResult).toEqual({
        status: 'ERROR',
        error_details: 'Snapshot failed',
      });
      expect(
        await getTableSchema({...baseTarget, table_name: 'testTable'}),
      ).toEqual({
        status: 'ERROR',
        error_details: 'Snapshot failed',
      });
      expect(
        await listTableIndexes({...baseTarget, table_id: 'testTable'}),
      ).toEqual({
        status: 'ERROR',
        error_details: 'Snapshot failed',
      });
      expect(
        await listTableIndexColumns({...baseTarget, table_id: 'testTable'}),
      ).toEqual({
        status: 'ERROR',
        error_details: 'Snapshot failed',
      });
      expect(state.databaseCloseSpy).toHaveBeenCalledTimes(5);
      expect(state.clientCloseSpy).toHaveBeenCalledTimes(5);
    });
  });
});
