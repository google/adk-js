/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BIGQUERY_USER_AGENT,
  type BigQueryAuthClient,
  BigQueryClient,
  executeSql,
  getBigQueryClient,
  getDatasetInfo,
  getTableInfo,
  type GoogleOAuthCredentials,
  listDatasetIds,
  listTableIds,
} from '@google/adk-integrations';
import {afterEach, describe, expect, it, vi} from 'vitest';

import type {
  BigQuerySdkClient,
  BigQuerySdkModule,
  InternalGetBigQueryClientOptions,
} from '../../src/bigquery/client.js';

describe('getBigQueryClient and BigQueryClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // reference: test_bigquery_client_default
  it('uses the given project and no default location', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    const client = getBigQueryClient({
      projectId: 'test-gcp-project',
      credentials: {valid: true},
    });

    expect(client.projectId).toBe('test-gcp-project');
    expect(client.location).toBeUndefined();
  });

  // reference: test_bigquery_client_project_set_with_env
  it('falls back to GOOGLE_CLOUD_PROJECT when projectId is omitted', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-gcp-project');
    const client = getBigQueryClient({
      credentials: {valid: true},
    });

    expect(client.projectId).toBe('env-gcp-project');
  });

  // reference: test_bigquery_client_location_custom
  it('keeps a custom location', () => {
    const client = getBigQueryClient({
      projectId: 'test-gcp-project',
      credentials: {valid: true},
      location: 'us-central1',
    });

    expect(client.projectId).toBe('test-gcp-project');
    expect(client.location).toBe('us-central1');
  });

  // reference: test_bigquery_client_user_agent_default
  it('sends the default user agent', () => {
    const client = getBigQueryClient({
      projectId: 'test-gcp-project',
      credentials: {valid: true},
    });

    expect(client.userAgent).toBe(BIGQUERY_USER_AGENT);
  });

  // reference: test_bigquery_client_user_agent_custom
  it('appends a custom user agent string', () => {
    const client = getBigQueryClient({
      projectId: 'test-gcp-project',
      credentials: {valid: true},
      userAgent: 'custom_user_agent',
    });

    expect(client.userAgent).toBe(`${BIGQUERY_USER_AGENT} custom_user_agent`);
  });

  // reference: test_bigquery_client_user_agent_custom_list
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
});

describe('BigQuery metadata tools', () => {
  const mockCredentials: GoogleOAuthCredentials = {
    token: 'test-token',
    valid: true,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // reference: test_list_dataset_ids_no_default_auth
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

  // reference: test_get_dataset_info_no_default_auth
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

  // reference: test_list_table_ids_no_default_auth
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

  // reference: test_get_table_info_no_default_auth
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
    const spy = vi
      .spyOn(BigQueryClient.prototype, 'query')
      .mockResolvedValue([]);

    await executeSql({query: 'SELECT 1'});

    expect(spy).toHaveBeenCalledWith({
      query: 'SELECT 1',
      projectId: 'env-gcp-project',
      maxResults: 50,
    });
  });
});
