# LangChain tool (`LangchainTool`)

`LangchainTool` is an ecosystem adapter in `@google/adk-integrations` that wraps a LangChain tool for use in an ADK `LlmAgent`.

## Introduction

`LangchainTool` adapts tools from the LangChain framework into ADK `FunctionTool` instances. It supports structured tools and simple convention-based tools. It resolves runner methods dynamically. The package exports `LangchainTool`, its configuration types, and the `isLangchainTool` type guard.

## Installation and environment setup

Install `@google/adk-integrations` along with `@google/adk`:

```bash
npm install @google/adk @google/adk-integrations
```

`LangchainTool` accepts duck-typed `LangchainToolLike` tool objects. Installing third-party LangChain packages is optional.

## Get started

### Passing a `LangchainTool` instance to an agent

Wrap a LangChain tool instance in `LangchainTool` and pass it to `LlmAgent`:

```ts
import {LlmAgent} from '@google/adk';
import {LangchainTool} from '@google/adk-integrations';
import {z} from 'zod';

export const calculatorTool = new LangchainTool({
  tool: {
    name: 'calculator',
    description: 'Evaluates basic math expressions.',
    schema: z.object({
      expression: z.string().describe('The expression to evaluate.'),
    }),
    invoke: async ({expression}) => `Computed: ${expression}`,
  },
});

export const mathAgent = new LlmAgent({
  name: 'math_assistant',
  model: 'gemini-flash-latest',
  instruction: 'Answer questions using available tools.',
  tools: [calculatorTool],
});
```

## Configuration options

The `LangchainToolConfig` interface configures `new LangchainTool(config)` or `new LangchainTool(tool, options?)`.

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `tool` | `LangchainToolLike` | Required | Wrapped LangChain tool object exposing `_run`, `_call`, `invoke`, or `run`. |
| `name` | `string` | `tool.name` | Optional custom name override. |
| `description` | `string` | `tool.description` | Optional custom description override. |

## How it works

1. **Runner method resolution**: `LangchainTool` binds the first available method from `_run`, `_call`, `invoke`, or `run`. If none is found, construction throws a `TypeError`.
2. **Structured and simple tools**: When the tool exposes `_run`, `_call`, `invoke`, `argsSchema`, `schema`, or `args`, `LangchainTool` treats it as a structured tool. It delegates declaration generation to `buildFunctionDeclarationForLangchain`. Otherwise, it treats it as a simple convention-based tool and delegates to `buildFunctionDeclarationUtil`.
3. **Schema extraction**: Parameter schemas can be defined with Zod, raw property maps (`args`), JSON Schema objects, or `modelJsonSchema()` / `jsonSchema()` methods.
4. **Tool execution**: When the model calls the tool, `runAsync` forwards arguments and the optional `toolContext` to the resolved runner function.

## Related guides

- [Tools](../../tools/index.md) - `BaseTool`, `FunctionTool`, and tool lifecycle in ADK.
- [CrewAI tool](../crewai/index.md) - Adapting CrewAI tools in `@google/adk-integrations`.
