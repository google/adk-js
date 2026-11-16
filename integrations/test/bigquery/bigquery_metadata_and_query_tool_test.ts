/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type Context, createSession, State} from '@google/adk';
import {
  BIGQUERY_USER_AGENT,
  type BigQueryAuthClient,
  BigQueryClient,
  type BigQueryConnectionProperty,
  type BigQueryDryRunResult,
  executeSql,
  getBigQueryClient,
  getDatasetInfo,
  getExecuteSql,
  getExecuteSqlDescription,
  getTableInfo,
  type GoogleOAuthCredentials,
  listDatasetIds,
  listTableIds,
  WriteMode,
} from '@google/adk-integrations';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {
  BigQuerySdkClient,
  BigQuerySdkModule,
  InternalGetBigQueryClientOptions,
} from '../../src/bigquery/client.js';

function createSessionToolContext(
  sessionId: string,
  initialState: Record<string, unknown> = {},
  options: {appName?: string; userId?: string} = {},
): Context {
  const session = createSession({
    id: sessionId,
    appName: options.appName ?? 'test_app',
    userId: options.userId ?? 'test_user',
    state: initialState,
  });
  return {
    invocationContext: {session},
    sessionId: session.id,
    userId: session.userId,
    state: new State(session.state),
    actions: {},
    getAuthResponse: vi.fn(() => undefined),
    requestCredential: vi.fn(),
    requestConfirmation: vi.fn(),
  } as unknown as Context;
}

vi.mock('@google-cloud/bigquery', () => {
  throw new Error("Cannot find package '@google-cloud/bigquery'");
});

describe('getBigQueryClient and BigQueryClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('uses the given project and no default location', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    const client = getBigQueryClient({
      projectId: 'test-gcp-project',
      credentials: {valid: true},
    });

    expect(client.projectId).toBe('test-gcp-project');
    expect(client.location).toBeUndefined();
  });

  it('falls back to GOOGLE_CLOUD_PROJECT when projectId is omitted', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-gcp-project');
    const client = getBigQueryClient({
      credentials: {valid: true},
    });

    expect(client.projectId).toBe('env-gcp-project');
  });

  it('keeps a custom location', () => {
    const client = getBigQueryClient({
      projectId: 'test-gcp-project',
      credentials: {valid: true},
      location: 'us-central1',
    });

    expect(client.projectId).toBe('test-gcp-project');
    expect(client.location).toBe('us-central1');
  });

  it('sends the default user agent', () => {
    const client = getBigQueryClient({
      projectId: 'test-gcp-project',
      credentials: {valid: true},
    });

    expect(client.userAgent).toBe(BIGQUERY_USER_AGENT);
  });

  it('appends a custom user agent string', () => {
    const client = getBigQueryClient({
      projectId: 'test-gcp-project',
      credentials: {valid: true},
      userAgent: 'custom_user_agent',
    });

    expect(client.userAgent).toBe(`${BIGQUERY_USER_AGENT} custom_user_agent`);
  });

  it('appends each defined custom user agent from an array', () => {
    const client = getBigQueryClient({
      projectId: 'test-gcp-project',
      credentials: {valid: true},
      userAgent: ['custom_user_agent1', undefined, 'custom_user_agent2'],
    });

    expect(client.userAgent).toBe(
      `${BIGQUERY_USER_AGENT} custom_user_agent1 custom_user_agent2`,
    );
  });

  it('delegates SDK operations through sdkLoader', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const querySpy = vi.fn(
      async (
        _options: unknown,
        _resultsOptions?: unknown,
      ): Promise<[Array<Record<string, unknown>>]> => [[{col: 'val'}]],
    );
    const fakeSdkClient: BigQuerySdkClient = {
      getDatasets: async () => [[{id: 'ds_a'}, {id: 'ds_b'}]],
      dataset: (datasetId: string) => ({
        id: datasetId,
        get: async () => [
          {id: datasetId},
          {kind: 'bigquery#dataset', id: `proj:${datasetId}`},
        ],
        getTables: async () => [[{id: 'tbl_1'}, {id: 'tbl_2'}]],
        table: (tableId: string) => ({
          id: tableId,
          get: async () => [
            {id: tableId},
            {kind: 'bigquery#table', id: `proj:${datasetId}.${tableId}`},
          ],
        }),
      }),
      query: querySpy,
      createQueryJob: async () => [
        {
          id: 'job-1',
          metadata: {statistics: {query: {statementType: 'SELECT'}}},
        },
      ],
    };

    const fakeModule: BigQuerySdkModule = {
      BigQuery: class {
        constructor(options: Record<string, unknown>) {
          capturedOptions = options;
          return fakeSdkClient;
        }
      } as unknown as BigQuerySdkModule['BigQuery'],
    };

    const clientOptions: InternalGetBigQueryClientOptions = {
      projectId: 'proj',
      location: 'US',
      credentials: {token: 'tok-123', valid: true},
      sdkLoader: async () => fakeModule,
    };
    const client = getBigQueryClient(clientOptions);

    const datasets = await client.listDatasets('proj');
    expect(datasets).toEqual([{datasetId: 'ds_a'}, {datasetId: 'ds_b'}]);
    expect(capturedOptions?.['projectId']).toBe('proj');
    expect(capturedOptions?.['location']).toBe('US');
    expect(capturedOptions?.['userAgent']).toBe(BIGQUERY_USER_AGENT);

    const dsInfo = await client.getDataset({
      projectId: 'proj',
      datasetId: 'ds_a',
    });
    expect(dsInfo).toEqual({kind: 'bigquery#dataset', id: 'proj:ds_a'});

    const tables = await client.listTables({
      projectId: 'proj',
      datasetId: 'ds_a',
    });
    expect(tables).toEqual([{tableId: 'tbl_1'}, {tableId: 'tbl_2'}]);

    const tblInfo = await client.getTable({
      projectId: 'proj',
      datasetId: 'ds_a',
      tableId: 'tbl_1',
    });
    expect(tblInfo).toEqual({kind: 'bigquery#table', id: 'proj:ds_a.tbl_1'});

    const rows = await client.query({
      query: 'SELECT 1',
      projectId: 'proj',
      maxResults: 10,
    });
    expect(rows).toEqual([{col: 'val'}]);
    expect(querySpy).toHaveBeenCalledWith(
      {
        query: 'SELECT 1',
        projectId: 'proj',
        location: 'US',
        maxResults: 10,
      },
      {maxResults: 10},
    );
    expect(capturedOptions?.['credentials']).toBeUndefined();
    const authClient = capturedOptions?.['authClient'] as {
      getRequestHeaders: () => Promise<Record<string, string>>;
    };
    await expect(authClient.getRequestHeaders()).resolves.toEqual({
      Authorization: 'Bearer tok-123',
    });
  });

  it('passes maxResults in the second query options argument and slices rows defensively', async () => {
    const querySpy = vi.fn(
      async (
        _options: unknown,
        _resultsOptions?: unknown,
      ): Promise<[Array<Record<string, unknown>>]> => [
        Array.from({length: 8}, (_, index) => ({id: index})),
      ],
    );
    const fakeSdkClient: BigQuerySdkClient = {
      getDatasets: async () => [[]],
      dataset: () => ({}),
      query: querySpy,
      createQueryJob: async () => [
        {
          id: 'job-1',
          metadata: {statistics: {query: {statementType: 'SELECT'}}},
        },
      ],
    };
    const fakeModule: BigQuerySdkModule = {
      BigQuery: class {
        constructor() {
          return fakeSdkClient;
        }
      } as unknown as BigQuerySdkModule['BigQuery'],
    };

    const clientOptions: InternalGetBigQueryClientOptions = {
      projectId: 'proj',
      sdkLoader: async () => fakeModule,
    };
    const client = getBigQueryClient(clientOptions);

    const rows = await client.query({
      query: 'SELECT id FROM tbl',
      maxResults: 3,
    });

    expect(querySpy).toHaveBeenCalledWith(
      {
        query: 'SELECT id FROM tbl',
        projectId: 'proj',
        location: undefined,
        maxResults: 3,
      },
      {maxResults: 3},
    );
    expect(rows).toEqual([{id: 0}, {id: 1}, {id: 2}]);
  });

  it('passes getRequestHeaders-capable credentials directly as authClient', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const fakeSdkClient: BigQuerySdkClient = {
      getDatasets: async () => [[{id: 'ds_1'}]],
      dataset: () => ({}),
      query: async () => [[]],
      createQueryJob: async () => [
        {
          id: 'job-1',
          metadata: {statistics: {query: {statementType: 'SELECT'}}},
        },
      ],
    };
    const fakeModule: BigQuerySdkModule = {
      BigQuery: class {
        constructor(options: Record<string, unknown>) {
          capturedOptions = options;
          return fakeSdkClient;
        }
      } as unknown as BigQuerySdkModule['BigQuery'],
    };
    const customAuthClient: BigQueryAuthClient = {
      getRequestHeaders: async () => ({Authorization: 'Bearer custom-auth'}),
    };

    const clientOptions: InternalGetBigQueryClientOptions = {
      projectId: 'proj',
      credentials: customAuthClient,
      sdkLoader: async () => fakeModule,
    };
    const client = getBigQueryClient(clientOptions);

    await client.listDatasets('proj');
    expect(capturedOptions?.['authClient']).toBe(customAuthClient);
  });

  it('throws when configured credentials provide neither a token nor getRequestHeaders', async () => {
    const fakeSdkClient: BigQuerySdkClient = {
      getDatasets: async () => [[]],
      dataset: () => ({}),
      query: async () => [[]],
      createQueryJob: async () => [
        {
          id: 'job-1',
          metadata: {statistics: {query: {statementType: 'SELECT'}}},
        },
      ],
    };
    const fakeModule: BigQuerySdkModule = {
      BigQuery: class {
        constructor() {
          return fakeSdkClient;
        }
      } as unknown as BigQuerySdkModule['BigQuery'],
    };

    const clientOptions: InternalGetBigQueryClientOptions = {
      projectId: 'proj',
      credentials: {valid: true},
      sdkLoader: async () => fakeModule,
    };
    const client = getBigQueryClient(clientOptions);

    await expect(client.listDatasets('proj')).rejects.toThrow(
      /Configured BigQuery credentials must provide a non-empty access token or a getRequestHeaders\(\) method/,
    );
  });

  it('throws a descriptive error when @google-cloud/bigquery is not installed', async () => {
    const client = getBigQueryClient({projectId: 'proj'});
    await expect(client.listDatasets('proj')).rejects.toThrow(
      /BigQuery integration requires the optional '@google-cloud\/bigquery' package/,
    );
  });

  it('performs a dry run via createQueryJob on BigQuerySdkClient', async () => {
    let capturedJobOptions: Record<string, unknown> | undefined;
    const fakeSdkClient: BigQuerySdkClient = {
      getDatasets: async () => [[]],
      dataset: () => ({}),
      query: async () => [[]],
      createQueryJob: async (options: Record<string, unknown>) => {
        capturedJobOptions = options;
        return [
          {
            id: 'job-123',
            metadata: {
              statistics: {
                query: {
                  statementType: 'SELECT',
                },
              },
            },
          },
        ];
      },
    };
    const fakeModule: BigQuerySdkModule = {
      BigQuery: class {
        constructor() {
          return fakeSdkClient;
        }
      } as unknown as BigQuerySdkModule['BigQuery'],
    };

    const client = getBigQueryClient({
      projectId: 'proj',
      location: 'US',
      sdkLoader: async () => fakeModule,
    } as InternalGetBigQueryClientOptions);

    const dryRunResult = await client.dryRun({
      query: 'SELECT 1',
    });

    expect(dryRunResult).toEqual({statementType: 'SELECT'});
    expect(capturedJobOptions).toEqual({
      query: 'SELECT 1',
      dryRun: true,
      location: 'US',
    });
  });

  it('instantiates an SDK client with effective projectId when options.projectId differs', async () => {
    let capturedClientOptions: Record<string, unknown> | undefined;
    const fakeSdkClient: BigQuerySdkClient = {
      getDatasets: async () => [[]],
      dataset: () => ({}),
      query: async () => [[]],
      createQueryJob: async () => [
        {
          id: 'job-1',
          metadata: {statistics: {query: {statementType: 'SELECT'}}},
        },
      ],
    };
    const fakeModule: BigQuerySdkModule = {
      BigQuery: class {
        constructor(options?: Record<string, unknown>) {
          capturedClientOptions = options;
          return fakeSdkClient;
        }
      } as unknown as BigQuerySdkModule['BigQuery'],
    };

    const client = getBigQueryClient({
      projectId: 'client-proj',
      location: 'US',
      sdkLoader: async () => fakeModule,
    } as InternalGetBigQueryClientOptions);

    await client.dryRun({
      query: 'SELECT 1',
      projectId: 'override-proj',
    });

    expect(capturedClientOptions?.['projectId']).toBe('override-proj');
  });

  it('propagates errors from createQueryJob during dryRun', async () => {
    const fakeSdkClient: BigQuerySdkClient = {
      getDatasets: async () => [[]],
      dataset: () => ({}),
      query: async () => [[]],
      createQueryJob: async () => {
        throw new Error('Dry run failed: table not found');
      },
    };
    const fakeModule: BigQuerySdkModule = {
      BigQuery: class {
        constructor() {
          return fakeSdkClient;
        }
      } as unknown as BigQuerySdkModule['BigQuery'],
    };

    const client = getBigQueryClient({
      projectId: 'proj',
      sdkLoader: async () => fakeModule,
    } as InternalGetBigQueryClientOptions);

    await expect(client.dryRun({query: 'SELECT 1'})).rejects.toThrow(
      'Dry run failed: table not found',
    );
  });

  it('forwards createSession and connectionProperties in dryRun and extracts sessionInfo and destinationTable', async () => {
    let capturedJobOptions: Record<string, unknown> | undefined;
    const connectionProperties: BigQueryConnectionProperty[] = [
      {key: 'session_id', value: 'bq-sess-123'},
    ];
    const fakeSdkClient: BigQuerySdkClient = {
      getDatasets: async () => [[]],
      dataset: () => ({}),
      query: async () => [[]],
      createQueryJob: async (options: Record<string, unknown>) => {
        capturedJobOptions = options;
        return [
          {
            id: 'job-456',
            metadata: {
              configuration: {
                query: {
                  destinationTable: {
                    projectId: 'proj',
                    datasetId: '_anonymous_dataset',
                    tableId: 'anon_table',
                  },
                },
              },
              statistics: {
                sessionInfo: {
                  sessionId: 'bq-sess-123',
                },
                query: {
                  statementType: 'CREATE_AS_SELECT',
                },
              },
            },
          },
        ];
      },
    };
    const fakeModule: BigQuerySdkModule = {
      BigQuery: class {
        constructor() {
          return fakeSdkClient;
        }
      } as unknown as BigQuerySdkModule['BigQuery'],
    };

    const client = getBigQueryClient({
      projectId: 'proj',
      location: 'US',
      sdkLoader: async () => fakeModule,
    } as InternalGetBigQueryClientOptions);

    const dryRunResult: BigQueryDryRunResult = await client.dryRun({
      query: 'CREATE TEMP TABLE my_table AS SELECT 1',
      createSession: true,
      connectionProperties,
    });

    expect(capturedJobOptions).toEqual({
      query: 'CREATE TEMP TABLE my_table AS SELECT 1',
      dryRun: true,
      location: 'US',
      createSession: true,
      connectionProperties,
    });
    expect(dryRunResult).toEqual({
      statementType: 'CREATE_AS_SELECT',
      sessionInfo: {sessionId: 'bq-sess-123'},
      destinationTable: {
        projectId: 'proj',
        datasetId: '_anonymous_dataset',
        tableId: 'anon_table',
      },
    });
  });

  it('extracts ddlTargetTable as destinationTable when configuration.query.destinationTable is absent', async () => {
    const fakeSdkClient: BigQuerySdkClient = {
      getDatasets: async () => [[]],
      dataset: () => ({}),
      query: async () => [[]],
      createQueryJob: async () => [
        {
          id: 'job-789',
          metadata: {
            statistics: {
              query: {
                statementType: 'DROP_TABLE',
                ddlTargetTable: {
                  projectId: 'proj',
                  datasetId: '_anonymous_dataset',
                  tableId: 'my_table',
                },
              },
            },
          },
        },
      ],
    };
    const fakeModule: BigQuerySdkModule = {
      BigQuery: class {
        constructor() {
          return fakeSdkClient;
        }
      } as unknown as BigQuerySdkModule['BigQuery'],
    };

    const client = getBigQueryClient({
      projectId: 'proj',
      sdkLoader: async () => fakeModule,
    } as InternalGetBigQueryClientOptions);

    const dryRunResult = await client.dryRun({
      query: 'DROP TABLE my_table',
    });

    expect(dryRunResult).toEqual({
      statementType: 'DROP_TABLE',
      destinationTable: {
        projectId: 'proj',
        datasetId: '_anonymous_dataset',
        tableId: 'my_table',
      },
    });
  });
});

describe('BigQuery metadata tools', () => {
  const mockCredentials: GoogleOAuthCredentials = {
    token: 'test-token',
    valid: true,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists dataset ids with the given credentials', async () => {
    const spy = vi
      .spyOn(BigQueryClient.prototype, 'listDatasets')
      .mockImplementation(async function (
        this: BigQueryClient,
        projectId?: string,
      ) {
        expect(this.projectId).toBe('my_project_id');
        expect(this.credentials).toBe(mockCredentials);
        expect(this.userAgent).toBe(`${BIGQUERY_USER_AGENT} list_dataset_ids`);
        expect(projectId).toBe('my_project_id');
        return [{datasetId: 'dataset1'}, {datasetId: 'dataset2'}];
      });

    const result = await listDatasetIds({
      project_id: 'my_project_id',
      credentials: mockCredentials,
    });
    expect(result).toEqual(['dataset1', 'dataset2']);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('returns structured error when listDatasetIds fails', async () => {
    vi.spyOn(BigQueryClient.prototype, 'listDatasets').mockRejectedValue(
      new Error('Permission denied on project'),
    );

    const result = await listDatasetIds({
      project_id: 'my_project_id',
      credentials: mockCredentials,
    });
    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Permission denied on project',
    });
  });

  it('gets dataset metadata with the given credentials', async () => {
    const datasetMetadata = {
      kind: 'bigquery#dataset',
      id: 'my_project_id:my_dataset_id',
      location: 'US',
    };
    const spy = vi
      .spyOn(BigQueryClient.prototype, 'getDataset')
      .mockImplementation(async function (this: BigQueryClient, ref) {
        expect(this.projectId).toBe('my_project_id');
        expect(this.credentials).toBe(mockCredentials);
        expect(this.userAgent).toBe(`${BIGQUERY_USER_AGENT} get_dataset_info`);
        expect(ref).toEqual({
          projectId: 'my_project_id',
          datasetId: 'my_dataset_id',
        });
        return datasetMetadata;
      });

    const result = await getDatasetInfo({
      project_id: 'my_project_id',
      dataset_id: 'my_dataset_id',
      credentials: mockCredentials,
    });
    expect(result).toEqual(datasetMetadata);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('returns structured error when getDatasetInfo fails', async () => {
    vi.spyOn(BigQueryClient.prototype, 'getDataset').mockRejectedValue(
      new Error('Dataset not found'),
    );

    const result = await getDatasetInfo({
      project_id: 'my_project_id',
      dataset_id: 'missing_dataset',
      credentials: mockCredentials,
    });
    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Dataset not found',
    });
  });

  it('lists table ids with the given credentials', async () => {
    const spy = vi
      .spyOn(BigQueryClient.prototype, 'listTables')
      .mockImplementation(async function (this: BigQueryClient, ref) {
        expect(this.projectId).toBe('my_project_id');
        expect(this.credentials).toBe(mockCredentials);
        expect(this.userAgent).toBe(`${BIGQUERY_USER_AGENT} list_table_ids`);
        expect(ref).toEqual({
          projectId: 'my_project_id',
          datasetId: 'my_dataset_id',
        });
        return [{tableId: 'table1'}, {tableId: 'table2'}];
      });

    const result = await listTableIds({
      project_id: 'my_project_id',
      dataset_id: 'my_dataset_id',
      credentials: mockCredentials,
    });
    expect(result).toEqual(['table1', 'table2']);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('returns structured error when listTableIds fails', async () => {
    vi.spyOn(BigQueryClient.prototype, 'listTables').mockRejectedValue(
      new Error('Failed to list tables'),
    );

    const result = await listTableIds({
      project_id: 'my_project_id',
      dataset_id: 'my_dataset_id',
      credentials: mockCredentials,
    });
    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Failed to list tables',
    });
  });

  it('gets table metadata with the given credentials', async () => {
    const tableMetadata = {
      kind: 'bigquery#table',
      id: 'my_project_id:my_dataset_id.my_table_id',
      numRows: '344',
    };
    const spy = vi
      .spyOn(BigQueryClient.prototype, 'getTable')
      .mockImplementation(async function (this: BigQueryClient, ref) {
        expect(this.projectId).toBe('my_project_id');
        expect(this.credentials).toBe(mockCredentials);
        expect(this.userAgent).toBe(`${BIGQUERY_USER_AGENT} get_table_info`);
        expect(ref).toEqual({
          projectId: 'my_project_id',
          datasetId: 'my_dataset_id',
          tableId: 'my_table_id',
        });
        return tableMetadata;
      });

    const result = await getTableInfo({
      project_id: 'my_project_id',
      dataset_id: 'my_dataset_id',
      table_id: 'my_table_id',
      credentials: mockCredentials,
    });
    expect(result).toEqual(tableMetadata);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('returns structured error when getTableInfo fails', async () => {
    vi.spyOn(BigQueryClient.prototype, 'getTable').mockRejectedValue(
      new Error('Table not found'),
    );

    const result = await getTableInfo({
      project_id: 'my_project_id',
      dataset_id: 'my_dataset_id',
      table_id: 'missing_table',
      credentials: mockCredentials,
    });
    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Table not found',
    });
  });
});

describe('executeSql query tool', () => {
  const mockCredentials: GoogleOAuthCredentials = {
    token: 'test-token',
    valid: true,
  };

  beforeEach(() => {
    vi.spyOn(BigQueryClient.prototype, 'dryRun').mockResolvedValue({
      statementType: 'SELECT',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('executes SQL and returns rows without truncation flag when fewer than 50 rows', async () => {
    const sampleRows = [
      {island: 'Dream', population: 124},
      {island: 'Biscoe', population: 168},
    ];
    const spy = vi
      .spyOn(BigQueryClient.prototype, 'query')
      .mockImplementation(async function (this: BigQueryClient, opts) {
        expect(this.projectId).toBe('my_project');
        expect(this.credentials).toBe(mockCredentials);
        expect(this.userAgent).toBe(`${BIGQUERY_USER_AGENT} execute_sql`);
        expect(opts).toEqual({
          query: 'SELECT island, population FROM penguins',
          projectId: 'my_project',
          maxResults: 50,
        });
        return sampleRows;
      });

    const result = await executeSql({
      project_id: 'my_project',
      query: 'SELECT island, population FROM penguins',
      credentials: mockCredentials,
    });

    expect(result).toEqual({status: 'SUCCESS', rows: sampleRows});
    expect('result_is_likely_truncated' in result).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('sets result_is_likely_truncated to true when 50 rows are returned', async () => {
    const fiftyRows = Array.from({length: 50}, (_, index) => ({id: index}));
    vi.spyOn(BigQueryClient.prototype, 'query').mockResolvedValue(fiftyRows);

    const result = await executeSql({
      project_id: 'my_project',
      query: 'SELECT id FROM large_table',
      credentials: mockCredentials,
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      rows: fiftyRows,
      result_is_likely_truncated: true,
    });
  });

  it('caps rows at 50 and sets result_is_likely_truncated when the fake SDK returns more than 50 rows', async () => {
    const sixtyRows = Array.from({length: 60}, (_, index) => ({id: index}));
    const sdkQuerySpy = vi.fn(
      async (
        _options: unknown,
        _resultsOptions?: unknown,
      ): Promise<[Array<Record<string, unknown>>]> => [sixtyRows],
    );
    const fakeSdkClient: BigQuerySdkClient = {
      getDatasets: async () => [[]],
      dataset: () => ({}),
      query: sdkQuerySpy,
      createQueryJob: async () => [
        {
          id: 'job-1',
          metadata: {statistics: {query: {statementType: 'SELECT'}}},
        },
      ],
    };
    const fakeModule: BigQuerySdkModule = {
      BigQuery: class {
        constructor() {
          return fakeSdkClient;
        }
      } as unknown as BigQuerySdkModule['BigQuery'],
    };
    const clientOptions: InternalGetBigQueryClientOptions = {
      projectId: 'my_project',
      credentials: mockCredentials,
      sdkLoader: async () => fakeModule,
    };
    const clientWithFakeSdk = getBigQueryClient(clientOptions);
    const originalQuery = BigQueryClient.prototype.query;
    vi.spyOn(BigQueryClient.prototype, 'query').mockImplementation((opts) =>
      originalQuery.call(clientWithFakeSdk, opts),
    );

    const result = await executeSql({
      project_id: 'my_project',
      query: 'SELECT id FROM large_table',
      credentials: mockCredentials,
    });

    expect(sdkQuerySpy).toHaveBeenCalledWith(
      {
        query: 'SELECT id FROM large_table',
        projectId: 'my_project',
        location: undefined,
        maxResults: 50,
      },
      {maxResults: 50},
    );
    expect(result).toEqual({
      status: 'SUCCESS',
      rows: sixtyRows.slice(0, 50),
      result_is_likely_truncated: true,
    });
  });

  it('stringifies non-JSON-serializable cell values', async () => {
    vi.spyOn(BigQueryClient.prototype, 'query').mockResolvedValue([
      {id: BigInt('9007199254740993'), name: 'row1'},
    ]);

    const result = await executeSql({
      project_id: 'my_project',
      query: 'SELECT id, name FROM bigints',
      credentials: mockCredentials,
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      rows: [{id: '9007199254740993', name: 'row1'}],
    });
  });

  it('returns structured error when query execution fails', async () => {
    vi.spyOn(BigQueryClient.prototype, 'query').mockRejectedValue(
      new Error('Syntax error in SQL query'),
    );

    const result = await executeSql({
      project_id: 'my_project',
      query: 'SELEC * FROM broken',
      credentials: mockCredentials,
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Syntax error in SQL query',
    });
  });

  it('rejects non-SELECT query in read-only mode (WriteMode.BLOCKED)', async () => {
    vi.spyOn(BigQueryClient.prototype, 'dryRun').mockResolvedValue({
      statementType: 'CREATE_TABLE',
    });
    const querySpy = vi.spyOn(BigQueryClient.prototype, 'query');

    const result = await executeSql({
      project_id: 'my_project',
      query: 'CREATE TABLE dataset.t AS SELECT 1',
      credentials: mockCredentials,
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Read-only mode only supports SELECT statements.',
    });
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('allows non-SELECT query when configured with WriteMode.ALLOWED', async () => {
    const dryRunSpy = vi.spyOn(BigQueryClient.prototype, 'dryRun');
    const querySpy = vi
      .spyOn(BigQueryClient.prototype, 'query')
      .mockResolvedValue([]);

    const result = await executeSql({
      project_id: 'my_project',
      query: 'CREATE TABLE dataset.t AS SELECT 1',
      credentials: mockCredentials,
      config: {writeMode: WriteMode.ALLOWED},
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      rows: [],
    });
    expect(dryRunSpy).not.toHaveBeenCalled();
    expect(querySpy).toHaveBeenCalledWith({
      query: 'CREATE TABLE dataset.t AS SELECT 1',
      projectId: 'my_project',
      maxResults: 50,
    });
  });

  it('allows SELECT query when dryRun confirms SELECT statementType', async () => {
    const dryRunSpy = vi
      .spyOn(BigQueryClient.prototype, 'dryRun')
      .mockResolvedValue({statementType: 'SELECT'});
    const sampleRows = [{id: 1}];
    const querySpy = vi
      .spyOn(BigQueryClient.prototype, 'query')
      .mockResolvedValue(sampleRows);

    const result = await executeSql({
      project_id: 'my_project',
      query: 'SELECT id FROM dataset.t',
      credentials: mockCredentials,
      config: {writeMode: WriteMode.BLOCKED},
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      rows: sampleRows,
    });
    expect(dryRunSpy).toHaveBeenCalledWith({
      query: 'SELECT id FROM dataset.t',
      projectId: 'my_project',
    });
    expect(querySpy).toHaveBeenCalledOnce();
  });

  it('rejects non-SELECT query when configured with an unrecognized or non-ALLOWED writeMode', async () => {
    vi.spyOn(BigQueryClient.prototype, 'dryRun').mockResolvedValue({
      statementType: 'DROP_TABLE',
    });
    const querySpy = vi.spyOn(BigQueryClient.prototype, 'query');

    const result = await executeSql({
      project_id: 'my_project',
      query: 'DROP TABLE dataset.t',
      credentials: mockCredentials,
      config: {writeMode: 'unrecognized' as unknown as WriteMode},
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Read-only mode only supports SELECT statements.',
    });
    expect(querySpy).not.toHaveBeenCalled();
  });

  it.each([
    {modeName: 'blocked', writeMode: WriteMode.BLOCKED},
    {modeName: 'protected', writeMode: WriteMode.PROTECTED},
    {modeName: 'allowed', writeMode: WriteMode.ALLOWED},
  ])(
    'executes SELECT statement when writeMode is $modeName',
    async ({writeMode}) => {
      vi.spyOn(BigQueryClient.prototype, 'dryRun').mockImplementation(
        async (opts) => {
          if (opts.createSession) {
            return {
              statementType: 'SELECT',
              sessionInfo: {sessionId: 'test-bq-session-id'},
              destinationTable: {datasetId: '_anonymous_dataset'},
            };
          }
          return {statementType: 'SELECT'};
        },
      );
      const querySpy = vi
        .spyOn(BigQueryClient.prototype, 'query')
        .mockResolvedValue([{num: 123}]);

      const result = await executeSql(
        {
          project_id: 'my_project',
          query: 'SELECT 123 AS num',
          credentials: mockCredentials,
          config: {writeMode},
        },
        createSessionToolContext(`select-${writeMode}`),
      );

      expect(result).toEqual({
        status: 'SUCCESS',
        rows: [{num: 123}],
      });
      expect(querySpy).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      label: 'create as select',
      query: 'CREATE TABLE my_dataset.my_table AS SELECT 123 AS num',
      statementType: 'CREATE_AS_SELECT',
    },
    {
      label: 'drop table',
      query: 'DROP TABLE my_dataset.my_table',
      statementType: 'DROP_TABLE',
    },
    {
      label: 'create model',
      query:
        "CREATE MODEL my_dataset.my_model (model_type='linear_reg', input_label_cols=['label_col']) AS SELECT * FROM my_dataset.my_table",
      statementType: 'CREATE_MODEL',
    },
    {
      label: 'drop model',
      query: 'DROP MODEL my_dataset.my_model',
      statementType: 'DROP_MODEL',
    },
  ])(
    'executes non-SELECT $label query when WriteMode.ALLOWED is configured',
    async ({query, statementType}) => {
      vi.spyOn(BigQueryClient.prototype, 'dryRun').mockResolvedValue({
        statementType,
      });
      const querySpy = vi
        .spyOn(BigQueryClient.prototype, 'query')
        .mockResolvedValue([]);

      const result = await executeSql(
        {
          project_id: 'my_project',
          query,
          credentials: mockCredentials,
          config: {writeMode: WriteMode.ALLOWED},
        },
        createSessionToolContext(`allowed-${statementType}`),
      );

      expect(result).toEqual({status: 'SUCCESS', rows: []});
      expect(querySpy).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      label: 'create as select',
      query: 'CREATE TABLE my_dataset.my_table AS SELECT 123 AS num',
      statementType: 'CREATE_AS_SELECT',
    },
    {
      label: 'drop table',
      query: 'DROP TABLE my_dataset.my_table',
      statementType: 'DROP_TABLE',
    },
    {
      label: 'create model',
      query:
        "CREATE MODEL my_dataset.my_model (model_type='linear_reg', input_label_cols=['label_col']) AS SELECT * FROM my_dataset.my_table",
      statementType: 'CREATE_MODEL',
    },
    {
      label: 'drop model',
      query: 'DROP MODEL my_dataset.my_model',
      statementType: 'DROP_MODEL',
    },
  ])(
    'rejects non-SELECT $label query when WriteMode.BLOCKED is configured',
    async ({query, statementType}) => {
      vi.spyOn(BigQueryClient.prototype, 'dryRun').mockResolvedValue({
        statementType,
      });
      const querySpy = vi
        .spyOn(BigQueryClient.prototype, 'query')
        .mockResolvedValue([]);

      const result = await executeSql(
        {
          project_id: 'my_project',
          query,
          credentials: mockCredentials,
          config: {writeMode: WriteMode.BLOCKED},
        },
        createSessionToolContext(`blocked-${statementType}`),
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'Read-only mode only supports SELECT statements.',
      });
      expect(querySpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: 'create temp table as select',
      query: 'CREATE TEMP TABLE my_table AS SELECT 123 AS num',
      statementType: 'CREATE_AS_SELECT',
    },
    {
      label: 'drop temp table',
      query: 'DROP TABLE my_table',
      statementType: 'DROP_TABLE',
    },
    {
      label: 'create temp model',
      query:
        "CREATE TEMP MODEL my_model (model_type='linear_reg', input_label_cols=['label_col']) AS SELECT * FROM my_dataset.my_table",
      statementType: 'CREATE_MODEL',
    },
    {
      label: 'drop temp model',
      query: 'DROP MODEL my_model',
      statementType: 'DROP_MODEL',
    },
  ])(
    'allows non-SELECT $label query in the session anonymous dataset when WriteMode.PROTECTED is configured',
    async ({query, statementType}) => {
      vi.spyOn(BigQueryClient.prototype, 'dryRun').mockImplementation(
        async (opts) => {
          if (opts.createSession) {
            return {
              statementType: 'SELECT',
              sessionInfo: {sessionId: 'test-bq-session-id'},
              destinationTable: {datasetId: '_anonymous_dataset'},
            };
          }
          return {
            statementType,
            destinationTable: {datasetId: '_anonymous_dataset'},
          };
        },
      );
      const querySpy = vi
        .spyOn(BigQueryClient.prototype, 'query')
        .mockResolvedValue([]);

      const result = await executeSql(
        {
          project_id: 'my_project',
          query,
          credentials: mockCredentials,
          config: {writeMode: WriteMode.PROTECTED},
        },
        createSessionToolContext(`protected-ok-${statementType}`),
      );

      expect(result).toEqual({status: 'SUCCESS', rows: []});
      expect(querySpy).toHaveBeenCalledWith({
        query,
        projectId: 'my_project',
        maxResults: 50,
        connectionProperties: [
          {key: 'session_id', value: 'test-bq-session-id'},
        ],
      });
    },
  );

  it.each([
    {
      label: 'create permanent table as select',
      query: 'CREATE TABLE my_dataset.my_table AS SELECT 123 AS num',
      statementType: 'CREATE_AS_SELECT',
    },
    {
      label: 'drop permanent table',
      query: 'DROP TABLE my_dataset.my_table',
      statementType: 'DROP_TABLE',
    },
    {
      label: 'create permanent model',
      query:
        "CREATE MODEL my_dataset.my_model (model_type='linear_reg', input_label_cols=['label_col']) AS SELECT * FROM my_dataset.my_table",
      statementType: 'CREATE_MODEL',
    },
    {
      label: 'drop permanent model',
      query: 'DROP MODEL my_dataset.my_model',
      statementType: 'DROP_MODEL',
    },
  ])(
    'rejects non-SELECT $label query targeting a persistent dataset when WriteMode.PROTECTED is configured',
    async ({query, statementType}) => {
      vi.spyOn(BigQueryClient.prototype, 'dryRun').mockImplementation(
        async (opts) => {
          if (opts.createSession) {
            return {
              statementType: 'SELECT',
              sessionInfo: {sessionId: 'test-bq-session-id'},
              destinationTable: {datasetId: '_anonymous_dataset'},
            };
          }
          return {
            statementType,
            destinationTable: {datasetId: 'my_dataset'},
          };
        },
      );
      const querySpy = vi
        .spyOn(BigQueryClient.prototype, 'query')
        .mockResolvedValue([]);

      const result = await executeSql(
        {
          project_id: 'my_project',
          query,
          credentials: mockCredentials,
          config: {writeMode: WriteMode.PROTECTED},
        },
        createSessionToolContext(`protected-persist-${statementType}`),
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details:
          'Protected write mode only supports SELECT statements, or write operations in the anonymous dataset of a BigQuery session.',
      });
      expect(querySpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: 'script',
      query:
        'CREATE TEMP TABLE my_table AS SELECT 123 AS num; DROP TABLE my_dataset.my_table',
      statementType: 'SCRIPT',
    },
    {
      label: 'procedure call',
      query: 'CALL my_dataset.my_procedure()',
      statementType: 'CALL',
    },
    {
      label: 'export data',
      query:
        "EXPORT DATA OPTIONS (uri = 'gs://my_bucket/*.csv', format = 'CSV') AS SELECT * FROM my_dataset.my_table",
      statementType: 'EXPORT_DATA',
    },
    {
      label: 'insert without destination',
      query: 'INSERT INTO my_table (num) VALUES (123)',
      statementType: 'INSERT',
    },
    {
      label: 'drop table without destination',
      query: 'DROP TABLE my_table',
      statementType: 'DROP_TABLE',
    },
  ])(
    'rejects non-SELECT $label query with no dry-run destination table when WriteMode.PROTECTED is configured',
    async ({query, statementType}) => {
      vi.spyOn(BigQueryClient.prototype, 'dryRun').mockImplementation(
        async (opts) => {
          if (opts.createSession) {
            return {
              statementType: 'SELECT',
              sessionInfo: {sessionId: 'test-bq-session-id'},
              destinationTable: {datasetId: '_anonymous_dataset'},
            };
          }
          return {
            statementType,
            destinationTable: undefined,
          };
        },
      );
      const querySpy = vi
        .spyOn(BigQueryClient.prototype, 'query')
        .mockResolvedValue([]);

      const result = await executeSql(
        {
          project_id: 'my_project',
          query,
          credentials: mockCredentials,
          config: {writeMode: WriteMode.PROTECTED},
        },
        createSessionToolContext(`protected-undestined-${statementType}`),
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details:
          'Protected write mode only supports SELECT statements, or write operations in the anonymous dataset of a BigQuery session.',
      });
      expect(querySpy).not.toHaveBeenCalled();
    },
  );

  it('ignores BigQuery session info stored in toolContext.state in WriteMode.PROTECTED', async () => {
    vi.spyOn(BigQueryClient.prototype, 'dryRun').mockImplementation(
      async (opts) => {
        if (opts.createSession) {
          return {
            statementType: 'SELECT',
            sessionInfo: {sessionId: 'test-bq-session-id'},
            destinationTable: {datasetId: '_anonymous_dataset'},
          };
        }
        return {
          statementType: 'CREATE_AS_SELECT',
          destinationTable: {datasetId: 'my_dataset'},
        };
      },
    );
    const querySpy = vi
      .spyOn(BigQueryClient.prototype, 'query')
      .mockResolvedValue([]);
    const toolContext = createSessionToolContext('session-in-state', {
      bigquery_session_info: ['other-bq-session-id', 'my_dataset'],
    });

    const result = await executeSql(
      {
        project_id: 'my_project',
        query: 'CREATE TABLE my_dataset.my_table AS SELECT 123 AS num',
        credentials: mockCredentials,
        config: {writeMode: WriteMode.PROTECTED},
      },
      toolContext,
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details:
        'Protected write mode only supports SELECT statements, or write operations in the anonymous dataset of a BigQuery session.',
    });
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('returns an error when BigQuery does not create a session in WriteMode.PROTECTED', async () => {
    vi.spyOn(BigQueryClient.prototype, 'dryRun').mockResolvedValue({
      statementType: 'SELECT',
      sessionInfo: undefined,
    });
    const querySpy = vi.spyOn(BigQueryClient.prototype, 'query');
    const toolContext = createSessionToolContext('session-without-bq-session');

    const result = await executeSql(
      {
        project_id: 'my_project',
        query: 'CREATE TEMP TABLE my_table AS SELECT 123 AS num',
        credentials: mockCredentials,
        config: {writeMode: WriteMode.PROTECTED},
      },
      toolContext,
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'BigQuery did not create a session for the query.',
    });
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('reuses the BigQuery session across subsequent queries in the same ADK session', async () => {
    const dryRunSpy = vi
      .spyOn(BigQueryClient.prototype, 'dryRun')
      .mockImplementation(async (opts) => {
        if (opts.createSession) {
          return {
            statementType: 'SELECT',
            sessionInfo: {sessionId: 'test-bq-session-id'},
            destinationTable: {datasetId: '_anonymous_dataset'},
          };
        }
        return {
          statementType: 'SELECT',
        };
      });
    const querySpy = vi
      .spyOn(BigQueryClient.prototype, 'query')
      .mockResolvedValue([]);
    const toolContext = createSessionToolContext('session-reused');

    await executeSql(
      {
        project_id: 'my_project',
        query: 'SELECT 123 AS num',
        credentials: mockCredentials,
        config: {writeMode: WriteMode.PROTECTED},
      },
      toolContext,
    );
    await executeSql(
      {
        project_id: 'my_project',
        query: 'SELECT 123 AS num',
        credentials: mockCredentials,
        config: {writeMode: WriteMode.PROTECTED},
      },
      toolContext,
    );

    expect(dryRunSpy).toHaveBeenCalledTimes(3);
    expect(dryRunSpy).toHaveBeenNthCalledWith(1, {
      query: 'SELECT 1',
      projectId: 'my_project',
      createSession: true,
    });
    expect(dryRunSpy).toHaveBeenNthCalledWith(2, {
      query: 'SELECT 123 AS num',
      projectId: 'my_project',
      connectionProperties: [{key: 'session_id', value: 'test-bq-session-id'}],
    });
    expect(dryRunSpy).toHaveBeenNthCalledWith(3, {
      query: 'SELECT 123 AS num',
      projectId: 'my_project',
      connectionProperties: [{key: 'session_id', value: 'test-bq-session-id'}],
    });
    expect(querySpy).toHaveBeenCalledTimes(2);
    for (const call of querySpy.mock.calls) {
      expect(call[0]?.connectionProperties).toEqual([
        {key: 'session_id', value: 'test-bq-session-id'},
      ]);
    }
  });

  it('creates a separate BigQuery session when the same session ID is used under a different userId or appName', async () => {
    const createdSessionIds = [
      'test-bq-session-id',
      'other-user-bq-session-id',
      'other-app-bq-session-id',
    ];
    let createSessionCallCount = 0;
    const dryRunSpy = vi
      .spyOn(BigQueryClient.prototype, 'dryRun')
      .mockImplementation(async (opts) => {
        if (opts.createSession) {
          const sessionId =
            createdSessionIds[createSessionCallCount] ?? 'fallback-session-id';
          createSessionCallCount += 1;
          return {
            statementType: 'SELECT',
            sessionInfo: {sessionId},
            destinationTable: {datasetId: `_anon_${sessionId}`},
          };
        }
        return {
          statementType: 'SELECT',
        };
      });
    const querySpy = vi
      .spyOn(BigQueryClient.prototype, 'query')
      .mockResolvedValue([]);

    await executeSql(
      {
        project_id: 'my_project',
        query: 'SELECT 123 AS num',
        credentials: mockCredentials,
        config: {writeMode: WriteMode.PROTECTED},
      },
      createSessionToolContext(
        'shared-session-id',
        {},
        {appName: 'app_one', userId: 'user_one'},
      ),
    );
    await executeSql(
      {
        project_id: 'my_project',
        query: 'SELECT 123 AS num',
        credentials: mockCredentials,
        config: {writeMode: WriteMode.PROTECTED},
      },
      createSessionToolContext(
        'shared-session-id',
        {},
        {appName: 'app_one', userId: 'user_two'},
      ),
    );
    await executeSql(
      {
        project_id: 'my_project',
        query: 'SELECT 123 AS num',
        credentials: mockCredentials,
        config: {writeMode: WriteMode.PROTECTED},
      },
      createSessionToolContext(
        'shared-session-id',
        {},
        {appName: 'app_two', userId: 'user_one'},
      ),
    );

    expect(createSessionCallCount).toBe(3);
    expect(dryRunSpy).toHaveBeenCalledTimes(6);
    expect(querySpy).toHaveBeenCalledTimes(3);
    expect(querySpy.mock.calls[0]?.[0]?.connectionProperties).toEqual([
      {key: 'session_id', value: 'test-bq-session-id'},
    ]);
    expect(querySpy.mock.calls[1]?.[0]?.connectionProperties).toEqual([
      {key: 'session_id', value: 'other-user-bq-session-id'},
    ]);
    expect(querySpy.mock.calls[2]?.[0]?.connectionProperties).toEqual([
      {key: 'session_id', value: 'other-app-bq-session-id'},
    ]);
  });

  it.each([
    {modeName: 'blocked', writeMode: WriteMode.BLOCKED},
    {modeName: 'protected', writeMode: WriteMode.PROTECTED},
    {modeName: 'allowed', writeMode: WriteMode.ALLOWED},
  ])(
    'executes query with configured credentials without falling back to default auth in $modeName mode',
    async ({writeMode}) => {
      let capturedClientOptions: Record<string, unknown> | undefined;
      const fakeSdkClient: BigQuerySdkClient = {
        getDatasets: async () => [[]],
        dataset: () => ({}),
        query: async () => [[{num: 123}]],
        createQueryJob: async () => [
          {
            id: 'job-1',
            metadata: {
              configuration: {
                query: {destinationTable: {datasetId: '_anonymous_dataset'}},
              },
              statistics: {
                sessionInfo: {sessionId: 'test-bq-session-id'},
                query: {statementType: 'SELECT'},
              },
            },
          },
        ],
      };
      const fakeModule: BigQuerySdkModule = {
        BigQuery: class {
          constructor(options: Record<string, unknown>) {
            capturedClientOptions = options;
            return fakeSdkClient;
          }
        } as unknown as BigQuerySdkModule['BigQuery'],
      };
      const clientWithFakeSdk = getBigQueryClient({
        projectId: 'my_project',
        credentials: mockCredentials,
        sdkLoader: async () => fakeModule,
      } as InternalGetBigQueryClientOptions);

      vi.restoreAllMocks();
      const originalDryRun = BigQueryClient.prototype.dryRun;
      const originalQuery = BigQueryClient.prototype.query;
      vi.spyOn(BigQueryClient.prototype, 'dryRun').mockImplementation((opts) =>
        originalDryRun.call(clientWithFakeSdk, opts),
      );
      vi.spyOn(BigQueryClient.prototype, 'query').mockImplementation((opts) =>
        originalQuery.call(clientWithFakeSdk, opts),
      );

      const result = await executeSql(
        {
          project_id: 'my_project',
          query: 'SELECT 123 AS num',
          credentials: mockCredentials,
          config: {writeMode},
        },
        createSessionToolContext(`no-default-auth-${writeMode}`),
      );

      expect(result).toEqual({status: 'SUCCESS', rows: [{num: 123}]});
      expect(capturedClientOptions?.['authClient']).toBeDefined();
    },
  );
});

describe('getExecuteSql and getExecuteSqlDescription', () => {
  const mockCredentials: GoogleOAuthCredentials = {
    token: 'test-token',
    valid: true,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns base description for default or WriteMode.BLOCKED config', () => {
    expect(getExecuteSqlDescription()).toContain(
      'Run a BigQuery or BigQuery ML SQL query in the project and return the result.',
    );
    expect(getExecuteSqlDescription()).toContain('At most 50 rows');
    expect(getExecuteSqlDescription()).not.toContain('CREATE TABLE');
    expect(
      getExecuteSqlDescription({writeMode: WriteMode.BLOCKED}),
    ).not.toContain('CREATE TABLE');
  });

  it('returns write examples in description when WriteMode.ALLOWED', () => {
    const desc = getExecuteSqlDescription({writeMode: WriteMode.ALLOWED});
    expect(desc).toContain('At most 50 rows');
    expect(desc).toContain('CREATE TABLE');
    expect(desc).toContain('INSERT INTO');
    expect(desc).toContain('DROP TABLE');
    expect(desc).toContain('CREATE MODEL');
    expect(desc).toContain('ML.EVALUATE');
    expect(desc).toContain('ML.PREDICT');
    expect(desc).toContain('DROP MODEL');
  });

  it('returns protected write examples in description when WriteMode.PROTECTED', () => {
    const desc = getExecuteSqlDescription({writeMode: WriteMode.PROTECTED});
    expect(desc).toContain('At most 50 rows');
    expect(desc).toContain('CREATE TEMP TABLE');
    expect(desc).toContain('CREATE TEMP MODEL');
    expect(desc).toContain('ML.EVALUATE(MODEL my_model)');
    expect(desc).toContain('ML.PREDICT(MODEL my_model');
    expect(desc).toContain('DROP MODEL my_model');
    expect(desc).toContain(
      'Only temporary tables can be created, inserted into or deleted.',
    );
  });

  it('enforces bound config precedence over args.config in getExecuteSql', async () => {
    const dryRunSpy = vi
      .spyOn(BigQueryClient.prototype, 'dryRun')
      .mockResolvedValue({statementType: 'DROP_TABLE'});
    const querySpy = vi.spyOn(BigQueryClient.prototype, 'query');

    const blockedExecutor = getExecuteSql({writeMode: WriteMode.BLOCKED});
    const result = await blockedExecutor({
      project_id: 'my_project',
      query: 'DROP TABLE dataset.t',
      credentials: mockCredentials,
      config: {writeMode: WriteMode.ALLOWED},
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Read-only mode only supports SELECT statements.',
    });
    expect(dryRunSpy).toHaveBeenCalledOnce();
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('allows write execution when getExecuteSql is configured with WriteMode.ALLOWED', async () => {
    const dryRunSpy = vi.spyOn(BigQueryClient.prototype, 'dryRun');
    const querySpy = vi
      .spyOn(BigQueryClient.prototype, 'query')
      .mockResolvedValue([]);

    const writeExecutor = getExecuteSql({writeMode: WriteMode.ALLOWED});
    const result = await writeExecutor({
      project_id: 'my_project',
      query: 'DROP TABLE dataset.t',
      credentials: mockCredentials,
    });

    expect(result).toEqual({status: 'SUCCESS', rows: []});
    expect(dryRunSpy).not.toHaveBeenCalled();
    expect(querySpy).toHaveBeenCalledOnce();
  });

  it('forwards toolContext and enforces WriteMode.PROTECTED in getExecuteSql', async () => {
    vi.spyOn(BigQueryClient.prototype, 'dryRun').mockImplementation(
      async (opts) => {
        if (opts.createSession) {
          return {
            statementType: 'SELECT',
            sessionInfo: {sessionId: 'executor-bq-session'},
            destinationTable: {datasetId: '_anonymous_dataset'},
          };
        }
        return {
          statementType: 'CREATE_AS_SELECT',
          destinationTable: {datasetId: '_anonymous_dataset'},
        };
      },
    );
    const querySpy = vi
      .spyOn(BigQueryClient.prototype, 'query')
      .mockResolvedValue([]);

    const protectedExecutor = getExecuteSql({writeMode: WriteMode.PROTECTED});
    const toolContext = createSessionToolContext('executor-protected-session');
    const result = await protectedExecutor(
      {
        project_id: 'my_project',
        query: 'CREATE TEMP TABLE my_table AS SELECT 1',
        credentials: mockCredentials,
      },
      toolContext,
    );

    expect(result).toEqual({status: 'SUCCESS', rows: []});
    expect(querySpy).toHaveBeenCalledWith({
      query: 'CREATE TEMP TABLE my_table AS SELECT 1',
      projectId: 'my_project',
      maxResults: 50,
      connectionProperties: [{key: 'session_id', value: 'executor-bq-session'}],
    });
  });
});

describe('BigQuery tools without a project_id', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('falls back to GOOGLE_CLOUD_PROJECT in listDatasetIds', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-gcp-project');
    const spy = vi
      .spyOn(BigQueryClient.prototype, 'listDatasets')
      .mockResolvedValue([{datasetId: 'dataset1'}]);

    const result = await listDatasetIds({});

    expect(result).toEqual(['dataset1']);
    expect(spy).toHaveBeenCalledWith('env-gcp-project');
  });

  it('falls back to GOOGLE_CLOUD_PROJECT when project_id is empty in getTableInfo', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-gcp-project');
    const spy = vi
      .spyOn(BigQueryClient.prototype, 'getTable')
      .mockResolvedValue({});

    await getTableInfo({project_id: '', dataset_id: 'ds', table_id: 'tbl'});

    expect(spy).toHaveBeenCalledWith({
      projectId: 'env-gcp-project',
      datasetId: 'ds',
      tableId: 'tbl',
    });
  });

  it('falls back to GOOGLE_CLOUD_PROJECT in executeSql', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-gcp-project');
    const dryRunSpy = vi
      .spyOn(BigQueryClient.prototype, 'dryRun')
      .mockResolvedValue({statementType: 'SELECT'});
    const spy = vi
      .spyOn(BigQueryClient.prototype, 'query')
      .mockResolvedValue([]);

    await executeSql({query: 'SELECT 1'});

    expect(dryRunSpy).toHaveBeenCalledWith({
      query: 'SELECT 1',
      projectId: 'env-gcp-project',
    });
    expect(spy).toHaveBeenCalledWith({
      query: 'SELECT 1',
      projectId: 'env-gcp-project',
      maxResults: 50,
    });
  });
});
