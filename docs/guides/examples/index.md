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

## Related Samples

- [`samples/examples/`](../../../samples/examples/README.md)
