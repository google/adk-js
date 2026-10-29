/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import type {GoogleOAuthCredentials} from './bigquery_credentials.js';
import {getBigQueryClient} from './client.js';

/**
 * Structured error result returned by BigQuery tools on failure.
 */
export interface BigQueryToolErrorResult {
  status: 'ERROR';
  error_details: string;
}

/**
 * Zod parameter schema for {@link listDatasetIds}.
 */
export const listDatasetIdsParameters = z.object({
  project_id: z.string().describe('The Google Cloud project id.'),
});

/**
 * Arguments accepted by {@link listDatasetIds}.
 */
export interface ListDatasetIdsArgs {
  project_id?: string;
  projectId?: string;
  credentials?: GoogleOAuthCredentials;
}

/**
 * Zod parameter schema for {@link getDatasetInfo}.
 */
export const getDatasetInfoParameters = z.object({
  project_id: z
    .string()
    .describe('The Google Cloud project id containing the dataset.'),
  dataset_id: z.string().describe('The BigQuery dataset id.'),
});

/**
 * Arguments accepted by {@link getDatasetInfo}.
 */
export interface GetDatasetInfoArgs {
  project_id?: string;
  projectId?: string;
  dataset_id?: string;
  datasetId?: string;
  credentials?: GoogleOAuthCredentials;
}

/**
 * Zod parameter schema for {@link listTableIds}.
 */
export const listTableIdsParameters = z.object({
  project_id: z
    .string()
    .describe('The Google Cloud project id containing the dataset.'),
  dataset_id: z.string().describe('The BigQuery dataset id.'),
});

/**
 * Arguments accepted by {@link listTableIds}.
 */
export interface ListTableIdsArgs {
  project_id?: string;
  projectId?: string;
  dataset_id?: string;
  datasetId?: string;
  credentials?: GoogleOAuthCredentials;
}

/**
 * Zod parameter schema for {@link getTableInfo}.
 */
export const getTableInfoParameters = z.object({
  project_id: z
    .string()
    .describe('The Google Cloud project id containing the dataset.'),
  dataset_id: z
    .string()
    .describe('The BigQuery dataset id containing the table.'),
  table_id: z.string().describe('The BigQuery table id.'),
});

/**
 * Arguments accepted by {@link getTableInfo}.
 */
export interface GetTableInfoArgs {
  project_id?: string;
  projectId?: string;
  dataset_id?: string;
  datasetId?: string;
  table_id?: string;
  tableId?: string;
  credentials?: GoogleOAuthCredentials;
}

/**
 * Lists BigQuery dataset IDs in a Google Cloud project.
 */
export async function listDatasetIds(
  args: ListDatasetIdsArgs,
): Promise<string[] | BigQueryToolErrorResult> {
  try {
    const projectId = args.project_id ?? args.projectId ?? '';
    const bqClient = getBigQueryClient({
      project: projectId,
      credentials: args.credentials,
      userAgent: 'list_dataset_ids',
    });
    const datasets = await bqClient.listDatasets(projectId);
    return datasets.map((dataset) => dataset.datasetId);
  } catch (error: unknown) {
    return {
      status: 'ERROR',
      error_details: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Fetches metadata information about a BigQuery dataset.
 */
export async function getDatasetInfo(
  args: GetDatasetInfoArgs,
): Promise<Record<string, unknown> | BigQueryToolErrorResult> {
  try {
    const projectId = args.project_id ?? args.projectId ?? '';
    const datasetId = args.dataset_id ?? args.datasetId ?? '';
    const bqClient = getBigQueryClient({
      project: projectId,
      credentials: args.credentials,
      userAgent: 'get_dataset_info',
    });
    return await bqClient.getDataset({projectId, datasetId});
  } catch (error: unknown) {
    return {
      status: 'ERROR',
      error_details: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Lists table IDs in a BigQuery dataset.
 */
export async function listTableIds(
  args: ListTableIdsArgs,
): Promise<string[] | BigQueryToolErrorResult> {
  try {
    const projectId = args.project_id ?? args.projectId ?? '';
    const datasetId = args.dataset_id ?? args.datasetId ?? '';
    const bqClient = getBigQueryClient({
      project: projectId,
      credentials: args.credentials,
      userAgent: 'list_table_ids',
    });
    const tables = await bqClient.listTables({projectId, datasetId});
    return tables.map((table) => table.tableId);
  } catch (error: unknown) {
    return {
      status: 'ERROR',
      error_details: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Fetches metadata information about a BigQuery table.
 */
export async function getTableInfo(
  args: GetTableInfoArgs,
): Promise<Record<string, unknown> | BigQueryToolErrorResult> {
  try {
    const projectId = args.project_id ?? args.projectId ?? '';
    const datasetId = args.dataset_id ?? args.datasetId ?? '';
    const tableId = args.table_id ?? args.tableId ?? '';
    const bqClient = getBigQueryClient({
      project: projectId,
      credentials: args.credentials,
      userAgent: 'get_table_info',
    });
    return await bqClient.getTable({projectId, datasetId, tableId});
  } catch (error: unknown) {
    return {
      status: 'ERROR',
      error_details: error instanceof Error ? error.message : String(error),
    };
  }
}
