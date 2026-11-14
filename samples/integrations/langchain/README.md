# LangChain Tool Sample (`LangchainTool`)

This sample demonstrates how to wrap LangChain-compatible tools with `LangchainTool` from `@google/adk-integrations` and attach them to an ADK `LlmAgent`.

## Overview

`langchain_tools_assistant` is an `LlmAgent` using `model: 'gemini-flash-latest'` equipped with two `LangchainTool` wrappers:

1. `convertTemperatureTool`: wraps a structured `LangchainToolLike` object with a Zod `schema` (`z.object`) and an `invoke` method via `new LangchainTool({tool: ...})`.
2. `lookupReferenceTool`: wraps a convention-based tool with a raw `args` property map and a `run` method, overriding its `name` and `description` via `new LangchainTool(tool, options)`.

## Prerequisites

`LangchainTool` accepts duck-typed `LangchainToolLike` objects, so no extra LangChain packages are required for this sample. Set your Gemini API key in the environment:

```bash
export GEMINI_API_KEY="your-gemini-api-key"
```

## Sample Inputs

- `Convert 72 Fahrenheit to Celsius.`
- `What are the freezing and boiling points of water?`

## Running the Sample

Build the workspace, then run the exported `rootAgent` through the ADK CLI:

```bash
npm run build
npm run sample -- samples/integrations/langchain/agent.ts
```

To open the agent in the ADK web UI, start the web server on the `samples/integrations` directory and select `langchain`:

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

- [LangChain tool](../../../docs/guides/integrations/langchain/index.md) - `LangchainTool`, `isLangchainTool`, configuration options, and runner resolution order.
- [Tools](../../../docs/guides/tools/index.md) - `BaseTool`, `FunctionTool`, and tool lifecycle in ADK.
