# Examples Sample (`samples/examples`)

This sample demonstrates how to use the `@google/adk` `examples` subsystem (`Example`, `BaseExampleProvider`, and `example_util`) alongside `InMemoryRunner` and `UnsafeLocalCodeExecutor`.

## Overview

- Defines a custom `InMemoryExampleProvider` extending `BaseExampleProvider` to supply structured few-shot `Example` pairs.
- Configures an `LlmAgent` with `UnsafeLocalCodeExecutor` and runs it via `InMemoryRunner`.

## Running the Sample

```bash
export GEMINI_API_KEY="your-api-key"
npx tsx samples/examples/agent.ts
```
