# LangChain Tool Sample (`LangchainTool`)

This sample demonstrates how to adapt tools following the LangChain tool interface into ADK `FunctionTool` instances using `LangchainTool` from `@google/adk-integrations`.

## Overview

`langchain_assistant` is an `LlmAgent` using `gemini-flash-latest` configured with two adapted LangChain tools:

1. `unitConverterTool`: A structured tool using a Zod schema and an `invoke` method. It converts between distance, weight, and temperature units.
2. `wordCounterTool`: A convention-based tool using parameter property metadata and a `run` method. It counts words and characters in text.

`LangchainTool` accepts duck-typed tool objects conforming to `LangchainToolLike`, so installing third-party LangChain packages is optional.

## Prerequisites

Set your Gemini API key:

```bash
export GEMINI_API_KEY="your-gemini-api-key"
```

## Sample Inputs

- `How many miles is 42 kilometers?`
- `How many words are in the sentence: The quick brown fox jumps over the lazy dog?`
- `Convert 100 degrees Celsius to Fahrenheit, and count the words in this question.`

## Running the Sample

Build the packages, then run the exported `rootAgent` using the ADK CLI:

```bash
npm run build
npm run sample -- samples/integrations/langchain/agent.ts
```

To open the agent in the ADK web UI, launch the server on the integrations samples directory:

```bash
adk web samples/integrations
```

Type-check the samples against the built package types:

```bash
npm run build
npm run ts:check:samples
```

## Related Guides

- [LangChain tool](../../../docs/guides/integrations/langchain/index.md) - `LangchainTool`, supported tool interfaces, and schema extraction.
- [Tools](../../../docs/guides/tools/index.md) - `BaseTool`, `FunctionTool`, and tool execution in ADK.
