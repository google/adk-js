# Plugins (`BasePlugin`, `PluginManager`, and `PluginCallbackName`)

A plugin in the Agent Development Kit (ADK) is a class that observes or changes a run at fixed points: the user message, the run, each agent, each model request, each tool call, and each event. You register a plugin on the runner, and the runner applies it to every agent, model request and tool call of that runner.

The package exports these parts:

- `BasePlugin` - The abstract base class. Each callback has a default implementation that does nothing, so a plugin overrides only the callbacks it needs.
- `PluginManager` - Holds the registered plugins of a runner and calls each callback on them in registration order.
- `PluginCallbackName` - A string-literal union of the `BasePlugin` callback method names that `PluginManager` calls.

## Introduction

An agent callback, such as the `beforeToolCallback` option of `LlmAgent`, applies to one agent. A plugin applies to the whole runner. Use a plugin for behavior that must not depend on which agent runs: logging, metrics, policy checks, caching, or an instruction that every agent gets.

A plugin callback and the agent callback of the same kind receive the same data. The plugin callback runs first. If a plugin returns a value, the remaining plugins and the agent callbacks of that kind do not run.

## Get started

Extend `BasePlugin`, give the plugin a name, override a callback, and pass an instance in the `plugins` option of a runner:

```ts
import type {BaseTool, Context} from '@google/adk';
import {BasePlugin, FunctionTool, InMemoryRunner, LlmAgent} from '@google/adk';
import {z} from 'zod';

class ToolCounterPlugin extends BasePlugin {
  private toolCount = 0;

  constructor() {
    super('tool_counter');
  }

  override async beforeToolCallback({
    tool,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    this.toolCount += 1;
    console.log(`Tool call ${this.toolCount}: ${tool.name}`);
    return undefined;
  }
}

const helloWorld = new FunctionTool({
  name: 'hello_world',
  description: 'Prints hello world with the user query.',
  parameters: z.object({query: z.string().describe('The query of the user.')}),
  execute: ({query}) => `Hello world: query is [${query}]`,
});

const agent = new LlmAgent({
  name: 'hello_world',
  model: 'gemini-flash-latest',
  instruction: 'Use the hello_world tool to print hello world and the query.',
  tools: [helloWorld],
});

const runner = new InMemoryRunner({
  agent,
  appName: 'plugin_app',
  plugins: [new ToolCounterPlugin()],
});
const session = await runner.sessionService.createSession({
  appName: 'plugin_app',
  userId: 'user-1',
});

for await (const event of runner.runAsync({
  userId: 'user-1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'hello world'}]},
})) {
  console.log(`Event from ${event.author}`);
}
```

The callback returns `undefined`, so the tool runs as usual. If the callback returns an object, ADK uses that object as the tool result and does not call the tool.

## How it works

1. **Registration**: The `Runner` constructor builds one `PluginManager` from the plugins of the `app` option (`App.plugins`) followed by the plugins of the `plugins` option. The manager is available as `runner.pluginManager`, and the runner gives it to each invocation context.
2. **Unique names**: `registerPlugin` throws an `Error` if the same plugin instance is already registered, or if a registered plugin has the same `name`. `getPlugin(name)` returns the plugin with that name, or `undefined`.
3. **Order**: For each callback, `PluginManager` calls the plugins one at a time in registration order, and awaits each call.
4. **Early exit**: The first plugin that returns a value other than `undefined` stops the callback. The remaining plugins are not called for that callback, and the manager returns the value to the caller.
5. **Plugins before agent callbacks**: For the agent, model and tool callbacks, the plugins run first. The agent's own callbacks of that kind run only if no plugin returned a value.
6. **Errors**: If a plugin callback throws, the manager logs the error and throws a new `Error`. Its message is `Error in plugin '<name>' during '<callback>' callback: <error>`, and its `cause` is the original error. The run fails with that error.
7. **Notification callbacks**: `onAgentErrorCallback` and `onRunErrorCallback` are different. The manager calls every plugin, ignores the returned values, and only logs a callback that throws. The error that caused the notification continues to the caller.

### Callbacks

Each callback takes one object parameter and returns a promise. The table shows when each callback runs and what a returned value does. "Stops" means that the remaining plugins and the agent callbacks of that kind do not run.

| Callback                  | When it runs                                                           | A returned value                                                                          |
| :------------------------ | :--------------------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| `onUserMessageCallback`   | After the runner receives the user message, before the session has it. | A `Content` replaces the user message.                                                    |
| `beforeRunCallback`       | Before the runner runs the root agent.                                 | A `Content` ends the run with one event that has this content. The agent does not run.    |
| `onEventCallback`         | For each event of the run, before the runner stores and yields it.     | An `Event` replaces the event. The original id, invocation id and timestamp are kept.     |
| `afterRunCallback`        | After the run completes, is aborted, or the caller stops reading it.   | Nothing is returned. It does not run after a failed run.                                  |
| `onRunErrorCallback`      | When the run fails with an error.                                      | Ignored. Notification only.                                                               |
| `beforeAgentCallback`     | Before an agent runs.                                                  | A `Content` stops, and replaces the agent's run with this content.                        |
| `afterAgentCallback`      | After an agent has run.                                                | A `Content` stops, and is emitted as one more event.                                      |
| `onAgentErrorCallback`    | When an error leaves an agent's run or its callbacks.                  | Ignored. Notification only.                                                               |
| `beforeModelCallback`     | Before a request goes to the model.                                    | An `LlmResponse` stops, and is used as the response. The model is not called.             |
| `afterModelCallback`      | After a response comes back from the model.                            | An `LlmResponse` stops, and replaces the response.                                        |
| `onModelErrorCallback`    | When the model call throws an `Error`.                                 | An `LlmResponse` is used in place of the error response.                                  |
| `beforeToolCallback`      | Before a tool is called.                                               | An object stops, and is used as the tool result. The tool is not called.                  |
| `afterToolCallback`       | After a tool has returned.                                             | An object stops, and replaces the tool result.                                            |
| `onToolErrorCallback`     | When a tool call throws an `Error` or the tool cannot be found.        | An object is used as the tool result. Without it, the result is `{error: error.message}`. |
| `beforeNodeCallback`      | Before a workflow node runs.                                           | Any value other than `undefined` becomes the output of the node. The node does not run.   |
| `afterNodeCallback`       | After a workflow node has run.                                         | Any value other than `undefined` replaces the output of the node.                         |
| `beforeToolSelection`     | Before the tools of a model request are selected. Experimental.        | A record of tools: only the tools with these names stay available to the model.           |
| `beforeContextCompaction` | Before a context compactor compacts the session. Experimental.         | Nothing is returned.                                                                      |
| `afterContextCompaction`  | After a context compactor has compacted the session. Experimental.     | Nothing is returned.                                                                      |

A callback can also change its input in place, for example add text to `llmRequest` in `beforeModelCallback`. The next plugin and the agent callbacks then receive the changed object.

## Configuration options

### Where to register plugins

| Option                     | Type           | Default | Description                                                                            |
| :------------------------- | :------------- | :------ | :------------------------------------------------------------------------------------- |
| `App.plugins`              | `BasePlugin[]` | `[]`    | Plugins of the application. A runner built with the `app` option registers them first. |
| `Runner` `plugins`         | `BasePlugin[]` | `[]`    | Plugins of this runner. The runner registers them after the plugins of `app`.          |
| `InMemoryRunner` `plugins` | `BasePlugin[]` | `[]`    | The same option, passed to `Runner`.                                                   |

### `BasePlugin` constructor

| Parameter | Type     | Default  | Description                                                       |
| :-------- | :------- | :------- | :---------------------------------------------------------------- |
| `name`    | `string` | Required | The name of the plugin. It must be unique in one `PluginManager`. |

### `PluginManager` members

| Member                        | Description                                                                                            |
| :---------------------------- | :----------------------------------------------------------------------------------------------------- |
| `new PluginManager(plugins?)` | Registers each plugin of the optional array, in order.                                                 |
| `registerPlugin(plugin)`      | Adds a plugin after the registered plugins. Throws for a duplicate instance or a duplicate name.       |
| `getPlugin(pluginName)`       | Returns the plugin with that name, or `undefined`.                                                     |
| `hasPlugins`                  | `true` when one plugin or more is registered.                                                          |
| `run...` methods              | One method for each callback, for example `runBeforeToolCallback`. ADK calls them; you usually do not. |

## Advanced applications

### Registering plugins on an `App`

Put a plugin in `App.plugins` when it belongs to the application and not to one runner. The ADK command-line tools load an exported `app` in preference to an exported `rootAgent`, so this is how a plugin applies under `adk web` and `adk run`.

```ts
import {App, InMemoryRunner, LoggingPlugin} from '@google/adk';

export const app = new App({
  name: 'plugin_app',
  rootAgent: agent,
  plugins: [new LoggingPlugin()],
});

const appRunner = new InMemoryRunner({app});
```

### Stopping a tool call

Return an object from `beforeToolCallback` to answer in place of the tool. This plugin blocks the tools whose names it receives:

```ts
import type {BaseTool, Context} from '@google/adk';
import {BasePlugin} from '@google/adk';

class BlockToolsPlugin extends BasePlugin {
  constructor(private readonly blockedTools: ReadonlySet<string>) {
    super('block_tools');
  }

  override async beforeToolCallback({
    tool,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    if (!this.blockedTools.has(tool.name)) {
      return undefined;
    }
    return {error: `The tool '${tool.name}' is not permitted.`};
  }
}
```

### Finding a registered plugin

`runner.pluginManager` is the manager of the runner. Use `getPlugin` to read a plugin that other code registered, and `registerPlugin` to add one after the runner exists:

```ts
const toolCounter = runner.pluginManager.getPlugin('tool_counter');
runner.pluginManager.registerPlugin(new BlockToolsPlugin(new Set(['delete'])));
```

### Typing callback names with `PluginCallbackName`

Use `PluginCallbackName` when your code stores or receives the name of a callback. The compiler then rejects a name that `PluginManager` does not call:

```ts
import type {PluginCallbackName} from '@google/adk';

const callCounts: Partial<Record<PluginCallbackName, number>> = {};

function countCall(callbackName: PluginCallbackName): void {
  callCounts[callbackName] = (callCounts[callbackName] ?? 0) + 1;
}

countCall('beforeToolCallback');
```

### Plugins that the package exports

`@google/adk` exports plugins that are ready to use. Each one extends `BasePlugin`:

- `LoggingPlugin` - Logs the user message, the agent runs, the model requests and responses, the tool calls, and the events.
- `DebugLoggingPlugin` - Records the same interactions in detail for each invocation. It is in the Node.js entry point only.
- `GlobalInstructionPlugin` - Adds one instruction to the model requests of every agent.
- `ReflectAndRetryToolPlugin` and `ReflectAndRetryModelPlugin` - Make the model reflect on a failed tool call or a failed model response and try again, up to a limit.
- `SecurityPlugin` - Checks each tool call against a policy engine.
- `ToolCallIntegrityPlugin` - Stamps function calls and rejects a function call in the session that fails its integrity check.

## Limitations

- **A plugin applies to the whole runner**: You cannot attach a plugin to one agent. Check `agent.name` or `tool.name` in the callback, or use an agent callback.
- **One instance, one registration**: A `PluginManager` rejects the same instance twice and two plugins with the same name. Do not pass a plugin in the `plugins` option when the `app` already has it.
- **A plugin error stops the run**: Except for the two notification callbacks, an error from a plugin callback fails the run. Catch errors in the plugin if the plugin must not stop the run.
- **Plugins run one at a time**: The manager awaits each plugin before it calls the next. A slow callback delays every model request or tool call that it observes.
- **No removal**: `PluginManager` has no method that removes a plugin.
- **`PluginCallbackName` is a type only**: The package has no runtime list of the callback names.
- **Experimental callbacks**: `beforeToolSelection`, `beforeContextCompaction` and `afterContextCompaction` are experimental and can change.

## Related samples

- [`samples/plugins/`](../../../samples/plugins/README.md) - Runnable `hello_world` agent with a `CountInvocationPlugin` that counts agent runs, model requests and tool calls.
