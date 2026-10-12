# Models (`BaseLlm`, `LlmRequest`, `LlmResponse`, and `LLMRegistry`)

A model in the Agent Development Kit (ADK) is a `BaseLlm` subclass that turns an `LlmRequest` into a stream of `LlmResponse` objects. An `LlmAgent` gets its model from the `model` option, as an instance or as a name that `LLMRegistry` resolves.

All models extend `BaseLlm`. The package exports these implementations:

- `Gemini` - Calls Gemini through the Gemini API or Vertex AI. It is registered by default, so a `gemini-…` name resolves to it.
- `ApigeeLlm` - A `Gemini` subclass that reaches the provider through an Apigee proxy. It is registered by default, so an `apigee/…` name resolves to it.
- `ChromeBuiltInLlm` - Calls Chrome's built-in on-device model through the Prompt API. It is registered by default, so a `chrome-on-device` or `chrome/…` name resolves to it.
- `RoutedLlm` - Delegates each request to one of several models that a router function selects. You create it directly; it has no name pattern.
- `Claude` - Calls Anthropic Claude models on Vertex AI through the optional `@anthropic-ai/vertex-sdk` package. Register it with `LLMRegistry.register(Claude)` so that a `claude-3-…` name resolves to it.

## Introduction

An `LlmAgent` builds one `LlmRequest` for each model call. The request holds the conversation `contents`, a `config` with the system instruction, the tool declarations and the generation settings, and a `toolsDict` that maps tool names to tools. The agent gives the request to `generateContentAsync` on its model and turns each `LlmResponse` into an `Event`.

You work with models directly when you:

- **Choose a provider.** Give the agent a `Gemini` instance, or a name that the registry resolves.
- **Write your own model.** Extend `BaseLlm`, implement `generateContentAsync` and `connect`, and register the class so that agents can use it by name.
- **Build requests yourself.** Use `appendInstructions` to add a system instruction to an `LlmRequest`, the same way that `LlmAgent` does.

## Get started

Extend `BaseLlm`, register the class with `LLMRegistry`, and give the model name to an `LlmAgent`:

```ts
import {
  BaseLlm,
  BaseLlmConnection,
  LLMRegistry,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';

class EchoLlm extends BaseLlm {
  static override readonly supportedModels = [/echo-v1|echo-v2/];

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const last = llmRequest.contents[llmRequest.contents.length - 1];
    yield {
      content: {role: 'model', parts: last?.parts ?? []},
      turnComplete: true,
    };
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(`Live connection is not supported for ${this.model}.`);
  }
}

LLMRegistry.register(EchoLlm);

export const rootAgent = new LlmAgent({
  name: 'echo_agent',
  model: 'echo-v1',
  instruction: 'Repeat what the user says.',
});
```

## How it works

### Requests and responses

`LlmRequest` is a plain object. `appendInstructions(llmRequest, instructions)` joins the instructions with a blank line and adds them to `config.systemInstruction`. You set the other request fields, such as `config.tools` and `config.responseSchema`, directly on the object.

`LlmResponse` is a plain object too. A model sets `partial: true` on a streamed chunk, `turnComplete: true` at the end of a turn, and `errorCode` and `errorMessage` when the model returns no content. `createLlmResponse(response)` makes an `LlmResponse` from a `GenerateContentResponse` of the `@google/genai` SDK. It copies the first candidate, or it sets the error fields when there is no candidate content.

### Model resolution

`LLMRegistry.register(ModelClass)` records each pattern in the static `supportedModels` of the class. `LLMRegistry.resolve(name)` returns the class whose pattern matches the **whole** name, and `LLMRegistry.newLlm(name)` creates an instance of it. A pattern such as `echo-v1|echo-v2` matches `echo-v1` and `echo-v2`, but not `echo-v10` or `my-echo-v1`. When no pattern matches, `resolve` throws an error. The registry keeps the 32 most recent results in a cache.

An `LlmAgent` with a string `model` calls `LLMRegistry.newLlm`. An agent without a `model` uses the model of its nearest ancestor `LlmAgent`.

### Streaming with Gemini

With streaming on, `Gemini` yields each text chunk as a partial response, and then yields one merged response that holds all of the text of the turn. When a chunk starts with inline data, such as audio, `Gemini` yields it as it arrives and keeps the text before it buffered, instead of yielding that text as a separate merged response first. Text that comes before and after the audio is still in the merged response at the end of the turn. A chunk that starts with text and also carries inline data still flushes the buffered text first.

### Live connections

`connect` returns a `BaseLlmConnection` for bidirectional streaming. `receive()` on a `Gemini` connection yields the messages of one turn and ends after the message that completes the turn. Call `receive()` again for the next turn. `LlmAgent` does this for you in `runLive`: it calls `receive()` again until a call yields nothing.

When the model is interrupted, the connection yields the text it has so far, and then always yields a response with `interrupted: true`.

### Anthropic Claude on Vertex AI

`Claude` adapts Anthropic Claude models hosted on Vertex AI to the `BaseLlm` interface. Its `supportedModels` list matches `/claude-3-.*/`, and its default `model` is `'claude-3-5-sonnet-v2@20241022'`. Register `Claude` with `LLMRegistry.register(Claude)` before resolving `claude-3-…` model names through `LLMRegistry` or `LlmAgent`, or pass a `Claude` instance directly to `LlmAgent`:

```ts
import {Claude, LLMRegistry, LlmAgent} from '@google/adk';

LLMRegistry.register(Claude);

export const claudeAgent = new LlmAgent({
  name: 'claude_assistant',
  model: 'claude-3-5-sonnet-v2@20241022',
  instruction: 'Answer in one sentence.',
});
```

`Claude` loads the optional `@anthropic-ai/vertex-sdk` peer package on first use when `generateContentAsync` runs. When no `client` is passed in `ClaudeParams`, `Claude` reads `project` and `location` from `ClaudeParams` or from the `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` environment variables, and throws an error when either value is missing. Live connections through `connect` are not supported for `Claude` and reject with an error.

| Symbol                                                                    | Purpose                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Claude`                                                                  | `BaseLlm` implementation for Anthropic Claude models on Vertex AI, using `MAX_TOKEN`, which is `1024`, as `max_tokens`.                                                                   |
| `ClaudeParams`                                                            | Constructor options: optional `model`, `project`, `location`, and pre-configured `client` of type `AnthropicVertexClient`.                                                                |
| `ClaudeRequest`                                                           | Request shape holding `systemInstruction`, `messages`, and `tools`.                                                                                                                       |
| `isClaude(obj)`                                                           | Type guard that returns `true` when `obj` is a `Claude` instance across package copies.                                                                                                   |
| `toClaudeRole(role)`                                                      | Maps `'model'` and `'assistant'` to `'assistant'`, and any other role to `'user'`.                                                                                                        |
| `toGoogleGenaiFinishReason(stopReason)`                                   | Maps `'end_turn'`, `'stop_sequence'`, and `'tool_use'` to `FinishReason.STOP`, `'max_tokens'` to `FinishReason.MAX_TOKENS`, and other values to `FinishReason.FINISH_REASON_UNSPECIFIED`. |
| `partToMessageBlock(part)` / `contentToMessageParam(content)`             | Convert `@google/genai` `Part` and `Content` turns into Anthropic message parameters.                                                                                                     |
| `contentBlockToPart(block)` / `messageToGenerateContentResponse(message)` | Convert Anthropic `text` and `tool_use` content blocks and messages into `@google/genai` `Part` objects and an `LlmResponse`.                                                             |
| `functionDeclarationToToolParam(declaration)`                             | Converts a `FunctionDeclaration` into an Anthropic `AnthropicToolParam` with lowercased property schema types.                                                                            |

## Related samples

- [samples/models/](../../../samples/models/README.md) - A `BaseAgent` that builds an `LlmRequest`, calls `appendInstructions`, creates a custom `BaseLlm` with `LLMRegistry.newLlm`, and converts its response with `createLlmResponse`, with no API key.

## Related guides

- [Planners](../planners/index.md) - How a planner changes the `LlmRequest` before the model call and the response after it.
