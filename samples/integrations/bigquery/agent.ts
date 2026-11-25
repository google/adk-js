/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BigQuery Toolset (`BigQueryToolset`, `GoogleTool`, `BigQueryCredentialsConfig`, `BigQueryToolConfig`)
 * ../../../docs/guides/integrations/bigquery/index.md
 *
 * An `LlmAgent` equipped with `BigQueryToolset` from `@google/adk-integrations`
 * and a custom `GoogleTool` from `@google/adk` for inspecting BigQuery datasets
 * and tables and running SQL queries with configured write modes.
 *
 * Prerequisites:
 *   npm install @google-cloud/bigquery
 *   export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
 *   export GOOGLE_OAUTH_CLIENT_ID="your-oauth-client-id"
 *   export GOOGLE_OAUTH_CLIENT_SECRET="your-oauth-client-secret"
 *
 * Run:
 *   npm run build
 *   npm run sample -- samples/integrations/bigquery/agent.ts
 * Try "List datasets in project bigquery-public-data."
 */

import {GoogleTool, LlmAgent} from '@google/adk';
import {
  BigQueryCredentialsConfig,
  BigQueryToolConfig,
  BigQueryToolset,
  WriteMode,
} from '@google/adk-integrations';
import {z} from 'zod';

export const credentialsConfig = new BigQueryCredentialsConfig({
  clientId: process.env['GOOGLE_OAUTH_CLIENT_ID'] ?? 'sample-client-id',
  clientSecret:
    process.env['GOOGLE_OAUTH_CLIENT_SECRET'] ?? 'sample-client-secret',
});

export const toolConfig = new BigQueryToolConfig({
  writeMode: WriteMode.BLOCKED,
  maxQueryResultRows: 50,
});

export const bigQueryToolset = new BigQueryToolset({
  credentialsConfig,
  toolConfig,
  toolFilter: [
    'list_dataset_ids',
    'get_dataset_info',
    'list_table_ids',
    'get_table_info',
    'execute_sql',
    'ask_data_insights',
  ],
});

export const summarizeBigQueryTargetTool = new GoogleTool({
  name: 'summarize_bigquery_target',
  description:
    'Formats a fully-qualified BigQuery table identifier for a project, dataset, and table.',
  parameters: z.object({
    projectId: z.string().describe('Google Cloud project ID.'),
    datasetId: z.string().describe('BigQuery dataset ID.'),
    tableId: z.string().describe('BigQuery table ID.'),
  }),
  credentialsConfig,
  toolSettings: toolConfig,
  execute: async ({projectId, datasetId, tableId, credentials, settings}) => ({
    fullTableId: `${projectId}.${datasetId}.${tableId}`,
    authenticated: credentials !== undefined,
    writeMode: settings?.writeMode,
  }),
});

export const rootAgent = new LlmAgent({
  name: 'bigquery_data_assistant',
  model: 'gemini-flash-latest',
  description:
    'Explores BigQuery datasets and tables and runs SQL queries using BigQueryToolset.',
  instruction:
    'You are a BigQuery data assistant. Use the BigQuery metadata tools to ' +
    'inspect datasets and tables before running SQL queries with execute_sql.',
  tools: [bigQueryToolset, summarizeBigQueryTargetTool],
});
