# BigQuery Agent Analytics Plugin Sample (`BigQueryAgentAnalyticsPlugin`)

This sample demonstrates how to record ADK agent lifecycle events (invocations, model requests and responses, and tool executions) to Google Cloud BigQuery using `BigQueryAgentAnalyticsPlugin` from `@google/adk-integrations`.

## Overview

The sample configures `ops_assistant`, an `LlmAgent` equipped with `check_server_status` (a `FunctionTool` defined with Zod parameters), and registers `BigQueryAgentAnalyticsPlugin` on an ADK `App`.

When user interactions occur:
1. `INVOCATION_STARTING` and `INVOCATION_COMPLETED` record turn lifecycle boundaries.
2. `LLM_REQUEST` and `LLM_RESPONSE` record model interactions, configuration parameters, and token usage metrics.
3. `TOOL_STARTING` and `TOOL_COMPLETED` record tool invocations and structured outputs.
4. Rows are batched in memory and written to BigQuery using the Storage Write API with automatic retries and trace correlation.

## Prerequisites

Install the optional BigQuery peer dependencies:

```bash
npm install @google-cloud/bigquery @google-cloud/bigquery-storage
```

Authenticate with Google Cloud Application Default Credentials and configure target project and dataset:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
export BIGQUERY_DATASET="your_dataset_id"
```

## Sample Inputs

- `Check the operational status of server web-01.`
- `How is server db-replica-02 performing?`

## Running the Sample

Build the workspace, then run the exported `app` through the ADK CLI:

```bash
npm run build
npm run sample -- samples/integrations/bigquery_agent_analytics/agent.ts
```

To run the sample in the ADK web UI:

```bash
node dev/dist/esm/cli_entrypoint.js web samples/integrations
```

Type-check sample code against built package types:

```bash
npm run build
npm run ts:check:samples
```

## Related Guides

- [BigQuery Agent Analytics Plugin](../../../docs/guides/integrations/plugins/bigquery_agent_analytics_plugin/index.md) - Configuration options, schema definition, and analysis queries.
- [Plugins Guide](../../../docs/guides/plugins/index.md) - ADK plugin lifecycle and interception callbacks.
