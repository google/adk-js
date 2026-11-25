/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Spanner Toolset (`SpannerToolset`, `SpannerCredentialsConfig`, `SpannerToolSettings`)
 * ../../../docs/guides/integrations/spanner/index.md
 *
 * An `LlmAgent` equipped with `SpannerToolset` from `@google/adk-integrations`
 * for inspecting Cloud Spanner schemas, tables, and indexes and executing
 * read-only SQL queries.
 *
 * Prerequisites:
 *   npm install @google-cloud/spanner
 *   export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
 *   export GOOGLE_OAUTH_CLIENT_ID="your-oauth-client-id"
 *   export GOOGLE_OAUTH_CLIENT_SECRET="your-oauth-client-secret"
 *
 * Run:
 *   npm run build
 *   npm run sample -- samples/integrations/spanner/agent.ts
 * Try "List the tables in instance my-instance and database my-database."
 */

import {LlmAgent} from '@google/adk';
import {
  SpannerCapabilities,
  SpannerCredentialsConfig,
  SpannerToolset,
  SpannerToolSettings,
} from '@google/adk-integrations';

export const credentialsConfig = new SpannerCredentialsConfig({
  clientId: process.env['GOOGLE_OAUTH_CLIENT_ID'] ?? 'sample-client-id',
  clientSecret:
    process.env['GOOGLE_OAUTH_CLIENT_SECRET'] ?? 'sample-client-secret',
});

export const toolSettings = new SpannerToolSettings({
  capabilities: [SpannerCapabilities.DATA_READ],
  maxExecutedQueryResultRows: 50,
});

export const spannerToolset = new SpannerToolset({
  credentialsConfig,
  spannerToolSettings: toolSettings,
  toolFilter: [
    'list_table_names',
    'get_table_schema',
    'list_table_indexes',
    'list_table_index_columns',
    'list_named_schemas',
    'execute_sql',
  ],
});

export const rootAgent = new LlmAgent({
  name: 'spannerDataAssistant',
  model: 'gemini-flash-latest',
  description:
    'Explores Cloud Spanner schemas and tables and runs read-only SQL queries using SpannerToolset.',
  instruction:
    'You are a Cloud Spanner data assistant. Use the Spanner metadata tools ' +
    'to inspect schemas, tables, and indexes before running read-only SQL ' +
    'queries with spanner_execute_sql.',
  tools: [spannerToolset],
});
