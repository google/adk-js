# Claude on Vertex AI (`Claude`)

`Claude` is a `BaseLlm` implementation in `@google/adk-integrations` that connects an `LlmAgent` to Anthropic Claude models served on Google Cloud Vertex AI.

## Introduction

`Claude` translates ADK `LlmRequest` payloads into Vertex AI Anthropic Messages API calls via `AnthropicVertex` and converts the returned `Anthropic.Message` into an `LlmResponse`. The package exports `Claude`, its `ClaudeParams` options type, and the `isClaude` type guard.

## Installation and environment setup

Install `@google/adk-integrations` along with its optional Anthropic peer dependencies:

```bash
npm install @google/adk @google/adk-integrations @anthropic-ai/sdk @anthropic-ai/vertex-sdk
```

`@anthropic-ai/sdk` and `@anthropic-ai/vertex-sdk` are declared as optional peer dependencies of `@google/adk-integrations`. `@anthropic-ai/vertex-sdk` is loaded lazily via dynamic `import()` on the first model call so that applications using other integrations do not need to install it.

Authenticate with Google Cloud Application Default Credentials (`gcloud auth application-default login`) and set the Vertex AI project and location environment variables:

```bash
export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
export GOOGLE_CLOUD_LOCATION="global"
```

`GOOGLE_CLOUD_LOCATION` accepts `global` as well as regional Vertex AI endpoints where Claude models are served (such as `us-east5` or `europe-west1`). If either variable is unset or empty, `Claude` throws an error when creating the client.

## Get started

### Passing a `Claude` instance directly

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

When `model` is omitted (`new Claude()`), it defaults to `'claude-sonnet-4-6@default'`.

### Registering `Claude` with `LLMRegistry`

Register `Claude` once at startup so any `LlmAgent` can reference a `claude-*` model identifier by name:

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

`Claude.supportedModels` registers the pattern `/claude-.*/`, which matches any model identifier starting with `claude-`. Current Claude model identifiers on Vertex AI include:

| Family        | Vertex AI model IDs                                                                                      |
| :------------ | :------------------------------------------------------------------------------------------------------- |
| Claude Sonnet | `claude-sonnet-4-6@default`                                                                              |
| Claude Opus   | `claude-opus-5@default`, `claude-opus-4-8@default`, `claude-opus-4-7@default`, `claude-opus-4-6@default` |
| Claude Haiku  | `claude-haiku-5-5@default`, `claude-haiku-4-5@20251001`, `claude-haiku-4-5`                              |

## Configuration options

| Option  | Type     | Default                       | Description                                                               |
| :------ | :------- | :---------------------------- | :------------------------------------------------------------------------ |
| `model` | `string` | `'claude-sonnet-4-6@default'` | The Vertex AI Claude model identifier passed to `client.messages.create`. |

Each call requests up to `1024` output tokens (`max_tokens`). Claude stops a longer answer at that limit, so ask for concise answers or split long tasks into steps. When `generateContentAsync` receives an `AbortSignal`, it forwards `{signal: abortSignal}` to `client.messages.create`.

## Function calling

When an `LlmAgent` is configured with tools, `Claude` translates ADK tool declarations and tool execution turns as follows:

1. **Tool collection**: `Claude` collects `functionDeclarations` across every `Tool` entry in `llmRequest.config?.tools`.
2. **Schema conversion**: `Claude` converts `FunctionDeclaration.parameters` (`@google/genai` `Schema` with uppercase `Type` enums) into lowercase JSON Schema via `genaiSchemaToJsonSchema` with `input_schema.type` set to `'object'`, or passes `FunctionDeclaration.parametersJsonSchema` through directly.
3. **Sequential tool choice**: When `llmRequest.toolsDict` is non-empty, `Claude` sets `tool_choice` to `{type: 'auto', disable_parallel_tool_use: true}` so the model invokes at most one tool per turn.
4. **Tool result serialization**: `Claude` converts each `functionResponse` part into a `tool_result` block:
   - When `'result' in response`, string values of `response.result` are sent unchanged, non-null structured values (`object`, `array`, `number`, `boolean`) are serialized with `JSON.stringify(response.result)`, and `null` or `undefined` becomes `''`.
   - When `'result'` is not a key in `response`, a non-empty `response` object is serialized with `JSON.stringify(response)`.

## Limitations

- **Streaming**: `generateContentAsync` accepts the `_stream` parameter required by `BaseLlm`, but always calls `client.messages.create` without `stream: true` and yields a single non-partial `LlmResponse`.
- **Live connections**: `connect()` is not supported and rejects with an `Error`.
- **Extended thinking**: `ThinkingBlock` and `RedactedThinkingBlock` response blocks, `thinking` request configuration, and parts with `thought: true` are not supported. A `thoughtSignature` on a text, function call, or function response part (for example, from Gemini earlier in the session) is dropped.
- **Images, PDFs, and inline data**: `Claude` only converts `text`, `functionCall`, and `functionResponse` parts. `inlineData` and `fileData` parts throw an unsupported part error.
- **Prompt caching**: `cache_control` markers and `cache_creation_input_tokens` / `cache_read_input_tokens` usage fields are not mapped.
- **Finish reason on responses**: `Claude` does not populate `finishReason` on the returned `LlmResponse`.
- **Generation parameters**: `maxOutputTokens`, `temperature`, `topP`, `topK`, and `stopSequences` from `llmRequest.config` are not forwarded to `client.messages.create`; `max_tokens` is fixed at `1024`.
- **Direct Anthropic API client**: `Claude` only instantiates `AnthropicVertex` for Vertex AI and does not connect directly to `api.anthropic.com`.
- **Tracking headers**: `BaseLlm.trackingHeaders` is not passed to `AnthropicVertex`.
- **Structured output without tools**: `LlmAgent.outputSchema` is not enforced unless combined with tool use.

## Related guides

- [Models](../../../models/index.md) - `BaseLlm`, `LlmRequest`, `LlmResponse`, `LLMRegistry`, and `Gemini`.

## Related samples

- [samples/integrations/claude/](../../../../../samples/integrations/claude/README.md) - An `LlmAgent` using `Claude` on Vertex AI with a structured `FunctionTool`.
