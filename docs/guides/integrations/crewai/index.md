# CrewAI tool (`CrewaiTool`)

`CrewaiTool` is an ecosystem adapter in `@google/adk-integrations` that wraps a CrewAI tool for use in an ADK `LlmAgent`.

## Introduction

`CrewaiTool` adapts tools from the CrewAI framework into ADK `FunctionTool` instances. It supports custom name and description overrides. It translates parameter schemas defined with Zod or JSON Schema. The package exports `CrewaiTool`, its configuration types, and the `isCrewaiTool` type guard.

## Installation and environment setup

Install `@google/adk-integrations` along with `@google/adk`:

```bash
npm install @google/adk @google/adk-integrations
```

`CrewaiTool` accepts duck-typed `CrewaiToolLike` tool objects. Installing third-party CrewAI packages is optional.

## Get started

### Passing a `CrewaiTool` instance to an agent

Wrap a CrewAI tool instance in `CrewaiTool` and pass it to `LlmAgent`:

```ts
import {LlmAgent} from '@google/adk';
import {CrewaiTool} from '@google/adk-integrations';
import {z} from 'zod';

export const searchTool = new CrewaiTool({
  tool: {
    name: 'Search the internet with Serper',
    description: 'Searches the internet for relevant content.',
    argsSchema: z.object({
      query: z.string().describe('Search query string.'),
    }),
    run: async ({query}) => `Results for ${query}`,
  },
});

export const researcherAgent = new LlmAgent({
  name: 'researcher',
  model: 'gemini-flash-latest',
  instruction: 'Answer questions using available tools.',
  tools: [searchTool],
});
```

## Configuration options

The `CrewaiToolConfig` interface configures `new CrewaiTool(config)` or `new CrewaiTool(tool, options?)`.

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `tool` | `CrewaiToolLike` | Required | Wrapped CrewAI tool object exposing `run` and optional `name`, `description`, and `argsSchema`. |
| `name` | `string` | Normalized `tool.name` | Optional non-empty override for the wrapped tool name. Empty strings fall back to `tool.name`. |
| `description` | `string` | `tool.description` | Optional non-empty override for the wrapped tool description. |

## How it works

1. **Name normalization**: When `name` is omitted or empty, `CrewaiTool` normalizes `tool.name`. It replaces spaces with underscores and lowercases characters. When `tool.name` is missing, it falls back to `tool.run.name` or `'crewai_tool'`.
2. **Schema translation**: `CrewaiTool` translates `tool.argsSchema` into a `@google/genai` `FunctionDeclaration`. It accepts Zod schemas, JSON Schema objects, or objects with `modelJsonSchema()` or `jsonSchema()` methods.
3. **Tool execution**: When the model calls the tool, `runAsync` forwards arguments and the optional `toolContext` to `tool.run`.

## Related guides

- [Tools](../../tools/index.md) - `BaseTool`, `FunctionTool`, and tool lifecycle in ADK.
- [LangChain tool](../langchain/index.md) - Adapting LangChain tools in `@google/adk-integrations`.
