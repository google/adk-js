# Models Sample (`BaseLlm`, `LlmRequest`, `LlmResponse`, and `LLMRegistry`)

This sample demonstrates how to drive a model directly from a custom `BaseAgent`: build an `LlmRequest`, resolve a `BaseLlm` by name through `LLMRegistry`, and turn each `LlmResponse` into an event.

## Overview

`models_showcase_agent` is a `BaseAgent` subclass. For each user message, its `runAsyncImpl`:

1. Builds an `LlmRequest` from `ctx.userContent`.
2. Adds a two-part system instruction with `appendInstructions`, which joins the parts with a blank line.
3. Creates the model with `LLMRegistry.newLlm(modelName)`.
4. Yields each `LlmResponse` from `generateContentAsync` as an event built with `createEvent`.

`runLiveImpl` delegates to `runAsyncImpl`.

The default model name is `echo-v1`. The sample registers `EchoLlm`, a `BaseLlm` subclass whose `supportedModels` pattern is `echo-v1|echo-v2`. The registry matches a pattern against the whole model name, so `echo-v1` and `echo-v2` resolve to `EchoLlm` and `echo-v10` does not.

`EchoLlm` makes no network call. It builds a `GenerateContentResponse` that repeats the last user message and gives the length of the system instruction, and converts it to an `LlmResponse` with `createLlmResponse`.

## Sample Inputs

- `Hello models`

  _Answers `echo-v1 heard: Hello models (system instruction: N characters)`. N is the length of the instruction that `appendInstructions` built._

## Running the Sample

With the default model, the sample runs offline and needs no API key. Build the workspace, then run the exported `rootAgent` through the ADK CLI:

```bash
npm run build
npm run sample -- samples/models/agent.ts
```

To open it in the ADK web UI, start the web server on the `samples` directory and select `models`:

```bash
adk web samples
```

Inside this repository, without the `adk` command installed, run the same CLI from the build output:

```bash
node dev/dist/esm/cli_entrypoint.js web samples
```

Set `ADK_SAMPLE_MODEL` to use a different registered model. A Gemini model needs `GEMINI_API_KEY`:

```bash
GEMINI_API_KEY=... ADK_SAMPLE_MODEL=gemini-flash-latest npm run sample -- samples/models/agent.ts
```

`samples/` is not an npm workspace, so it is type-checked separately:

```bash
npm run ts:check:samples
```

## Related Guides

- [Models](../../docs/guides/models/index.md) - `BaseLlm`, `LlmRequest`, `LlmResponse`, `LLMRegistry`, and `Gemini`.
