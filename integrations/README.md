# ADK Integrations

This package contains integrations for the Google ADK.

## BigQuery Agent Analytics

`BigQueryAgentAnalyticsPlugin`, from the `@google/adk-integrations/bigquery`
subpath, logs agent events to a BigQuery table through the Storage Write API.
It is a port of adk-python's `BigQueryAgentAnalyticsPlugin` and runs on Node.js
only. See the
[guide](../docs/guides/integrations/plugins/bigquery_agent_analytics_plugin/index.md)
and the [sample](../samples/integrations/bigquery_agent_analytics/README.md).

## Exa Search

Use `ExaSearchTool` on the server with a function-calling agent. Set
`EXA_API_KEY` in the server environment or pass `apiKey` to the constructor.

```ts
import {LlmAgent} from '@google/adk';
import {ExaSearchTool} from '@google/adk-integrations';

const agent = new LlmAgent({
  name: 'researcher',
  model: 'gemini-2.5-flash',
  instruction: 'Use exa_search to find and cite relevant web sources.',
  tools: [new ExaSearchTool()],
});
```

The tool defaults to Auto with five results and highlights. Each call returns
at most ten results. Set `contents: {text: true}` or
`contents: {summary: true}` on the tool for bounded page text or summaries.
Lite supports highlights and text. Use Auto for summaries.
