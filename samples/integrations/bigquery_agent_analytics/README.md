# BigQuery Agent Analytics Sample (`BigQueryAgentAnalyticsPlugin`)

This sample runs an `App` with `BigQueryAgentAnalyticsPlugin` from `@google/adk-integrations/bigquery`, which logs the agent's events to a BigQuery table.

## Overview

`order_assistant` is an `LlmAgent` with one `FunctionTool`, `lookup_order`, which returns a fixed order status. The `App` registers `BigQueryAgentAnalyticsPlugin`. On the first event the plugin creates the `agent_events` table and its views in the dataset, then writes a row for each user message, run, LLM request and response, and tool call.

## Prerequisites

Install the optional Google Cloud peer dependencies (Node.js 22 or later):

```bash
npm install @google-cloud/bigquery @google-cloud/bigquery-storage @google-cloud/storage
```

Authenticate with Application Default Credentials and point the sample at an existing dataset:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
export BIGQUERY_DATASET="an_existing_dataset"
```

## Sample Inputs

- `Where is order A-1001?`
- `Which carrier is delivering order B-2002?`

## Running the Sample

Build the workspace, then run the exported `app` through the ADK CLI:

```bash
npm run build
npm run sample -- samples/integrations/bigquery_agent_analytics/agent.ts
```

Then query the rows:

```sql
SELECT timestamp, event_type, agent, status
FROM `your-gcp-project-id.an_existing_dataset.agent_events`
ORDER BY timestamp DESC
LIMIT 20;
```

`samples/` is type-checked against the built package types:

```bash
npm run build
npm run ts:check:samples
```

## Related Guides

- [BigQuery agent analytics](../../../docs/guides/integrations/plugins/bigquery_agent_analytics_plugin/index.md) - Installation, configuration, table setup and differences from adk-python.
