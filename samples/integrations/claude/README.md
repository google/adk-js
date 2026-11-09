# Claude on Vertex AI Sample (`Claude`)

This sample demonstrates how to run an `LlmAgent` backed by `Claude` from `@google/adk-integrations` on Google Cloud Vertex AI, including nested tool parameter schema conversion and structured object tool-result serialization.

## Overview

`claude_shipping_assistant` is an `LlmAgent` configured with `new Claude({model: 'claude-sonnet-4-6@default'})` (and `LLMRegistry.register(Claude)` for string-based model resolution). It exposes one `FunctionTool`, `estimate_shipping`, which:

1. Declares nested `destination` and `packageDetails` objects via Zod (`z.object`), exercising the conversion of nested tool schemas to JSON Schema.
2. Returns a structured object (`totalUsd`, `currency`, `estimatedTransitDays`, and destination metadata), exercising JSON serialization of tool results.

## Prerequisites

Install the optional Anthropic peer dependencies required by `Claude`:

```bash
npm install @anthropic-ai/sdk @anthropic-ai/vertex-sdk
```

Authenticate with Google Cloud Application Default Credentials and set your Vertex AI project and region:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
export GOOGLE_CLOUD_LOCATION="global"
```

Set `ADK_SAMPLE_CLAUDE_MODEL` to override the default `'claude-sonnet-4-6@default'` model identifier if needed.

## Sample Inputs

- `Estimate express shipping for a 2.5 kg package to Tokyo, Japan (postal code 100-0001).`
- `How much does standard shipping cost for a 4 kg package to Berlin, Germany?`

## Running the Sample

Build the workspace, then run the exported `rootAgent` through the ADK CLI:

```bash
npm run build
npm run sample -- samples/integrations/claude/agent.ts
```

To open the agent in the ADK web UI, start the web server on the `samples/integrations` directory and select `claude`:

```bash
adk web samples/integrations
```

Inside this repository, without the global `adk` command installed, run the CLI from the build output:

```bash
node dev/dist/esm/cli_entrypoint.js web samples/integrations
```

`samples/` is type-checked against the built package types:

```bash
npm run build
npm run ts:check:samples
```

## Related Guides

- [Claude on Vertex AI](../../../docs/guides/integrations/models/anthropic_llm/index.md) - `Claude`, supported Vertex AI model IDs, function calling, and limitations.
- [Models](../../../docs/guides/models/index.md) - `BaseLlm`, `LlmRequest`, `LlmResponse`, `LLMRegistry`, and `Gemini`.
