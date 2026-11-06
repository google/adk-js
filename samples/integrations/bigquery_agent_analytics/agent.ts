/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BigQuery Agent Analytics Plugin (`BigQueryAgentAnalyticsPlugin`)
 * ../../../docs/guides/integrations/plugins/bigquery_agent_analytics_plugin/index.md
 *
 * Demonstrates exporting ADK agent lifecycle events (invocations, model requests,
 * tool calls) to Google Cloud BigQuery using `@google/adk-integrations`.
 *
 * Prerequisites:
 *   npm install @google-cloud/bigquery @google-cloud/bigquery-storage
 *   gcloud auth application-default login
 *   export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
 *   export BIGQUERY_DATASET="your_dataset_id"
 *
 * Run:
 *   npm run build
 *   npm run sample -- samples/integrations/bigquery_agent_analytics/agent.ts
 * Try "Check the operational status of server web-01."
 */

import {App, FunctionTool, LlmAgent} from '@google/adk';
import {BigQueryAgentAnalyticsPlugin} from '@google/adk-integrations';
import {z} from 'zod';

const projectId = process.env['GOOGLE_CLOUD_PROJECT'] ?? 'sample-project';
const datasetId = process.env['BIGQUERY_DATASET'] ?? 'agent_analytics';

export const checkServerStatusTool = new FunctionTool({
  name: 'check_server_status',
  description: 'Checks the operational health and uptime of a server.',
  parameters: z.object({
    serverId: z.string().describe('Identifier of the server to check.'),
  }),
  execute: async ({serverId}) => {
    return {
      serverId,
      status: 'HEALTHY',
      uptimeHours: 342,
      activeConnections: 18,
    };
  },
});

export const rootAgent = new LlmAgent({
  name: 'ops_assistant',
  model: 'gemini-flash-latest',
  description: 'Monitors server infrastructure and answers operations queries.',
  instruction:
    'You are an IT operations assistant. When asked about server health or ' +
    'status, call check_server_status and summarize the operational metrics.',
  tools: [checkServerStatusTool],
});

export const analyticsPlugin = new BigQueryAgentAnalyticsPlugin({
  projectId,
  datasetId,
  tableId: 'agent_events',
  config: {
    batchSize: 1,
    flushOnRunEnd: true,
  },
});

export const app = new App({
  name: 'bigquery_analytics_sample',
  rootAgent,
  plugins: [analyticsPlugin],
});
