# Events Sample (`Event` and `EventActions`)

This sample demonstrates how ADK `Event` and `EventActions` represent conversation turns, tool calls, tool responses, state updates, and artifact revisions during an `InMemoryRunner` invocation.

## What It Covers

- Creating structured events with `createEvent` and `createEventActions`
- Inspecting function calls and responses with `getFunctionCalls` and `getFunctionResponses`
- Detecting terminal events with `isFinalResponse` and `hasTrailingCodeExecutionResult`
- Extracting plain text from event content with `stringifyContent`
- Applying `stateDelta` and `artifactDelta` across a session via `InMemoryRunner`

## Running the Sample

This sample is run directly rather than through the ADK CLI (`npm run sample`).
The CLI surfaces the agent's conversational text, but the subject here is the
`Event` object itself, so the sample runs the agent with `InMemoryRunner` and
prints each event decomposed into its fields. From the repository root:

```bash
npx tsx samples/events/agent.ts
```

`samples/` is not an npm workspace, so it is type-checked separately, in CI and
locally:

```bash
npm run ts:check:samples
```

## Related Guides

- [Event](../../docs/guides/events/event/index.md) - The `Event` and `EventActions` shapes and the helper functions this sample calls.
