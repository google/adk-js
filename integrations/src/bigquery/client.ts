/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '../version.js';
import type {GoogleOAuthCredentials} from './bigquery_credentials.js';

/**
 * Default User-Agent string sent on BigQuery API requests from ADK tools.
 */
export const USER_AGENT = `adk-bigquery-tool google-adk/${version}`;

const BIGQUERY_MODULE_SPECIFIER = '@google-cloud/bigquery';

/**
 * Reference identifying a BigQuery dataset within a Google Cloud project.
 */
export interface BigQueryDatasetReference {
  /**
   * Google Cloud project ID containing the dataset.
   */
  projectId: string;

  /**
   * BigQuery dataset ID.
   */
  datasetId: string;
}

/**
 * Reference identifying a BigQuery table within a dataset and project.
 */
export interface BigQueryTableReference {
  /**
   * Google Cloud project ID containing the dataset.
   */
  projectId: string;

  /**
   * BigQuery dataset ID containing the table.
   */
  datasetId: string;

  /**
   * BigQuery table ID.
   */
  tableId: string;
}

/**
 * Structural interface for a table handle in `@google-cloud/bigquery`.
 */
export interface BigQuerySdkTable {
  id?: string;
  metadata?: Record<string, unknown>;
  get?: () => Promise<[BigQuerySdkTable, Record<string, unknown>?]>;
}

/**
 * Structural interface for a dataset handle in `@google-cloud/bigquery`.
 */
export interface BigQuerySdkDataset {
  id?: string;
  metadata?: Record<string, unknown>;
  get?: () => Promise<[BigQuerySdkDataset, Record<string, unknown>?]>;
  getTables?: () => Promise<[BigQuerySdkTable[]]>;
  table?: (tableId: string) => BigQuerySdkTable;
}

/**
 * Structural interface for a `BigQuery` client instance from `@google-cloud/bigquery`.
 */
export interface BigQuerySdkClient {
  getDatasets(options?: {projectId?: string}): Promise<[BigQuerySdkDataset[]]>;
  dataset(
    datasetId: string,
    options?: {projectId?: string},
  ): BigQuerySdkDataset;
  query(options: {
    query: string;
    projectId?: string;
    location?: string;
    maxResults?: number;
  }): Promise<[Array<Record<string, unknown>>]>;
}

/**
 * Structural interface for the `@google-cloud/bigquery` module.
 */
export interface BigQuerySdkModule {
  BigQuery: new (options: Record<string, unknown>) => BigQuerySdkClient;
}

/**
 * Options for constructing a {@link BigQueryClient} via {@link getBigQueryClient}.
 */
export interface GetBigQueryClientOptions {
  /**
   * Google Cloud project ID. Falls back to `process.env['GOOGLE_CLOUD_PROJECT']`
   * when omitted or undefined.
   */
  project?: string;

  /**
   * OAuth2 or Google Auth credentials to authenticate BigQuery requests.
   */
  credentials?: GoogleOAuthCredentials;

  /**
   * Default geographic location for datasets and jobs.
   */
  location?: string;

  /**
   * Optional custom user-agent string or list of strings appended to {@link USER_AGENT}.
   */
  userAgent?: string | Array<string | undefined | null>;

  /**
   * Optional module loader override for `@google-cloud/bigquery`.
   */
  sdkLoader?: () => Promise<BigQuerySdkModule>;
}

async function importBigQueryModule(
  specifier = BIGQUERY_MODULE_SPECIFIER,
): Promise<BigQuerySdkModule> {
  try {
    return (await import(specifier)) as BigQuerySdkModule;
  } catch (cause: unknown) {
    throw new Error(
      `BigQuery integration requires the optional '${BIGQUERY_MODULE_SPECIFIER}' package. ` +
        `Install it with: npm install ${BIGQUERY_MODULE_SPECIFIER}`,
      {cause},
    );
  }
}

function buildUserAgent(
  customUserAgent?: string | Array<string | undefined | null>,
): string {
  const parts = [USER_AGENT];
  if (typeof customUserAgent === 'string') {
    if (customUserAgent.length > 0) {
      parts.push(customUserAgent);
    }
  } else if (Array.isArray(customUserAgent)) {
    for (const entry of customUserAgent) {
      if (typeof entry === 'string' && entry.length > 0) {
        parts.push(entry);
      }
    }
  }
  return parts.join(' ');
}

/**
 * Client wrapper around `@google-cloud/bigquery` used by ADK BigQuery tools.
 */
export class BigQueryClient {
  readonly project?: string;
  readonly credentials?: GoogleOAuthCredentials;
  readonly location?: string;
  readonly userAgent: string;
  private readonly sdkLoader: () => Promise<BigQuerySdkModule>;
  private sdkClientPromise?: Promise<BigQuerySdkClient>;

  constructor(options: GetBigQueryClientOptions = {}) {
    this.project = options.project ?? process.env['GOOGLE_CLOUD_PROJECT'];
    this.credentials = options.credentials;
    this.location = options.location;
    this.userAgent = buildUserAgent(options.userAgent);
    this.sdkLoader = options.sdkLoader ?? (() => importBigQueryModule());
  }

  /**
   * Lists the dataset references in the given Google Cloud project.
   */
  async listDatasets(projectId?: string): Promise<Array<{datasetId: string}>> {
    const sdk = await this.getSdkClient();
    const response = await sdk.getDatasets({
      projectId: projectId ?? this.project,
    });
    const datasets = response[0];
    return datasets.map((dataset) => ({datasetId: dataset.id ?? ''}));
  }

  /**
   * Fetches the metadata representation of a BigQuery dataset.
   */
  async getDataset(
    datasetRef: BigQueryDatasetReference,
  ): Promise<Record<string, unknown>> {
    const sdk = await this.getSdkClient();
    const dataset = sdk.dataset(datasetRef.datasetId, {
      projectId: datasetRef.projectId,
    });
    if (typeof dataset.get === 'function') {
      const response = await dataset.get();
      const resolved = response[0];
      const apiResponse = response[1];
      return apiResponse ?? resolved.metadata ?? {};
    }
    return dataset.metadata ?? {};
  }

  /**
   * Lists the table references in the given BigQuery dataset.
   */
  async listTables(
    datasetRef: BigQueryDatasetReference,
  ): Promise<Array<{tableId: string}>> {
    const sdk = await this.getSdkClient();
    const dataset = sdk.dataset(datasetRef.datasetId, {
      projectId: datasetRef.projectId,
    });
    if (typeof dataset.getTables !== 'function') {
      return [];
    }
    const response = await dataset.getTables();
    const tables = response[0];
    return tables.map((table) => ({tableId: table.id ?? ''}));
  }

  /**
   * Fetches the metadata representation of a BigQuery table.
   */
  async getTable(
    tableRef: BigQueryTableReference,
  ): Promise<Record<string, unknown>> {
    const sdk = await this.getSdkClient();
    const dataset = sdk.dataset(tableRef.datasetId, {
      projectId: tableRef.projectId,
    });
    if (typeof dataset.table !== 'function') {
      return {};
    }
    const table = dataset.table(tableRef.tableId);
    if (typeof table.get === 'function') {
      const response = await table.get();
      const resolved = response[0];
      const apiResponse = response[1];
      return apiResponse ?? resolved.metadata ?? {};
    }
    return table.metadata ?? {};
  }

  /**
   * Executes a SQL query and waits for its result rows.
   */
  async queryAndWait(
    query: string,
    options?: {project?: string; maxResults?: number},
  ): Promise<Array<Record<string, unknown>>> {
    const sdk = await this.getSdkClient();
    const response = await sdk.query({
      query,
      projectId: options?.project ?? this.project,
      location: this.location,
      maxResults: options?.maxResults,
    });
    return response[0];
  }

  private getSdkClient(): Promise<BigQuerySdkClient> {
    this.sdkClientPromise ??= this.createSdkClient().catch((err: unknown) => {
      this.sdkClientPromise = undefined;
      throw err;
    });
    return this.sdkClientPromise;
  }

  private async createSdkClient(): Promise<BigQuerySdkClient> {
    const mod = await this.sdkLoader();
    if (typeof mod?.BigQuery !== 'function') {
      throw new Error(
        `Missing 'BigQuery' export from '${BIGQUERY_MODULE_SPECIFIER}'.`,
      );
    }

    const clientOptions: Record<string, unknown> = {
      userAgent: this.userAgent,
    };
    if (this.project !== undefined) {
      clientOptions['projectId'] = this.project;
    }
    if (this.location !== undefined) {
      clientOptions['location'] = this.location;
    }
    if (this.credentials !== undefined) {
      const token = this.credentials.token ?? this.credentials.accessToken;
      if (typeof token === 'string' && token.length > 0) {
        clientOptions['authClient'] = {
          getRequestHeaders: async () => ({
            Authorization: `Bearer ${token}`,
          }),
          getAccessToken: async () => ({token}),
        };
      }
      clientOptions['credentials'] = this.credentials;
    }

    return new mod.BigQuery(clientOptions);
  }
}

/**
 * Creates a {@link BigQueryClient} configured with the given project,
 * credentials, location, and user agent.
 */
export function getBigQueryClient(
  options: GetBigQueryClientOptions = {},
): BigQueryClient {
  return new BigQueryClient(options);
}
