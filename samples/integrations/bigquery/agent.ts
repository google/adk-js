/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BigQuery Toolset (`BigQueryToolset`, `BigQueryTool`, `BigQueryCredentialsConfig`)
 * ../../../docs/guides/integrations/bigquery/index.md
 *
 * An `LlmAgent` equipped with `BigQueryToolset` and a custom `BigQueryTool`
 * from `@google/adk-integrations` for inspecting BigQuery datasets and tables
 * and running SQL queries.
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

import {LlmAgent} from '@google/adk';
import {
  BigQueryCredentialsConfig,
  BigQueryTool,
  BigQueryToolset,
} from '@google/adk-integrations';
import {z} from 'zod';

export const credentialsConfig = new BigQueryCredentialsConfig({
  clientId: process.env['GOOGLE_OAUTH_CLIENT_ID'] ?? 'sample-client-id',
  clientSecret:
    process.env['GOOGLE_OAUTH_CLIENT_SECRET'] ?? 'sample-client-secret',
});

export const bigQueryToolset = new BigQueryToolset({
  credentialsConfig,
  toolFilter: [
    'list_dataset_ids',
    'get_dataset_info',
    'list_table_ids',
    'get_table_info',
    'execute_sql',
  ],
});

export const summarizeQueryPlanTool = new BigQueryTool({
  name: 'summarize_bigquery_target',
  description:
    'Formats a fully-qualified BigQuery table identifier for a project, dataset, and table.',
  parameters: z.object({
    project_id: z.string().describe('Google Cloud project ID.'),
    dataset_id: z.string().describe('BigQuery dataset ID.'),
    table_id: z.string().describe('BigQuery table ID.'),
  }),
  credentials: credentialsConfig,
  func: async ({
    project_id,
    dataset_id,
    table_id,
    credentials,
  }: {
    project_id: string;
    dataset_id: string;
    table_id: string;
    credentials?: unknown;
  }) => ({
    fullTableId: `${project_id}.${dataset_id}.${table_id}`,
    authenticated: Boolean(credentials),
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
  tools: [bigQueryToolset, summarizeQueryPlanTool],
});
