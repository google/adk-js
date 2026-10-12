# Examples Guide (`examples`)

The `examples` subsystem in `@google/adk` provides few-shot example structures, dynamic example providers (`BaseExampleProvider`), prompt formatting utilities (`example_util`), and managed Vertex AI example retrieval (`VertexAiExampleStore`). It integrates seamlessly with ADK agents and code executors (`BaseCodeExecutor`, `BuiltInCodeExecutor`, `CodeExecutorContext`, `ContainerCodeExecutor`, `UnsafeLocalCodeExecutor`, `VertexAiCodeExecutor`, and `code_execution_utils`).

## Overview

Few-shot examples help steer LLM behavior by demonstrating expected input/output pairs (`Example`) before the current user query. In ADK TypeScript, you can supply:

- **Static examples**: An array of `Example` objects containing `input` and `output` `Content` items.
- **Dynamic example providers**: A class extending `BaseExampleProvider` (such as `VertexAiExampleStore` or a custom provider) that selects relevant examples at runtime based on the user's latest query.

## Minimal Runnable Example

```typescript
import {
  BaseExampleProvider,
  Example,
  LlmAgent,
  InMemoryRunner,
  convertExamplesToText,
} from '@google/adk';

class CustomExampleProvider extends BaseExampleProvider {
  async getExamples(query: string): Promise<Example[]> {
    return [
      {
        input: {role: 'user', parts: [{text: `Sample question for: ${query}`}]},
        output: [{role: 'model', parts: [{text: 'Sample structured answer.'}]}],
      },
    ];
  }
}

const provider = new CustomExampleProvider();
console.log(
  convertExamplesToText(
    await provider.getExamples('status check'),
    'gemini-2.5-flash',
  ),
);
```

## Configuration Options

| Symbol                                                     | Description                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Example`                                                  | Data structure holding an `input` (`Content`) and `output` (`Content[]`) pair for few-shot prompting. |
| `BaseExampleProvider`                                      | Abstract base class defining `getExamples(query: string): Promise<Example[]>`.                        |
| `VertexAiExampleStore`                                     | Retrieves dynamic few-shot examples from a Vertex AI Example Store instance.                          |
| `example_util` (`convertExamplesToText`, `buildExampleSi`) | Formats `Example[]` arrays or `BaseExampleProvider` outputs into system instruction blocks.           |
| `VertexAiExampleStoreApiClient`                            | Default `ExampleStoreApiClient` that calls the Vertex AI `v1beta1` `:searchExamples` REST endpoint.   |
| `VertexAiExampleStoreApiClientOptions`                     | Configuration options (`auth`, `apiEndpoint`) for `VertexAiExampleStoreApiClient`.                    |
| `ExampleTool`                                              | Request-processing tool (`BaseTool`) that appends rendered few-shot examples to `LlmRequest`.         |
| `validateExamples`                                         | Runtime validator that throws `InputValidationError` when an array is not a well-formed `Example[]`.  |
| `getLatestMessageFromUser`                                 | Extracts the latest user text message from a `Session` when the last event has no function responses. |
| `isBaseExampleProvider`                                    | Cross-bundle type guard using `Symbol.for('google.adk.baseExampleProvider')`.                         |

### `VertexAiExampleStore` and `VertexAiExampleStoreApiClient` Parameters

| Parameter / Option    | Type                                 | Default                                        | Description                                                                                                                                                    |
| --------------------- | ------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `examplesStoreName`   | `string`                             | Required                                       | Resource name (`projects/{project}/locations/{location}/exampleStores/{id}`) or bare store ID when `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` are set. |
| `apiClient`           | `ExampleStoreApiClient`              | `new VertexAiExampleStoreApiClient()`          | Client used by `VertexAiExampleStore.getExamples` to call `searchExamples`.                                                                                    |
| `options.auth`        | `Pick<GoogleAuth, 'getAccessToken'>` | Lazy `GoogleAuth` with cloud scope             | Supplies the OAuth2 Bearer token for `https://www.googleapis.com/auth/cloud-platform`.                                                                         |
| `options.apiEndpoint` | `string`                             | `https://{location}-aiplatform.googleapis.com` | Overrides the regional Vertex AI endpoint host or base URL.                                                                                                    |

### `ExampleTool` and Utility Functions

| Symbol                                    | Signature                                                                                        | Description                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `new ExampleTool(examples)`               | `(examples: Example[] \| BaseExampleProvider) => ExampleTool`                                    | Validates static arrays with `validateExamples` at construction time and appends `buildExampleSi` output to `llmRequest` during `processLlmRequest`.                                       |
| `convertExamplesToText(examples, model?)` | `(examples: Example[], model?: string) => string`                                                | Renders examples inside `<EXAMPLES>...</EXAMPLES>`. Uses plain triple-backtick fences when `model` is omitted or includes `'gemini-2'`, and `tool_code` / `tool_outputs` fences otherwise. |
| `buildExampleSi(examples, query, model?)` | `(examples: Example[] \| BaseExampleProvider, query: string, model?: string) => Promise<string>` | Resolves an `Example[]` array or awaits `examples.getExamples(query)` on a `BaseExampleProvider`, then delegates to `convertExamplesToText`.                                               |
| `getLatestMessageFromUser(session)`       | `(session: Session) => string`                                                                   | Returns `event.content.parts[0].text` when the final event in `session.events` has `author === 'user'` and no function responses, or `''` otherwise.                                       |
| `validateExamples(examples)`              | `(examples: unknown) => asserts examples is Example[]`                                           | Checks that `examples` is an array of objects with `input` (`Content`) and `output` (`Content[]`), throwing `InputValidationError` on failure.                                             |

## How It Works

1. **Attaching examples to an agent**: Pass an `ExampleTool` instance in the `tools` array of an `LlmAgent`. `ExampleTool` is a request-mutating tool rather than a model-callable function: it leaves `_getDeclaration()` undefined so the model never sees it in the tool declarations, and throwing from `runAsync` guards against direct invocation.
2. **Extracting the query and rendering**: On each model turn, `ExampleTool.processLlmRequest` reads the first text part of `toolContext.userContent` (`parts[0]?.text`). If present, it awaits `buildExampleSi(this.examples, text, llmRequest.model)` and appends the resulting `<EXAMPLES>` block to the outgoing `LlmRequest` system instructions via `appendInstructions`.
3. **Model-specific fence formatting**: `convertExamplesToText` numbers each example (`EXAMPLE 1:`, `EXAMPLE 2:`) and labels turns with `[user]` and `[model]`. When `model` is undefined or contains `'gemini-2'`, function calls and responses use plain ` ``` ` code fences; for other model strings, function calls use ` ```tool_code ` and function responses use ` ```tool_outputs `. Function-call arguments format strings as `key='value'` and non-strings as `key=value`, while function responses serialize with `JSON.stringify(part.functionResponse)`.
4. **Vertex AI Example Store retrieval**: `VertexAiExampleStore.getExamples(query)` builds a `SearchExamplesRequest` with `topK: 10` and `searchKeyGenerationMethod: {lastEntry: {}}`, calls `this.apiClient.searchExamples(request)`, filters out any result whose `similarityScore` is below `0.5`, and converts stored `text`, `functionCall`, and `functionResponse` parts into `Example` objects.
5. **Default REST client and browser safety**: When `apiClient` is omitted, `VertexAiExampleStore` defaults to `new VertexAiExampleStoreApiClient()`. The client does not perform network I/O or import `google-auth-library` in its constructor; instead, it dynamically imports `google-auth-library` on the first `searchExamples` call when no custom `auth` option was supplied. This keeps the browser bundle (`@google/adk` web entry point) free of Node.js built-ins.

## Advanced Applications

### Querying Vertex AI Example Store with Default Credentials

Pass only the resource name to `VertexAiExampleStore` when running in Node.js with Application Default Credentials:

```typescript
import {ExampleTool, LlmAgent, VertexAiExampleStore} from '@google/adk';

const store = new VertexAiExampleStore(
  'projects/my-project/locations/us-central1/exampleStores/my-store',
);

const agent = new LlmAgent({
  name: 'support_agent',
  model: 'gemini-flash-latest',
  instruction: 'Answer user questions following the provided examples.',
  tools: [new ExampleTool(store)],
});
```

### Supplying a Custom `ExampleStoreApiClient` or Custom Auth Options

For unit tests, browser environments, or custom endpoints, pass either a `VertexAiExampleStoreApiClient` configured with `VertexAiExampleStoreApiClientOptions` or a custom `ExampleStoreApiClient`:

```typescript
import {
  ExampleStoreApiClient,
  SearchExamplesRequest,
  SearchExamplesResponse,
  VertexAiExampleStore,
} from '@google/adk';

const customClient: ExampleStoreApiClient = {
  async searchExamples(
    request: SearchExamplesRequest,
  ): Promise<SearchExamplesResponse> {
    return {
      results: [
        {
          similarityScore: 0.9,
          example: {
            storedContentsExample: {
              searchKey:
                request.storedContentsExampleParameters.contentSearchKey
                  .contents[0]?.parts?.[0]?.text ?? '',
              contentsExample: {
                expectedContents: [
                  {
                    content: {
                      role: 'model',
                      parts: [{text: 'Matched example output.'}],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    };
  },
};

const store = new VertexAiExampleStore(
  'projects/my-project/locations/us-central1/exampleStores/my-store',
  customClient,
);
```

## Limitations

- **Fixed retrieval threshold and `topK`**: `VertexAiExampleStore` always requests `topK: 10` and discards results with `similarityScore < 0.5`. To use different thresholds or parameters, implement a custom `BaseExampleProvider`.
- **Leading text part required in `ExampleTool`**: `ExampleTool.processLlmRequest` reads `toolContext.userContent?.parts?.[0]?.text`. If the first part of the user message has no `text` (for example, an image-only first part), `ExampleTool` returns without appending examples.
- **Node.js default authentication**: `VertexAiExampleStoreApiClient` uses `google-auth-library` when `options.auth` is omitted, which requires a Node.js runtime. In browser environments, pass an `auth` object (`{getAccessToken}`) or a custom `ExampleStoreApiClient`.

## Related Samples

- [`samples/examples/`](../../../samples/examples/README.md)
