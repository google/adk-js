# Anthropic Claude (`AnthropicLlm` and `Claude`)

`@google/adk-integrations` provides two `BaseLlm` implementations for Anthropic Claude models:

- `AnthropicLlm` connects an `LlmAgent` directly to the Anthropic Messages API using `ANTHROPIC_API_KEY`.
- `Claude` extends `AnthropicLlm` to call Claude models served on Google Cloud Vertex AI using `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`.

## Introduction

`AnthropicLlm` translates ADK `LlmRequest` payloads into Anthropic Messages API calls via `@anthropic-ai/sdk` and converts the returned `Anthropic.Message` into an `LlmResponse`. `Claude` inherits all request and response conversion from `AnthropicLlm` and overrides only `createClient()` to build an `AnthropicVertex` client from `@anthropic-ai/vertex-sdk`. The package exports `AnthropicLlm`, `AnthropicLlmParams`, `isAnthropicLlm`, `Claude`, `ClaudeParams`, and `isClaude`.

## Installation and environment setup

`@anthropic-ai/sdk` and `@anthropic-ai/vertex-sdk` are optional peer dependencies of `@google/adk-integrations`. Each SDK is loaded lazily via dynamic `import()` on the first model call so that applications only install the client they use.

### Direct Anthropic API (`AnthropicLlm`)

Install `@anthropic-ai/sdk` and set `ANTHROPIC_API_KEY`:

```bash
npm install @google/adk @google/adk-integrations @anthropic-ai/sdk
export ANTHROPIC_API_KEY="your-anthropic-api-key"
```

`AnthropicLlm` also accepts `ANTHROPIC_AUTH_TOKEN` or any credential provider resolved by `@anthropic-ai/sdk`. If no credential can be resolved, `AnthropicLlm` throws an error that names `ANTHROPIC_API_KEY` and notes that Vertex AI callers should use `Claude`.

### Vertex AI (`Claude`)

Install both `@anthropic-ai/sdk` and `@anthropic-ai/vertex-sdk`:

```bash
npm install @google/adk @google/adk-integrations @anthropic-ai/sdk @anthropic-ai/vertex-sdk
```

Authenticate with Google Cloud Application Default Credentials (`gcloud auth application-default login`) and set the Vertex AI project and location environment variables:

```bash
export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
export GOOGLE_CLOUD_LOCATION="global"
```

`GOOGLE_CLOUD_LOCATION` accepts `global` as well as regional Vertex AI endpoints where Claude models are served (such as `us-east5` or `europe-west1`). If either variable is unset or empty, `Claude` throws an error when creating the client and notes that `AnthropicLlm` can be used with `ANTHROPIC_API_KEY` for the direct Anthropic API.

## Get started

### Calling the Anthropic API directly with `AnthropicLlm`

Create an `AnthropicLlm` instance and pass it to `LlmAgent`:

```ts
import {LlmAgent} from '@google/adk';
import {AnthropicLlm} from '@google/adk-integrations';

export const rootAgent = new LlmAgent({
  name: 'anthropic_assistant',
  model: new AnthropicLlm({model: 'claude-sonnet-5-5'}),
  instruction: 'Answer questions concisely.',
});
```

When `model` is omitted (`new AnthropicLlm()`), it defaults to `'claude-sonnet-5-5'`. `AnthropicLlm` is not registered in `LLMRegistry` by default so that `claude-*` model strings continue to resolve to `Claude` when `Claude` is registered; pass a `new AnthropicLlm(...)` instance directly to `LlmAgent`.

### Passing a `Claude` instance for Vertex AI

Create a `Claude` instance and pass it to `LlmAgent`:

```ts
import {LlmAgent} from '@google/adk';
import {Claude} from '@google/adk-integrations';

export const rootAgent = new LlmAgent({
  name: 'claude_assistant',
  model: new Claude({model: 'claude-sonnet-4-6@default'}),
  instruction: 'Answer questions concisely.',
});
```

When `model` is omitted (`new Claude()`), it defaults to `'claude-sonnet-4-6@default'`. `isAnthropicLlm` returns `true` for both `AnthropicLlm` and `Claude` instances, whereas `isClaude` returns `true` only for `Claude` instances.

### Registering `Claude` with `LLMRegistry`

Register `Claude` once at startup so any `LlmAgent` can reference a Vertex AI `claude-*` model identifier by name:

```ts
import {LLMRegistry, LlmAgent} from '@google/adk';
import {Claude} from '@google/adk-integrations';

LLMRegistry.register(Claude);

export const rootAgent = new LlmAgent({
  name: 'claude_assistant',
  model: 'claude-sonnet-4-6@default',
  instruction: 'Answer questions concisely.',
});
```

## Supported models

`AnthropicLlm.supportedModels` and `Claude.supportedModels` define the pattern `/claude-.*/`, which matches any model identifier starting with `claude-`.

Model identifiers differ between the two APIs:

- **Anthropic API (`AnthropicLlm`)**: Uses plain model identifiers without `@` suffixes (such as `'claude-sonnet-5-5'`, `'claude-opus-5-5'`, `'claude-haiku-5-5'`, `'claude-sonnet-4-6'`, or `'claude-haiku-4-5-20251001'`). It does not accept Vertex AI `@default` or `@YYYYMMDD` version suffixes.
- **Vertex AI (`Claude`)**: Uses Vertex AI publisher model identifiers, which often include `@default` or `@YYYYMMDD` suffixes.

Current Claude model identifiers on Vertex AI include:

| Family        | Vertex AI model IDs                                                                                      |
| :------------ | :------------------------------------------------------------------------------------------------------- |
| Claude Sonnet | `claude-sonnet-4-6@default`                                                                              |
| Claude Opus   | `claude-opus-5@default`, `claude-opus-4-8@default`, `claude-opus-4-7@default`, `claude-opus-4-6@default` |
| Claude Haiku  | `claude-haiku-5-5@default`, `claude-haiku-4-5@20251001`, `claude-haiku-4-5`                              |

## Configuration options

`AnthropicLlmParams` (`new AnthropicLlm(params)`):

| Option      | Type     | Default               | Description                                                                                                 |
| :---------- | :------- | :-------------------- | :---------------------------------------------------------------------------------------------------------- |
| `model`     | `string` | `'claude-sonnet-5-5'` | The Anthropic API model identifier passed to `client.messages.create`.                                      |
| `maxTokens` | `number` | `8192`                | Default `max_tokens` passed to `client.messages.create` when `llmRequest.config?.maxOutputTokens` is unset. |

`ClaudeParams` (`new Claude(params)`):

| Option      | Type     | Default                       | Description                                                                                             |
| :---------- | :------- | :---------------------------- | :------------------------------------------------------------------------------------------------------ |
| `model`     | `string` | `'claude-sonnet-4-6@default'` | The Vertex AI Claude model identifier passed to `client.messages.create`.                               |
| `maxTokens` | `number` | `8192`                        | Default `max_tokens` passed to `client.messages.create` when `llmRequest.config?.maxOutputTokens` is unset. |

Each call requests `llmRequest.config?.maxOutputTokens ?? maxTokens` output tokens (`max_tokens`, defaulting to `8192`). When `generateContentAsync` receives an `AbortSignal`, it forwards `{signal: abortSignal}` to `client.messages.create`.

## Finish reason mapping

`AnthropicLlm` and `Claude` populate `LlmResponse.finishReason` from the Anthropic response's `message.stop_reason` via `toGoogleGenaiFinishReason`:

| Anthropic `stop_reason`                                       | `LlmResponse.finishReason`               |
| :------------------------------------------------------------ | :--------------------------------------- |
| `'end_turn'`, `'stop_sequence'`, `'tool_use'`, `'pause_turn'` | `FinishReason.STOP`                      |
| `'max_tokens'`, `'model_context_window_exceeded'`             | `FinishReason.MAX_TOKENS`                |
| `'refusal'`                                                   | `FinishReason.SAFETY`                    |
| `null`, `undefined`, or unrecognized values                   | `FinishReason.FINISH_REASON_UNSPECIFIED` |

## Function calling

When an `LlmAgent` is configured with tools, `AnthropicLlm` and `Claude` translate ADK tool declarations and tool execution turns as follows:

1. **Tool collection**: Collects `functionDeclarations` across every `Tool` entry in `llmRequest.config?.tools`.
2. **Schema conversion**: Converts `FunctionDeclaration.parameters` (`@google/genai` `Schema` with uppercase `Type` enums) into lowercase JSON Schema via `genaiSchemaToJsonSchema` with `input_schema.type` set to `'object'`, or passes `FunctionDeclaration.parametersJsonSchema` through directly.
3. **Sequential tool choice**: When `llmRequest.toolsDict` is non-empty, sets `tool_choice` to `{type: 'auto', disable_parallel_tool_use: true}` so the model invokes at most one tool per turn.
4. **Tool-use ID preservation and sanitization**: Client-generated `adk-*` function call and response IDs are preserved in `LlmRequest.contents` for Claude requests, and any missing or invalid `tool_use` / `tool_result` IDs (not matching `^[a-zA-Z0-9_-]+$`) are mapped consistently within each request to `toolu_fallback_<N>`.
5. **Tool result serialization**: Converts each `functionResponse` part into a `tool_result` block:
   - When `'result' in response`, string values of `response.result` are sent unchanged, non-null structured values (`object`, `array`, `number`, `boolean`) are serialized with `JSON.stringify(response.result)`, and `null` or `undefined` becomes `''`.
   - When `'result'` is not a key in `response`, a non-empty `response` object is serialized with `JSON.stringify(response)`.

## Limitations

- **Streaming**: `generateContentAsync` accepts the `_stream` parameter required by `BaseLlm`, but always calls `client.messages.create` without `stream: true` and yields a single non-partial `LlmResponse`.
- **Live connections**: `connect()` is not supported and rejects with an `Error`.
- **Extended thinking**: `ThinkingBlock` and `RedactedThinkingBlock` response blocks, `thinking` request configuration, and parts with `thought: true` are not supported. A `thoughtSignature` on a text, function call, or function response part (for example, from Gemini earlier in the session) is dropped.
- **Images, PDFs, and inline data**: Only `text`, `functionCall`, and `functionResponse` parts are converted. `inlineData` and `fileData` parts throw an unsupported part error.
- **Prompt caching**: `cache_control` markers and `cache_creation_input_tokens` / `cache_read_input_tokens` usage fields are not mapped.
- **Generation parameters**: `temperature`, `topP`, `topK`, and `stopSequences` from `llmRequest.config` are not forwarded to `client.messages.create` (`maxOutputTokens` is forwarded as `max_tokens`).
- **Tracking headers**: `BaseLlm.trackingHeaders` is not passed to `Anthropic` or `AnthropicVertex`.
- **Structured output without tools**: `LlmAgent.outputSchema` is not enforced unless combined with tool use.

## Related guides

- [Models](../../../models/index.md) - `BaseLlm`, `LlmRequest`, `LlmResponse`, `LLMRegistry`, and `Gemini`.

## Related samples

- [samples/integrations/anthropic/](../../../../../samples/integrations/anthropic/README.md) - An `LlmAgent` using `AnthropicLlm` with `ANTHROPIC_API_KEY` and a structured `FunctionTool`.
- [samples/integrations/claude/](../../../../../samples/integrations/claude/README.md) - An `LlmAgent` using `Claude` on Vertex AI with a structured `FunctionTool`.
