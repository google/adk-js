# ToolContext

`ToolContext` is the name a tool uses for the context object the framework
hands it. It is an alias of `Context`, so the two names refer to one class.
Reach for it when you write a tool, or when you port an agent from the Python
SDK and want the import to line up.

## Introduction

adk-js has one context class, `Context`. It carries the invocation, the
delta-aware `State`, the `EventActions` the current call will emit, and the
artifact and memory helpers a tool calls. Earlier ADK versions split this role
across a tool-facing type and a callback-facing type. adk-js unified them, and
`google.adk.tools.tool_context` in the Python SDK made the same decision: it
binds `ToolContext = Context`.

This module gives adk-js the same two names. `ToolContext` and
`CallbackContext` are plain re-exports of `Context`, not subclasses. That
matters for assignability in both directions. A `Context` the framework builds
satisfies a parameter typed `ToolContext`, and a `ToolContext` you construct in
a test is accepted everywhere `Context` is. A subclass would give you only one
of those directions.

Use whichever name reads best at the call site. `Context` is the name the rest
of adk-js uses, so new TypeScript code can keep using it. `ToolContext` is what
the Python documentation and Python examples say, so it is the name to use when
you follow them.

The module also re-exports `AuthHandler`, and the `AuthConfig` and
`AuthCredential` types, because Python re-exports them from the same path. A
tool that declares its credentials can take the context type and the auth types
from one import.

## Get started

This example writes to session state through a `ToolContext`, and reads the
pending delta back. It needs no model and no credentials.

```ts
import {
  Context,
  createEventActions,
  createSession,
  FunctionTool,
  InvocationContext,
  PluginManager,
  ToolContext,
} from '@google/adk';
import {z} from 'zod/v4';

const rememberTool = new FunctionTool({
  name: 'remember',
  description: 'Stores a value in session state.',
  parameters: z.object({key: z.string(), value: z.string()}),
  execute: async (input, toolContext?: ToolContext) => {
    toolContext?.state.set(input.key, input.value);
    return `stored ${input.key}`;
  },
});

const eventActions = createEventActions();
const toolContext = new ToolContext({
  invocationContext: new InvocationContext({
    invocationId: 'invocation-1',
    session: createSession({id: 'session-1', appName: 'notes'}),
    pluginManager: new PluginManager([]),
  }),
  eventActions,
  functionCallId: 'fc-1',
});

await rememberTool.runAsync({args: {key: 'city', value: 'Paris'}, toolContext});

toolContext.state.get('city'); // 'Paris'
eventActions.stateDelta; // {city: 'Paris'}
toolContext instanceof Context; // true
```

The tool receives the context adk-js built. Nothing converts or wraps it,
because `ToolContext` and `Context` are the same class.

## What the module exports

| Name              | Kind  | Binds to         |
| ----------------- | ----- | ---------------- |
| `ToolContext`     | class | `Context`        |
| `CallbackContext` | class | `Context`        |
| `AuthHandler`     | class | `AuthHandler`    |
| `AuthConfig`      | type  | `AuthConfig`     |
| `AuthCredential`  | type  | `AuthCredential` |

`ToolContext` and `CallbackContext` are also exported from the package root, so
`import {ToolContext} from '@google/adk'` works. The auth names already had a
root export of their own.

The three identities hold at runtime, which is what makes the alias useful
rather than decorative:

```ts
import {CallbackContext, Context, ToolContext} from '@google/adk';

ToolContext === Context; // true
CallbackContext === Context; // true
ToolContext === CallbackContext; // true
```

## Differences from the Python module

Python resolves `AuthHandler`, `AuthConfig` and `AuthCredential` lazily through
a module-level `__getattr__`, which defers the import cost of the auth package.
TypeScript has no equivalent hook, and a dynamic `import()` would make the names
asynchronous and break the alias. The TypeScript module re-exports them
statically. There is no import cycle to avoid: `agents/context.ts` already
imports all three auth modules.

Python's `__getattr__` also raises `AttributeError` for any other name. In
TypeScript that guarantee is static — an unlisted name is a compile error.
