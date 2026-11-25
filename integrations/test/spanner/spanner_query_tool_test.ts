/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GoogleOAuthCredentials} from '@google/adk';
import {
  executeSpannerSql,
  type ExecuteSpannerSqlArgs,
  executeSpannerSqlParameters,
  type ExecuteSpannerSqlResult,
  type ExecuteSpannerSqlSuccessResult,
  getExecuteSpannerSqlDescription,
  type SpannerDatabaseDialect,
} from '@google/adk-integrations';
import {Readable} from 'node:stream';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

interface FakeQueryBehavior {
  dialect?: SpannerDatabaseDialect;
  streamRows?: unknown[];
  queryError?: Error;
}

interface QueryTestState {
  behavior: FakeQueryBehavior;
  capturedClientOptions: Array<Record<string, unknown>>;
  capturedSqlRequests: Array<Record<string, unknown>>;
  streamDestroyedCount: number;
  snapshotEndSpy: Mock<() => void>;
  databaseCloseSpy: Mock<() => void>;
  clientCloseSpy: Mock<() => void>;
}

const state: QueryTestState = {
  behavior: {},
  capturedClientOptions: [],
  capturedSqlRequests: [],
  streamDestroyedCount: 0,
  snapshotEndSpy: vi.fn(() => {}),
  databaseCloseSpy: vi.fn(() => {}),
  clientCloseSpy: vi.fn(() => {}),
};

vi.mock('@google-cloud/spanner', () => ({
  Spanner: class {
    constructor(options: Record<string, unknown>) {
      state.capturedClientOptions.push(options);
      return {
        instance: () => ({
          database: () => ({
            getDatabaseDialect: async () =>
              state.behavior.dialect ?? 'GOOGLE_STANDARD_SQL',
            getSnapshot: async () => [
              {
                runStream: (request: Record<string, unknown>) => {
                  state.capturedSqlRequests.push(request);
                  if (state.behavior.queryError) {
                    const err = state.behavior.queryError;
                    return new Readable({
                      objectMode: true,
                      read() {
                        this.destroy(err);
                      },
                    });
                  }
                  const stream = Readable.from(state.behavior.streamRows ?? []);
                  const origDestroy = stream.destroy.bind(stream);
                  vi.spyOn(stream, 'destroy').mockImplementation(
                    (error?: Error) => {
                      state.streamDestroyedCount += 1;
                      return origDestroy(error);
                    },
                  );
                  return stream;
                },
                end: () => {
                  state.snapshotEndSpy();
                },
              },
            ],
            close: async () => {
              state.databaseCloseSpy();
            },
          }),
        }),
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

const baseArgs: ExecuteSpannerSqlArgs = {
  project_id: 'test-project',
  instance_id: 'test-instance',
  database_id: 'test-database',
  query: 'SELECT id FROM Singers',
  credentials: testCredentials,
};

describe('executeSpannerSql query tool', () => {
  beforeEach(() => {
    state.behavior = {};
    state.capturedClientOptions = [];
    state.capturedSqlRequests = [];
    state.streamDestroyedCount = 0;
    state.snapshotEndSpy.mockClear();
    state.databaseCloseSpy.mockClear();
    state.clientCloseSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('validates parameters via executeSpannerSqlParameters', () => {
    expect(
      executeSpannerSqlParameters.parse({
        project_id: 'p',
        instance_id: 'i',
        database_id: 'd',
        query: 'SELECT 1',
      }),
    ).toEqual({
      project_id: 'p',
      instance_id: 'i',
      database_id: 'd',
      query: 'SELECT 1',
    });
  });

  it('returns positional rows without truncation flag when fewer than max rows are returned', async () => {
    state.behavior = {
      streamRows: [[100], ['The Hotel', 4.1, 'Modern hotel.']],
    };

    const result: ExecuteSpannerSqlResult = await executeSpannerSql(baseArgs);
    const expectedSuccess: ExecuteSpannerSqlSuccessResult = {
      status: 'SUCCESS',
      rows: [[100], ['The Hotel', 4.1, 'Modern hotel.']],
    };

    expect(result).toEqual(expectedSuccess);
    expect('result_is_likely_truncated' in result).toBe(false);
    expect(state.snapshotEndSpy).toHaveBeenCalledOnce();
    expect(state.databaseCloseSpy).toHaveBeenCalledOnce();
    expect(state.clientCloseSpy).toHaveBeenCalledOnce();
  });

  it('caps streaming results at default 50 rows, destroys stream early, and sets result_is_likely_truncated', async () => {
    const sixtyRows = Array.from({length: 60}, (_, idx) => [idx]);
    state.behavior = {streamRows: sixtyRows};

    const result = await executeSpannerSql(baseArgs);

    expect(result).toEqual({
      status: 'SUCCESS',
      rows: sixtyRows.slice(0, 50),
      result_is_likely_truncated: true,
    });
    expect(state.streamDestroyedCount).toBeGreaterThanOrEqual(1);
  });

  it('respects custom settings.maxExecutedQueryResultRows and sets truncation flag at the limit', async () => {
    const rows = Array.from({length: 5}, (_, idx) => [idx]);
    state.behavior = {streamRows: rows};

    const result = await executeSpannerSql({
      ...baseArgs,
      settings: {maxExecutedQueryResultRows: 3},
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      rows: [[0], [1], [2]],
      result_is_likely_truncated: true,
    });
    expect(state.streamDestroyedCount).toBeGreaterThanOrEqual(1);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'returns ERROR without opening a client when maxExecutedQueryResultRows is %s',
    async (invalidRows) => {
      const result = await executeSpannerSql({
        ...baseArgs,
        settings: {maxExecutedQueryResultRows: invalidRows},
      });

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'maxExecutedQueryResultRows must be a positive integer.',
      });
      expect(state.capturedClientOptions).toHaveLength(0);
    },
  );

  it('rejects PostgreSQL dialect queries', async () => {
    state.behavior = {dialect: 'POSTGRESQL'};

    const result = await executeSpannerSql(baseArgs);

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'PostgreSQL dialect is not supported.',
    });
    expect(state.databaseCloseSpy).toHaveBeenCalledOnce();
    expect(state.clientCloseSpy).toHaveBeenCalledOnce();
  });

  it('stringifies rows containing circular references or BigInt values', async () => {
    const circular: unknown[] = [];
    circular.push(circular);
    state.behavior = {
      streamRows: [[BigInt('9007199254740993'), 'ok'], [circular]],
    };

    const result = await executeSpannerSql(baseArgs);

    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') {
      expect(typeof result.rows[0]).toBe('string');
      expect(result.rows[0]).toContain('9007199254740993n');
      expect(typeof result.rows[1]).toBe('string');
      expect(result.rows[1]).toContain('Circular');
    }
  });

  it('falls back to GOOGLE_CLOUD_PROJECT when project_id is omitted or empty', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-spanner-project');
    state.behavior = {streamRows: [[1]]};

    await executeSpannerSql({
      instance_id: 'test-instance',
      database_id: 'test-database',
      query: 'SELECT 1',
      credentials: testCredentials,
    });
    expect(state.capturedClientOptions[0]?.['projectId']).toBe(
      'env-spanner-project',
    );

    await executeSpannerSql({
      ...baseArgs,
      project_id: '',
    });
    expect(state.capturedClientOptions[1]?.['projectId']).toBe(
      'env-spanner-project',
    );
  });

  it('cleans up snapshot, database, and client when query execution fails', async () => {
    state.behavior = {
      queryError: new Error('Syntax error in SQL query'),
    };

    const result = await executeSpannerSql(baseArgs);

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Syntax error in SQL query',
    });
    expect(state.snapshotEndSpy).toHaveBeenCalledOnce();
    expect(state.databaseCloseSpy).toHaveBeenCalledOnce();
    expect(state.clientCloseSpy).toHaveBeenCalledOnce();
  });

  it('formats getExecuteSpannerSqlDescription with singular and plural row counts', () => {
    expect(getExecuteSpannerSqlDescription()).toContain(
      'At most 50 rows are returned.',
    );
    expect(
      getExecuteSpannerSqlDescription({maxExecutedQueryResultRows: 1}),
    ).toContain('At most 1 row is returned.');
    expect(
      getExecuteSpannerSqlDescription({maxExecutedQueryResultRows: 20}),
    ).toContain('At most 20 rows are returned.');
    expect(() =>
      getExecuteSpannerSqlDescription({maxExecutedQueryResultRows: 0}),
    ).toThrow(RangeError);
  });
});
