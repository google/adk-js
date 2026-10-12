# Examples Sample (`samples/examples`)

This sample demonstrates how to use the `@google/adk` `examples` subsystem (`Example`, `BaseExampleProvider`, and `example_util`) alongside `InMemoryRunner` and `UnsafeLocalCodeExecutor`.

## Overview

- Defines a custom `InMemoryExampleProvider` extending `BaseExampleProvider` to supply structured few-shot `Example` pairs.
- Configures an `LlmAgent` with `UnsafeLocalCodeExecutor` and runs it via `InMemoryRunner`.
- Instantiates `VertexAiExampleStore` both with a single resource-name argument (using the built-in `VertexAiExampleStoreApiClient`) and with a custom `ExampleStoreApiClient` for offline testing.
- Attaches `ExampleTool` to `rootAgent` and exercises `validateExamples`, `convertExamplesToText`, `buildExampleSi`, and `getLatestMessageFromUser`.

## Running the Sample

```bash
export GEMINI_API_KEY="your-api-key"
npx tsx samples/examples/agent.ts
```

The `main()` entrypoint runs offline without an API key or Google Cloud credentials to inspect the rendered `<EXAMPLES>` system-instruction blocks. To run `rootAgent` interactively against the live model through the ADK CLI, build the workspace first:

```bash
npm run build
npm run sample -- samples/examples/agent.ts
```

Type-check `samples/` separately with:

```bash
npm run ts:check:samples
```

## Related Guides

- [Examples Guide](../../docs/guides/examples/index.md) - `Example`, `BaseExampleProvider`, `VertexAiExampleStore`, `VertexAiExampleStoreApiClient`, `ExampleTool`, and prompt-formatting utilities.
