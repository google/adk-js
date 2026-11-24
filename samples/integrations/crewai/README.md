# CrewAI Tool Sample (`CrewaiTool`)

This sample demonstrates how to wrap CrewAI-compatible tools with `CrewaiTool` from `@google/adk-integrations` and attach them to an ADK `LlmAgent`.

## Overview

`crewaiToolsAssistant` is an `LlmAgent` using `model: 'gemini-flash-latest'` equipped with two `CrewaiTool` wrappers:

1. `searchCatalogTool`: wraps a `CrewaiToolLike` object with a space-separated `tool.name` (normalized by `CrewaiTool`), a Zod `argsSchema` (`z.object`), and an async `run` method via `new CrewaiTool({tool: ...})`.
2. `lookupGlossaryTool`: wraps a `CrewaiToolLike` object exposing an `argsSchema` with `toJsonSchema()`, overriding its `name` and `description` via `new CrewaiTool(tool, options)`.

## Prerequisites

`CrewaiTool` accepts duck-typed `CrewaiToolLike` objects, so no extra CrewAI packages are required for this sample. Set your Gemini API key in the environment:

```bash
export GEMINI_API_KEY="your-gemini-api-key"
```

## Sample Inputs

- `Search the catalog for streaming guides.`
- `Look up the runner and toolset glossary entries.`

## Running the Sample

Build the workspace, then run the exported `rootAgent` through the ADK CLI:

```bash
npm run build
npm run sample -- samples/integrations/crewai/agent.ts
```

To open the agent in the ADK web UI, start the web server on the `samples/integrations` directory and select `crewai`:

```bash
adk web samples/integrations
```

Inside this repository, without the global `adk` command installed, run the CLI from the build output:

```bash
node dev/dist/esm/cli_entrypoint.js web samples/integrations
```

`samples/` is type-checked against the built package types:

```bash
npm run build
npm run ts:check:samples
```

## Related Guides

- [CrewAI tool](../../../docs/guides/integrations/crewai/index.md) - `CrewaiTool`, `isCrewaiTool`, configuration options, and schema translation.
- [Tools](../../../docs/guides/tools/index.md) - `BaseTool`, `FunctionTool`, and tool lifecycle in ADK.
