# Anthropic API Sample (`AnthropicLlm`)

This sample demonstrates how to run an `LlmAgent` backed by `AnthropicLlm` from `@google/adk-integrations` using the direct Anthropic Messages API, including nested tool parameter schema conversion and structured object tool-result serialization.

## Overview

`anthropic_shipping_assistant` is an `LlmAgent` configured with `new AnthropicLlm({model: 'claude-sonnet-5-5'})`. Because `AnthropicLlm` is not registered in `LLMRegistry` by default, the agent receives an `AnthropicLlm` instance directly. It exposes one `FunctionTool`, `estimate_shipping`, which:

1. Declares nested `destination` and `packageDetails` objects via Zod (`z.object`), exercising the conversion of nested tool schemas to JSON Schema.
2. Returns a structured object (`totalUsd`, `currency`, `estimatedTransitDays`, and destination metadata), exercising JSON serialization of tool results.

## Prerequisites

Install the optional `@anthropic-ai/sdk` peer dependency required by `AnthropicLlm`:

```bash
npm install @anthropic-ai/sdk
```

Set your Anthropic API key in the environment:

```bash
export ANTHROPIC_API_KEY="your-anthropic-api-key"
```

Set `ADK_SAMPLE_ANTHROPIC_MODEL` to override the default `'claude-sonnet-5-5'` model identifier if needed.

## Sample Inputs

- `Estimate express shipping for a 2.5 kg package to Tokyo, Japan (postal code 100-0001).`
- `How much does standard shipping cost for a 4 kg package to Berlin, Germany?`

## Running the Sample

Build the workspace, then run the exported `rootAgent` through the ADK CLI:

```bash
npm run build
npm run sample -- samples/integrations/anthropic/agent.ts
```

To open the agent in the ADK web UI, start the web server on the `samples/integrations` directory and select `anthropic`:

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

- [Anthropic Claude](../../../docs/guides/integrations/models/anthropic_llm/index.md) - `AnthropicLlm`, `Claude`, supported model IDs, function calling, and limitations.
- [Models](../../../docs/guides/models/index.md) - `BaseLlm`, `LlmRequest`, `LlmResponse`, `LLMRegistry`, and `Gemini`.
