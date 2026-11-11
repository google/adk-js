/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import type {BigQueryCredentials} from './bigquery_credentials.js';
import {getBigQueryClient} from './client.js';
import {
  type BigQueryToolErrorResult,
  toBigQueryToolErrorResult,
} from './tool_error.js';

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
  /**
   * Google Cloud project ID. Falls back to `GOOGLE_CLOUD_PROJECT` when omitted
   * or empty.
   */
  project_id?: string;

  /**
   * Credentials injected by {@link BigQueryTool}.
   */
  credentials?: BigQueryCredentials;
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
export interface GetDatasetInfoArgs extends ListDatasetIdsArgs {
  /**
   * BigQuery dataset ID.
   */
  dataset_id: string;
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
export type ListTableIdsArgs = GetDatasetInfoArgs;

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
export interface GetTableInfoArgs extends GetDatasetInfoArgs {
  /**
   * BigQuery table ID.
   */
  table_id: string;
}

/**
 * Lists BigQuery dataset IDs in a Google Cloud project.
 */
export async function listDatasetIds(
  args: ListDatasetIdsArgs,
): Promise<string[] | BigQueryToolErrorResult> {
  try {
    const bqClient = getBigQueryClient({
      projectId: args.project_id,
      credentials: args.credentials,
      userAgent: 'list_dataset_ids',
    });
    const datasets = await bqClient.listDatasets(bqClient.projectId);
    return datasets.map((dataset) => dataset.datasetId);
  } catch (error: unknown) {
    return toBigQueryToolErrorResult(error);
  }
}

/**
 * Fetches metadata information about a BigQuery dataset.
 */
export async function getDatasetInfo(
  args: GetDatasetInfoArgs,
): Promise<Record<string, unknown> | BigQueryToolErrorResult> {
  try {
    const bqClient = getBigQueryClient({
      projectId: args.project_id,
      credentials: args.credentials,
      userAgent: 'get_dataset_info',
    });
    return await bqClient.getDataset({
      projectId: bqClient.projectId,
      datasetId: args.dataset_id,
    });
  } catch (error: unknown) {
    return toBigQueryToolErrorResult(error);
  }
}

/**
 * Lists table IDs in a BigQuery dataset.
 */
export async function listTableIds(
  args: ListTableIdsArgs,
): Promise<string[] | BigQueryToolErrorResult> {
  try {
    const bqClient = getBigQueryClient({
      projectId: args.project_id,
      credentials: args.credentials,
      userAgent: 'list_table_ids',
    });
    const tables = await bqClient.listTables({
      projectId: bqClient.projectId,
      datasetId: args.dataset_id,
    });
    return tables.map((table) => table.tableId);
  } catch (error: unknown) {
    return toBigQueryToolErrorResult(error);
  }
}

/**
 * Fetches metadata information about a BigQuery table.
 */
export async function getTableInfo(
  args: GetTableInfoArgs,
): Promise<Record<string, unknown> | BigQueryToolErrorResult> {
  try {
    const bqClient = getBigQueryClient({
      projectId: args.project_id,
      credentials: args.credentials,
      userAgent: 'get_table_info',
    });
    return await bqClient.getTable({
      projectId: bqClient.projectId,
      datasetId: args.dataset_id,
      tableId: args.table_id,
    });
  } catch (error: unknown) {
    return toBigQueryToolErrorResult(error);
  }
}
