# Runner

The runner executes an agent for one application and yields the events the run
produces. It owns the session, the plugin callbacks, the event persistence and
the tracing span, so a caller sends a message and reads events.

## Introduction

An agent on its own answers one invocation. It does not load a conversation, it
does not store what it said, and it does not know which application it belongs
to. The runner supplies all three. It is the object an application holds, and
every other entry point into ADK, including the `adk web` development server,
reaches an agent through one.

A runner is built from an agent and a set of services. The session service is
the only required one, because a run needs somewhere to read the conversation
from and somewhere to append the new events to. The artifact, memory and
credential services are optional, and a feature that needs one fails at the
point it is used rather than at construction, so a runner without a memory
service still runs.

Two classes cover the two situations. `Runner` takes the services you pass it,
which is what a deployed application wants, because the session and artifact
stores are the parts that have to survive a restart.
[`InMemoryRunner`](#zero-setup-with-inmemoryrunner) supplies in-process
implementations of all three, which is what a test or a prototype wants.

## Get started

This example runs one turn of a conversation and collects the reply. The
session is created first, because `runAsync` reads an existing session and
throws when the identifier does not resolve.

```ts
import {InMemoryRunner, LlmAgent} from '@google/adk';

const assistant = new LlmAgent({
  name: 'travel_assistant',
  model: 'gemini-flash-latest',
  instruction: 'Answer questions about the travel plans of the user.',
});

const runner = new InMemoryRunner({agent: assistant, appName: 'travel'});

const session = await runner.sessionService.createSession({
  appName: 'travel',
  userId: 'user_1',
});

let reply = '';
for await (const event of runner.runAsync({
  userId: 'user_1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'Where am I staying in Lisbon?'}]},
})) {
  const text = event.content?.parts?.[0]?.text;
  if (text) {
    reply += text;
  }
}
```

## How it works

`runAsync` is an async generator, so the work happens as the caller pulls
events. A caller that stops iterating stops the run.

One call performs this sequence. Every step is visible to the caller, either as
an event or as a thrown error.

1. The message is checked. A message without a `role` gets `role: 'user'`, and
   a message carrying one of the framework's own function calls
   (`adk_request_confirmation`, `adk_request_credential`, `adk_request_input`)
   is rejected, because a client may answer those questions but never raise
   them.
2. The runner loads the session from the session service. A missing session
   throws `Session not found: <id> (appName=<app>, userId=<user>)` unless
   `autoCreateSession: true` is set on the runner, in which case the runner
   creates it with `getOrCreateSession`.
3. Plugins see the incoming message through `onUserMessageCallback` and may
   replace it.
4. The runner appends the message to the session as an event authored by
   `user`, carrying `stateDelta` and `customMetadata` when the caller passed
   them. A message with no parts throws `No parts in the newMessage.`
5. The runner picks the agent that continues the conversation, described in
   [Which agent answers](#which-agent-answers).
6. Plugins get `beforeRunCallback`. A plugin that returns content there ends
   the invocation: the runner stores that content as an event authored by
   `model`, yields it, and never starts the agent.
7. The agent runs. Each event it produces goes through `onEventCallback`, is
   appended to the session unless it is partial, and is then yielded.
8. Plugins see the finished run through `afterRunCallback`.

Partial events are yielded but not stored. A streaming model emits the same
text several times as it grows, and storing every partial event would record
the same sentence repeatedly, so only the completed event reaches the session.

The whole call runs inside an OpenTelemetry span named `invocation`. When the
generator finishes, including the path where the caller abandons it, the runner
closes every toolset in the agent tree.

### The entry points

Each method answers a different question about where the conversation lives.

| Method                                           | Use it when                                                                        |
| :----------------------------------------------- | :--------------------------------------------------------------------------------- |
| `runAsync({userId, sessionId, newMessage})`      | The conversation has a session, and you want the events appended to it.            |
| `runEphemeral({userId, newMessage})`             | The turn is a one-off. The runner creates a session and deletes it in a `finally`. |
| `runLive({userId, sessionId, liveRequestQueue})` | The conversation is bidirectional streaming audio or text. Experimental.           |

`runAsync` also takes optional `stateDelta`, `runConfig`, `abortSignal` and
`customMetadata`. `runEphemeral` takes the same options except `sessionId` and
`abortSignal`. It deletes its session on every exit path, including the error
path, so nothing accumulates when it is called in a loop. It does not return
the identifier of the session it created, so the conversation cannot be read
back after the generator finishes.

`runLive` differs from `runAsync` in four ways:

- It creates the session when it does not exist (`getOrCreateSession`).
- It defaults `runConfig.responseModalities` to `[Modality.AUDIO]`. For an
  agent that has sub-agents it also sets `outputAudioTranscription` when the
  modalities include audio, and always sets `inputAudioTranscription`, because
  a transferred agent needs the text of the conversation as context.
- It does not store model media events carrying raw inline bytes (`audio/`,
  `video/` or `image/` MIME types). They are yielded, but kept out of the
  session so it does not fill with audio. Transcriptions, tool calls and
  `fileData` references are stored.
- It accepts `liveSessionResumptionHandle`, a handle from an earlier `runLive`
  on the same conversation, so the server restores its own state instead of
  the client replaying history.

### Which agent answers

A conversation with sub-agents does not always restart at the root. Before the
agent runs, the runner reads the session and picks, in order:

1. With `resumabilityConfig.isResumable` set, and the last event answering a
   function call, the agent that made that call. When the answers resolve to
   calls from more than one agent, the run throws, because no single agent can
   be resumed.
2. Otherwise, walking back from the newest event, the author of the most recent
   non-user event, when it is the root, or when it is an `LlmAgent` whose
   ancestors are all `LlmAgent`s with `disallowTransferToParent` unset. An
   author not in the agent tree is skipped.
3. Otherwise, the root agent.

The same logic is exported as `determineAgentForResumption` and
`isRoutableLlmAgent`, for a caller that needs to predict the choice.

### Archiving a finished conversation

The runner has no archiving method of its own. Hand the finished session to the
memory service with `addSessionToMemory`, which makes its events searchable
through `searchMemory`. This is what turns a session that has ended into
something a later conversation can recall.

```ts
await runner.memoryService!.addSessionToMemory(session);

const {memories} = await runner.memoryService!.searchMemory({
  appName: 'travel',
  userId: 'user_1',
  query: 'Lisbon',
});
```

Two properties are worth knowing before you call it.

A rejection from the memory service reaches the caller unchanged. An ingest
that fails is a conversation that is silently unsearchable later, so the error
is not swallowed.

The session is not mutated and not deleted. `addSessionToMemory` reads it, and
calling it twice ingests it twice, which the memory service is expected to
tolerate.

### Zero setup with InMemoryRunner

`InMemoryRunner` is a `Runner` that constructs an `InMemoryArtifactService`, an
`InMemorySessionService` and an `InMemoryMemoryService` for you, and defaults
`appName` to `'InMemoryRunner'`. It takes only `app`, `agent`, `appName`,
`plugins` and `resumabilityConfig`; the services are not replaceable.

```ts
const runner = new InMemoryRunner({agent: assistant, appName: 'travel'});
```

Everything it stores lives in the process and disappears with it. That is the
property a test wants, because each test starts from an empty store without
cleaning up after the last one.

## Configuration options

`Runner` takes one `RunnerConfig` object. An `App` is an alternative to naming
the parts separately, not an addition to them.

| Option               | Type                                            | Default  | Description                                                                      |
| :------------------- | :---------------------------------------------- | :------- | :------------------------------------------------------------------------------- |
| `app`                | `App`                                           | none     | Supplies `appName`, `agent`, `plugins` and `resumabilityConfig` from one object. |
| `appName`            | `string`                                        | none     | The application name. Required when `app` is absent.                             |
| `agent`              | `RunnableNode`                                  | none     | The root agent or workflow. Required when `app` is absent.                       |
| `plugins`            | `BasePlugin[]`                                  | `[]`     | Callbacks applied across every agent in the run.                                 |
| `sessionService`     | `BaseSessionService`                            | required | Where conversations are read and appended.                                       |
| `artifactService`    | `BaseArtifactService \| SessionArtifactService` | none     | Where binary parts of a message are stored.                                      |
| `memoryService`      | `BaseMemoryService`                             | none     | Where a finished session is archived with `addSessionToMemory`.                  |
| `credentialService`  | `BaseCredentialService`                         | none     | Where tools store exchanged authentication credentials.                          |
| `resumabilityConfig` | `ResumabilityConfig`                            | none     | Whether an invocation can pause on a long-running call and resume later.         |
| `autoCreateSession`  | `boolean`                                       | `false`  | Whether `runAsync` creates a missing session instead of throwing.                |

`app` wins over the individual fields: the runner reads `app.name`,
`app.rootAgent` and `app.resumabilityConfig` first and falls back to `appName`,
`agent` and `resumabilityConfig`. Plugins are the exception: the runner
concatenates the plugins of the app with the plugins of the configuration
rather than choosing between them. A runner built with neither `app.rootAgent`
nor `agent` throws at construction.

`sessionService` is the one service a run cannot proceed without. `runAsync`
calls `getSession` before anything else and `appendEvent` after every
non-partial event, so the service decides both what the agent sees as history
and what survives the call.

`artifactService` is what makes a binary part of a message storable. A
`BaseArtifactService` is wrapped per run so the agent sees it scoped to the
current app, user and session. With `runConfig.saveInputBlobsAsArtifacts` set
(it defaults to `false`), each `inlineData` part of the incoming message is
saved under its `displayName`, or `artifact_<invocationId>_<index>` when it has
none, and replaced in the stored message by the text
`[Uploaded Artifact: "<name>"]`. When the saved version has a `gs:`, `http:` or
`https:` canonical URI, a `fileData` part pointing at it is added as well. A
part that fails to save is logged and kept inline.

`memoryService` is passed to the invocation context, so a memory tool the agent
calls searches the same store you archive a finished session to with
`addSessionToMemory`.

`runConfig.supportCfc` (default `false`) enables compositional function calling
for an `LlmAgent` root. The runner throws `CFC is not supported for model: ...`
unless the model is Gemini 2 or later, and sets the agent's `codeExecutor` to a
`BuiltInCodeExecutor` when it is not one already.

## Advanced applications

Two configurations change what the runner does rather than which services it
uses.

### Running a workflow instead of an agent

`agent` accepts any runnable node, so a `Workflow` is a valid root and the
runner drives it directly. A graph therefore needs no wrapper agent to be run,
and its events reach the session through the same path, with the same plugin
callbacks and persistence.

```ts
const runner = new InMemoryRunner({agent: myWorkflow, appName: 'pipeline'});
```

`runLive` is the exception: it throws `runLive is only supported for agents.`
when the root is a bare node.

### Cancelling a run

`runAsync` and `runLive` accept an `abortSignal`. The runner checks it between
steps and returns, which ends the generator without an error.

```ts
const controller = new AbortController();
for await (const event of runner.runAsync({
  userId: 'user_1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'Summarize the itinerary.'}]},
  abortSignal: controller.signal,
})) {
  // Call controller.abort() from elsewhere to stop the run.
}
```

Events already appended to the session stay there. Aborting stops the run; it
does not undo it. Before the generator ends, the runner seals the aborted
invocation in session history: it answers any dangling function call with a
synthetic error `functionResponse` event, or records a plain abort event when
there is nothing to answer.

## Limitations

`runAsync` does not create a missing session by default (`autoCreateSession:
false`). A caller that has not created one yet calls `createSession` or
`getOrCreateSession` on the session service first, or sets
`autoCreateSession: true` on the runner to have `runAsync` create it.

There is no synchronous `run`. A JavaScript function cannot block on a promise,
so every entry point is an async generator.

`runEphemeral` cannot be paired with archiving. It deletes the session when the
generator finishes and never exposes the identifier, so there is no point at
which a caller holds the session to archive it. Create the session yourself and
use `runAsync` when the conversation has to be kept.

`addSessionToMemory` archives only what the session service holds. Partial
events are never appended, so the streamed fragments of a reply are not
searchable, and the completed event that replaces them is.

`runLive` does not populate `InvocationContext.activeStreamingTools`, so a
streaming tool that expects its own `LiveRequestQueue` is not tracked.

## Related samples

- [`samples/runners/`](../../../samples/runners/README.md) - Archiving a
  finished conversation with `addSessionToMemory` and reading it back through a
  memory-search tool.
