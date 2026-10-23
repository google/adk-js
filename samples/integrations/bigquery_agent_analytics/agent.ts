/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BigQuery agent analytics (`BigQueryAgentAnalyticsPlugin`)
 * ../../../docs/guides/integrations/plugins/bigquery_agent_analytics_plugin/index.md
 *
 * An `App` whose `LlmAgent` answers order questions with a `FunctionTool`
 * (`lookup_order`). `BigQueryAgentAnalyticsPlugin` logs the run, the LLM
 * requests and responses and the tool calls to a BigQuery table.
 *
 * Prerequisites:
 *   npm install @google-cloud/bigquery @google-cloud/bigquery-storage @google-cloud/storage
 *   gcloud auth application-default login
 *   export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
 *   export BIGQUERY_DATASET="an_existing_dataset"
 *
 * Run:
 *   npm run build
 *   npm run sample -- samples/integrations/bigquery_agent_analytics/agent.ts
 * Try "Where is order A-1001?"
 */

import {App, FunctionTool, LlmAgent} from '@google/adk';
import {BigQueryAgentAnalyticsPlugin} from '@google/adk-integrations/bigquery';
import {z} from 'zod';

const projectId = process.env['GOOGLE_CLOUD_PROJECT'] ?? 'your-gcp-project-id';
const datasetId = process.env['BIGQUERY_DATASET'] ?? 'agent_analytics';

export const lookupOrderTool = new FunctionTool({
  name: 'lookup_order',
  description: 'Looks up the status and carrier of an order.',
  parameters: z.object({
    orderId: z.string().describe('Order identifier, such as A-1001.'),
  }),
  execute: async ({orderId}) => ({
    orderId,
    status: 'SHIPPED',
    carrier: 'Example Freight',
    estimatedDeliveryDays: 2,
  }),
});

export const rootAgent = new LlmAgent({
  name: 'order_assistant',
  model: 'gemini-flash-latest',
  description: 'Answers questions about customer orders.',
  instruction:
    'Answer questions about orders. Call lookup_order for the order the ' +
    'user names and summarize its status.',
  tools: [lookupOrderTool],
});

export const analyticsPlugin = new BigQueryAgentAnalyticsPlugin({
  projectId,
  datasetId,
});

export const app = new App({
  name: 'bigquery_agent_analytics',
  rootAgent,
  plugins: [analyticsPlugin],
});
