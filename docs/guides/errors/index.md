# ADK errors

`@google/adk` exports seven error classes that ADK throws on its own behalf, rather than passing along from a dependency. Each one marks a condition the framework reports so that you can do something about it, and each one sets `name` to its class name.

## Introduction

Most failures you see from ADK still arrive as a plain `Error`, or come from somewhere else, such as an `ApiError` from `@google/genai` or a `ZodError` from schema parsing. The seven classes on this page are the ones ADK defines itself.

Three facts shape how you work with them.

- **There is no common base class.** All seven extend `Error` directly, so there is no single check that means "an ADK error". Test for the classes you handle by name.
- **Some are thrown in only a few places today.** ADK is moving its checks from a plain `Error` to these classes, tracked in [#807](https://github.com/google/adk-js/issues/807). Each section below lists where the class is thrown now, and a `catch` block should keep a fallback for `Error`.
- **Two have a type guard.** `isStaleSessionError` and `isLlmCallsLimitExceededError` also match an error thrown by a second copy of `@google/adk` in `node_modules`, where `instanceof` fails. Prefer them over `instanceof` for those two classes.

## The seven errors

| Error                        | Import from                                  |
| ---------------------------- | -------------------------------------------- |
| `InputValidationError`       | `@google/adk`                                |
| `NotFoundError`              | `@google/adk`                                |
| `SessionNotFoundError`       | `@google/adk`                                |
| `AlreadyExistsError`         | `@google/adk`                                |
| `StaleSessionError`          | `@google/adk` (Node.js entry point only)     |
| `ToolExecutionError`         | `@google/adk`, with the `ToolErrorType` enum |
| `LlmCallsLimitExceededError` | `@google/adk`                                |

### `InputValidationError`

**Thrown by** `loadSkillFromDir` and `loadSkillFromZipBuffer` on a `SKILL.md` whose frontmatter is missing, unclosed or not valid YAML, on a skill name that does not match its directory, and on a zip entry with a traversal path. Also by `LocalEvalSetResultsManager` on an app, eval set or result id that is empty, holds a null byte or a path separator, is drive-qualified, or is `.` or `..`, and by the `ExampleTool` constructor on examples that are not well formed.

**Means** a value that arrived at call time is unsafe or unusable. Several of these checks are path-traversal guards, so read one as a signal about untrusted input rather than a bug in ADK. The class is also meant for tool arguments the model generated.

**Catch it at the boundary** where you accept the value, and turn it into an error response of your own. Retrying the same call fails the same way.

### `NotFoundError`

**Thrown by** `loadSkillFromDir` and `loadSkillFromZipBuffer` when a directory or zip archive has no `SKILL.md`, and by `LocalEvalSetResultsManager.getEvalSetResult` for an unknown result id.

**Means** a resource looked up by name at call time does not exist. A missing session is `SessionNotFoundError` instead.

**Catch it** when you want to tell "no such skill or eval result" apart from a real failure.

### `SessionNotFoundError`

**Thrown by** nothing in ADK yet. A missing session currently surfaces as a plain `Error`, and `getSession` returns `undefined` rather than throwing.

**Means** the requested session was never created or has been deleted. It is not a transient condition, so the fix is to create the session first.

### `AlreadyExistsError`

**Thrown by** nothing in ADK yet.

**Means** a resource being created has an id that is already taken, such as a session id passed to `createSession`.

### `StaleSessionError`

**Thrown by** `DatabaseSessionService.appendEvent`, which locks the session row and compares its stored update time with `session.lastUpdateTime`.

**Means** the `Session` you hold has fallen behind the stored copy, because another writer appended after you read it. The event and its state changes were not stored.

**Catch it.** This is the error on this page with a real recovery: re-read the session with `getSession` and append again to the fresh copy. Setting `staleSession: 'reload'` on the service restores the deprecated behaviour of reloading instead of throwing.

```ts
import {isStaleSessionError} from '@google/adk';

try {
  await sessionService.appendEvent({session, event});
} catch (error) {
  if (!isStaleSessionError(error)) throw error;
  const fresh = await sessionService.getSession({
    appName: session.appName,
    userId: session.userId,
    sessionId: session.id,
  });
  await sessionService.appendEvent({session: fresh!, event});
}
```

### `ToolExecutionError`

**Thrown by** nothing in ADK yet, so in practice this class is for you to throw from your own tools.

**Means** a tool ran and failed in a way worth classifying. The optional second argument, `errorType`, is a `ToolErrorType` member or a raw string such as `'500'`, and is readable back as `error.errorType`.

**Throw it rather than catching it.** Whatever you put in `errorType` becomes the OpenTelemetry `error.type` attribute on the tool span, and the class name is used only when it is unset. `ToolErrorType` has nine HTTP-shaped members: `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `REQUEST_TIMEOUT`, `INTERNAL_SERVER_ERROR`, `BAD_GATEWAY`, `SERVICE_UNAVAILABLE` and `GATEWAY_TIMEOUT`.

```ts
throw new ToolExecutionError(
  `Inventory service did not respond for sku=${sku}`,
  ToolErrorType.GATEWAY_TIMEOUT,
);
```

Throw it from a `BaseTool` subclass. `FunctionTool` rethrows anything its function throws as a plain `Error`, so the class and `errorType` are lost there.

### `LlmCallsLimitExceededError`

**Thrown by** the invocation context when an invocation, across the root agent and all its sub-agents, makes more model calls than `runConfig.maxLlmCalls` allows.

**Means** the run hit its call budget. It is not retryable as it stands. Raise the limit or end the run.

## Retries and telemetry match by class name

Two parts of ADK look at the class of an error, so changing a plain `Error` to one of these classes changes how they treat it.

- **Workflow retries.** `RetryConfig.exceptions` lists the error classes, or their names, that a node retries on. A list containing `'Error'` matches only a plain `Error`, not these classes. Leaving it unset retries every error.
- **Spans.** A failed span records `error.type` from the error's `errorType` when it has one, then the status of a Gemini API error, then the class name.

## Limitations

- **No shared base class.** You cannot write one check for "any ADK error".
- **Most checks still throw a plain `Error`.** That includes developer misconfiguration, such as invalid constructor options, duplicate tool names or an unknown `model` string, which stays a plain `Error` on purpose: fix the code rather than catching it.
- **The constructors differ.** `InputValidationError` accepts `{cause}` as a second argument. `ToolExecutionError` requires a message and takes `errorType` second. `StaleSessionError` requires a message. The others take an optional message with a default.
- **`StaleSessionError` is Node.js only.** It is exported alongside `DatabaseSessionService` from the Node.js entry point, not the browser one.

## Related guides

- [Sessions](../sessions/index.md) - Concurrent writes in `DatabaseSessionService` and the `staleSession` option.
- [Agents](../agents/index.md) - Enforcing `runConfig.maxLlmCalls` with `LlmCallsLimitExceededError`.
- [Telemetry](../telemetry/index.md) - The spans ADK writes and the attributes on them.
- [Tools](../tools/index.md) - `BaseTool`, `FunctionTool`, and `ExampleTool`.
