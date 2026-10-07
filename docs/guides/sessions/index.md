# Sessions

A session is one conversation between a user and an application: the events it produced and the state it carries. This guide covers the `Session` shape, the `State` view of it, the `BaseSessionService` contract, and the three services that store sessions: `InMemorySessionService`, `DatabaseSessionService` and `VertexAiSessionService`.

All three services implement the same contract, so the choice between them is a choice of storage:

- `InMemorySessionService` - Sessions live in the process and are lost when it exits. It needs no setup, which suits tests, samples and local development.
- `DatabaseSessionService` - Sessions live in a SQL database through MikroORM. It suits a deployment that already runs PostgreSQL, MySQL, MariaDB, SQL Server or SQLite.
- `VertexAiSessionService` - Sessions live in Vertex AI Agent Engine Sessions. It suits an agent deployed to Agent Engine, where Google Cloud manages the storage.

## Introduction

A `Runner` needs a session service, because every turn reads the session, runs the agent, and appends each non-partial event the agent yields back to the session. The service also owns state scoping. A state key that starts with `app:` is shared by every session of the application, a key that starts with `user:` is shared by every session of one user, a key that starts with `temp:` is never stored, and every other key belongs to the one session.

You call a session service directly to create a session before the first turn, to read a session back after a turn, to list a user's sessions, and to delete one. Agents reach the session through their context, as `ctx.session` and `ctx.state`, and they change state by putting a `stateDelta` on the events they yield.

## Get started

This example creates a session with `InMemorySessionService`, runs one turn through a `Runner`, and reads the session back. Swap in `DatabaseSessionService` or `VertexAiSessionService` to keep sessions somewhere durable; the calls do not change.

```ts
import {InMemorySessionService, LlmAgent, Runner} from '@google/adk';

const sessionService = new InMemorySessionService();
const runner = new Runner({
  appName: 'my_app',
  agent: new LlmAgent({
    name: 'assistant',
    model: 'gemini-flash-latest',
    instruction: 'You are a helpful assistant.',
  }),
  sessionService,
});

const session = await sessionService.createSession({
  appName: 'my_app',
  userId: 'user-1',
  state: {'user:language': 'en', 'topic': 'billing'},
});

for await (const event of runner.runAsync({
  userId: 'user-1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'Hello'}]},
})) {
  // Handle each event.
}

const updated = await sessionService.getSession({
  appName: 'my_app',
  userId: 'user-1',
  sessionId: session.id,
});
```

## How it works

A service stores sessions under a key of three parts: `appName`, `userId` and session id. Every read hands back a `Session` object, and every write goes through `appendEvent`.

### The Session shape

`Session` is an interface with six fields. The `createSession` function builds one from a partial object, and it fills `userId` with `''`, `state` with `{}`, `events` with `[]` and `lastUpdateTime` with `0` when they are not given.

| Field            | Type                      | Description                                                                                                |
| :--------------- | :------------------------ | :--------------------------------------------------------------------------------------------------------- |
| `id`             | `string`                  | The session id.                                                                                            |
| `appName`        | `string`                  | The application the session belongs to.                                                                    |
| `userId`         | `string`                  | The user the session belongs to.                                                                           |
| `state`          | `Record<string, unknown>` | The merged state: session keys as they are, and app and user keys with their `app:` and `user:` prefixes. |
| `events`         | `Event[]`                 | The events of the session, oldest first.                                                                   |
| `lastUpdateTime` | `number`                  | When the session was last written, in milliseconds since the epoch.                                       |

### State and its prefixes

`State` wraps a state map and a pending delta. `State.APP_PREFIX`, `State.USER_PREFIX` and `State.TEMP_PREFIX` hold the three prefix strings, so code can build keys without repeating the literals.

```ts
import {State} from '@google/adk';

const state = new State({'user:language': 'en'});
state.set('step', 1);
state.update({[`${State.APP_PREFIX}theme`]: 'dark'});

state.get('step'); // 1
state.get('missing', 'fallback'); // 'fallback'
state.has('toString'); // false
state.toRecord(); // {'user:language': 'en', step: 1, 'app:theme': 'dark'}
```

`get(key, defaultValue)` looks in the pending delta first and then in the stored value, and returns `defaultValue`, which is `undefined` when omitted, if neither holds the key. `has(key)` reports whether either one holds it. Both look at keys the state holds itself, so a name inherited from `Object.prototype`, such as `toString` or `constructor`, is a missing key rather than a built-in function. `set` and `update` write to both the value and the delta, `hasDelta()` reports whether anything is pending, and `toRecord()` returns the value and the delta merged into one plain object.

Inside an agent, the delta is what reaches storage. The `stateDelta` on an event's actions is the set of changes the service applies when it appends the event. A service splits the delta by prefix: `app:` keys go to the application's state, `user:` keys go to the user's state, `temp:` keys are dropped, and the rest go to the session. `temp:` keys are dropped from the initial state of `createSession` as well, so they are useful for values that only need to live during one invocation.

### The service contract

`BaseSessionService` declares the methods every service implements.

| Method                        | Returns                         | Description                                                                                       |
| :---------------------------- | :------------------------------ | :------------------------------------------------------------------------------------------------ |
| `createSession(request)`      | `Promise<Session>`              | Creates a session. The id is generated when `sessionId` is omitted.                              |
| `getSession(request)`         | `Promise<Session \| undefined>` | Reads a session, or `undefined` when it does not exist.                                           |
| `getOrCreateSession(request)` | `Promise<Session>`              | Reads the session named by `sessionId`, and creates it when it is missing or no id is given.      |
| `listSessions(request)`       | `Promise<ListSessionsResponse>` | Lists sessions of an application, or of one user when `userId` is set.                            |
| `deleteSession(request)`      | `Promise<void>`                 | Deletes a session.                                                                                |
| `appendEvent(request)`        | `Promise<Event>`                | Applies the event's `stateDelta` to the session and appends the event. Partial events are skipped. |

`getSession` takes an optional `config` of type `GetSessionConfig`. `numRecentEvents` keeps only that many of the most recent events, and `afterTimestamp` keeps only events after that time in milliseconds. Use them to bound the size of a long session when you only need its tail.

`listSessions` takes a `ListSessionsRequest`. `limit` sets the page size, `page` is a 1-based page number that takes precedence over `offset`, and `offset` is a zero-based index of the first session. `order` is `'asc'` or `'desc'` by last update time, and no order is applied when it is omitted. The response carries `sessions`, `page`, `limit`, `totalItems` and `totalPages`. Listed sessions carry no events, because loading every event of every session would make a list call as expensive as reading each session.

## Configuration options

Each service has its own constructor, so the options are listed per service.

### InMemorySessionService

`InMemorySessionService` takes no options. Sessions, app state and user state live in maps inside the instance, so two instances do not share anything.

`createSession` removes leading and trailing whitespace from `sessionId`, so a session created as `' abc '` is stored and found as `'abc'`. An id that is empty or only whitespace gets a generated UUID instead. Appending an event to a session the service does not hold logs a warning and returns the event without storing it.

### DatabaseSessionService

`DatabaseSessionService` takes either a connection URI or a MikroORM options object.

| Argument                    | Type               | Description                                                                                                 |
| :-------------------------- | :----------------- | :---------------------------------------------------------------------------------------------------------- |
| `connectionStringOrOptions` | `string`           | A connection URI. The scheme selects the driver.                                                            |
| `connectionStringOrOptions` | MikroORM `Options` | Options passed to `MikroORM.init`. `driver` is required, and the service supplies its own `entities` list. |

The supported URI schemes and the driver package each one needs are below. The drivers are optional peer dependencies, loaded the first time the service connects, so an application that never opens a database does not install them.

| Scheme                          | Driver package          |
| :------------------------------ | :---------------------- |
| `postgres://`, `postgresql://`  | `@mikro-orm/postgresql` |
| `mysql://`                      | `@mikro-orm/mysql`      |
| `mariadb://`                    | `@mikro-orm/mariadb`    |
| `mssql://`                      | `@mikro-orm/mssql`      |
| `sqlite://`                     | `@mikro-orm/sqlite`     |

For SQLite, `sqlite://:memory:` and `sqlite:///:memory:` both open a private in-memory database, so two services on that URI do not see each other's sessions. For any other SQLite URI, everything after `sqlite://` is the file path. `sqlite:///var/data/sessions.db` opens the absolute path `/var/data/sessions.db`, and `sqlite://sessions.db` opens `sessions.db` relative to the working directory.

The service connects, creates missing tables and checks the schema version the first time a method runs. Call `init()` yourself to surface a connection error at startup instead of on the first request. `createSession` rejects an id that already exists.

### VertexAiSessionService

`VertexAiSessionService` takes a `VertexAiSessionServiceOptions` object. Pass `{}` to take every value from the environment.

| Option              | Type       | Default                              | Description                                                                 |
| :------------------ | :--------- | :----------------------------------- | :-------------------------------------------------------------------------- |
| `projectId`         | `string`   | `process.env.GOOGLE_CLOUD_PROJECT`   | The Google Cloud project.                                                   |
| `location`          | `string`   | `process.env.GOOGLE_CLOUD_LOCATION`  | The Google Cloud location, for example `us-central1`.                       |
| `agentEngineId`     | `string`   | none                                 | The reasoning engine that holds the sessions.                               |
| `expressModeApiKey` | `string`   | none                                 | An API key for Vertex AI Express Mode, which this service does not support. |
| `sessions`          | `Sessions` | none                                 | A preconfigured Agent Engine sessions client.                               |

An explicit `projectId` or `location` wins over the environment, and each one falls back on its own. The constructor throws `Project ID and Location are required.` when it still lacks either one. The service authenticates with Application Default Credentials.

When `agentEngineId` is not set, the service reads the reasoning engine from `appName`, which must then be either the numeric engine id or the full resource name `projects/{project}/locations/{location}/reasoningEngines/{id}`.

The Agent Engine client cannot send an API key, so the constructor throws when it is given `expressModeApiKey`, or when Express Mode is turned on in the environment with `GOOGLE_API_KEY` and no project and location are available. When you pass `expressModeApiKey`, the environment fallback for project and location does not apply, so the key is never ignored without an error.

`sessions` replaces the client the service would build, and the project, location and Express Mode checks are skipped. Use it to inject a mock in tests or to share a configured client.

`createSession` on this service takes a `VertexAiCreateSessionRequest`, which adds `ttl`, a lifetime such as `'7200s'`, and `expireTime`, an RFC 3339 UTC time. The two are mutually exclusive, and the service throws before the request when both are set.

### getSessionServiceFromUri

`getSessionServiceFromUri(uri)` builds a service from one string, which suits a command-line flag or an environment variable.

| URI                                    | Service                                                                                                                 |
| :------------------------------------- | :---------------------------------------------------------------------------------------------------------------------- |
| `memory://`                            | `InMemorySessionService`                                                                                                |
| Any database scheme in the table above | `DatabaseSessionService`, with the URI passed through                                                                   |
| `vertexai://...`                       | `VertexAiSessionService`, configured from `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and `GOOGLE_CLOUD_AGENT_ENGINE_ID` |

The rest of a `vertexai://` URI is not read. Any other URI throws `Unsupported session service URI`, with a password in the URI redacted from the message.

## Advanced applications

These patterns build on the contract above.

### Share settings across sessions

Write a `user:` key to keep a preference across every session of one user, and an `app:` key to share a value across every user. The service applies the key to the shared store when the event is appended, and every session read afterwards includes it. The sample linked below runs two sessions for one user and shows which keys carry over.

### Concurrent writes in DatabaseSessionService

`DatabaseSessionService` locks the session row inside a transaction during `appendEvent` and compares the stored update time with `session.lastUpdateTime`. When another writer has appended since your copy of the session was read, the service reloads the stored state and events into your `session` object before applying the new event's `stateDelta` and appending the event.

Reloading brings earlier events and keys written by the other writer into your session object, and your event's `stateDelta` overwrites any key both writers set. Keep using the session object a call returned to you, or call `getSession` before a new turn when you need to inspect state written elsewhere first.

## Limitations

These limits apply today.

- `DatabaseSessionService` needs the MikroORM driver package for its scheme. A missing driver surfaces as an error the first time the service connects, not at import.
- Only `InMemorySessionService.createSession` trims whitespace from a session id. Lookups, `DatabaseSessionService` and `VertexAiSessionService` use the id as given.
- `DatabaseSessionService` reads `sqlite:///path` as an absolute path. A relative file needs the two-slash form, `sqlite://path`.
- `InMemorySessionService` keeps everything in the process, so sessions do not survive a restart and are not shared between processes.
- `VertexAiSessionService` is experimental and logs a warning when constructed. Its behavior can change in a later release, and it does not support Express Mode.

## Related samples

- [samples/sessions/](../../../samples/sessions/README.md) - A deterministic agent that writes session, `user:`, `app:` and `temp:` state, run across two sessions with `InMemorySessionService`.

## Related guides

- [Event](../events/event/index.md) - The `Event` and `EventActions` shapes, including the `stateDelta` a service applies.
- [Artifacts](../artifacts/index.md) - Versioned files scoped to a session, or to a user with the `user:` prefix.
