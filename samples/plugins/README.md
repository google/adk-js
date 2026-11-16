# Plugins Sample (`BasePlugin`)

This sample demonstrates how a plugin that extends `BasePlugin` observes every agent run, model request and tool call of a runner.

## Overview

`hello_world` is an `LlmAgent` with one tool, also named `hello_world`, that takes a `query` string. `CountInvocationPlugin` extends `BasePlugin` with the name `count_invocation`. It overrides `beforeAgentCallback`, `beforeModelCallback` and `beforeToolCallback`, counts each call, and prints the count. Each callback returns `undefined`, so the plugin does not stop the run.

The sample registers the plugin in two ways. `main()` passes it in the `plugins` option of `InMemoryRunner`. The exported `app` carries it in `App.plugins`, and the ADK CLI loads an exported `app` in preference to `rootAgent`, so the CLI applies the plugin too.

## Sample Inputs

- `hello world`

  _The model calls the `hello_world` tool and then answers. With `npx tsx samples/plugins/agent.ts`, expect one agent run, two model requests and one tool call, in output like this:_

  ```text
  [Plugin] Agent run count: 1
  [Plugin] LLM request count: 1
  ** Got event from hello_world
  [Plugin] Tool call count: 1
  ** Got event from hello_world
  [Plugin] LLM request count: 2
  ** Got event from hello_world
  ```

  _The counts depend on the model. A model that answers without the tool gives one model request and no tool call._

## Running the Sample

The sample calls a live model, so set `GEMINI_API_KEY` first.

Run the self-contained `InMemoryRunner` script directly to print the plugin counts and the author of each event:

```bash
npx tsx samples/plugins/agent.ts
```

Or run the exported `app` interactively through the ADK CLI after building the workspace:

```bash
npm run build
npm run sample -- samples/plugins/agent.ts
```

`samples/` is not an npm workspace, so it is type-checked separately:

```bash
npm run ts:check:samples
```

## Related Guides

- [Plugins](../../docs/guides/plugins/index.md) - `BasePlugin`, `PluginManager`, `PluginCallbackName`, and how a runner registers and calls plugins.
