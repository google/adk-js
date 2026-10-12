# Events (`Event` and `EventActions`)

Every interaction during an agent invocation in the Agent Development Kit (ADK) is represented as an immutable or append-only `Event` carrying conversation content (`Content`), metadata (author, invocation ID, branch, timestamp), and side-effect instructions (`EventActions`).

## Minimal Runnable Example

```typescript
import {
  createEvent,
  createEventActions,
  getFunctionCalls,
  getFunctionResponses,
  isFinalResponse,
  stringifyContent,
} from '@google/adk';

const stateUpdateActions = createEventActions({
  stateDelta: {topic: 'ADK Events', turnCount: 1},
  artifactDelta: {'summary.txt': 1},
});

const modelEvent = createEvent({
  invocationId: 'inv-001',
  author: 'research_assistant',
  content: {
    role: 'model',
    parts: [{text: 'Events capture both conversation content and state transitions.'}],
  },
  actions: stateUpdateActions,
});

console.log('Event ID:', modelEvent.id);
console.log('Is final response:', isFinalResponse(modelEvent));
console.log('Text content:', stringifyContent(modelEvent));
console.log('Function calls:', getFunctionCalls(modelEvent).length);
console.log('Function responses:', getFunctionResponses(modelEvent).length);
```

## How It Works

1. **Event creation (`createEvent`)**: Generates an `Event` with an automatic unique 8-character ID (`newEventId()`), the current Unix timestamp in milliseconds (`Date.now()`), and normalized default `EventActions` (`createEventActions()`).
2. **Final response detection (`isFinalResponse`)**: Determines whether an event is ready to be surfaced as the terminal response for a turn. An event is final when `actions.skipSummarization` is `true`, when `longRunningToolIds` is non-empty, or when `actions.requestedAuthConfigs` is non-empty. Otherwise it is final only when it contains no function calls, no function responses, is not `partial`, and has no trailing code execution result (`hasTrailingCodeExecutionResult`). The `longRunningToolIds` and `requestedAuthConfigs` branches are the behavior that separates this implementation from adk-python v0.1.0.
3. **Tool inspection (`getFunctionCalls`, `getFunctionResponses`)**: Extracts structured `FunctionCall` and `FunctionResponse` parts from `event.content.parts`.
4. **Side effects (`EventActions`)**: Expresses session state mutations (`stateDelta`), artifact version updates (`artifactDelta`), agent handoffs (`transferToAgent`), loop escalation (`escalate`), long-running tool authorization requests (`requestedAuthConfigs`), and tool confirmation requests (`requestedToolConfirmations`).

## Configuration Options

### `Event` Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | `string` | `newEventId()` | Unique 8-character identifier for the event. |
| `invocationId` | `string` | `''` | Identifier of the runner invocation that produced this event. |
| `author` | `string` | `undefined` | `'user'` or the name of the agent that emitted the event. Optional. |
| `content` | `Content` | `undefined` | GenAI message payload containing `role` and `parts`. |
| `actions` | `EventActions` | `createEventActions()` | Side effects and control-flow directives attached to the event. |
| `branch` | `string` | `undefined` | Dot-separated hierarchy of agent names (`agent_1.agent_2`) for isolated sub-histories. |
| `partial` | `boolean` | `undefined` | `true` when the event is an incomplete streaming chunk from the LLM. |
| `turnComplete` | `boolean` | `undefined` | Indicates whether the model turn has completed in streaming/live mode. |
| `interrupted` | `boolean` | `undefined` | Indicates whether generation was interrupted. |
| `longRunningToolIds` | `string[]` | `[]` | Set of `FunctionCall.id` values corresponding to asynchronous long-running tools. |
| `errorCode` | `string` | `undefined` | Machine-readable error code when the model response failed. |
| `errorMessage` | `string` | `undefined` | Human-readable error message when the model response failed. |
| `groundingMetadata` | `GroundingMetadata` | `undefined` | Citation and search grounding metadata returned by the model. |
| `timestamp` | `number` | `Date.now()` | Creation timestamp in milliseconds since the Unix epoch. This is a deliberate divergence from adk-python, which stores seconds; the Vertex session boundary converts between the two. |
| `output` | `unknown` | `undefined` | Structured output produced by the emitting workflow node. Mirrors adk-python `Event.output`. |
| `route` | `Route` | `undefined` | Route key(s) emitted by a routing node, matched against graph edge routes. Mirrors adk-python `Event.route`. |
| `nodeInfo` | `NodeInfo` | `undefined` | Provenance of the emitting workflow node. Mirrors adk-python `Event.node_info`. |
| `isolationScope` | `string` | `undefined` | Scope tag isolating multi-agent conversations so peer scopes do not see each other's events. Mirrors adk-python `Event.isolation_scope`. |
| `customMetadata` | `Record<string, unknown>` | `undefined` | Arbitrary metadata carried from `LlmResponse`. |
| `usageMetadata` | `GenerateContentResponseUsageMetadata` | `undefined` | Token usage metadata carried from `LlmResponse`. |

### `EventActions` Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `skipSummarization` | `boolean` | `undefined` | When `true`, skips post-tool LLM summarization and treats the tool response event as final. |
| `stateDelta` | `Record<string, unknown>` | `{}` | Key-value delta merged into the session state by `SessionService.appendEvent`. |
| `artifactDelta` | `Record<string, number>` | `{}` | Mapping of artifact filename to revision number created or updated during the step. |
| `transferToAgent` | `string` | `undefined` | Target agent name to transfer execution to immediately. |
| `escalate` | `boolean` | `undefined` | Signals a parent loop or workflow agent to terminate or escalate control. |
| `requestedAuthConfigs` | `Record<string, AuthConfig>` | `{}` | Mapping of `FunctionCall.id` to required authentication configuration. |
| `requestedToolConfirmations` | `Record<string, ToolConfirmation>` | `{}` | Mapping of `FunctionCall.id` to a pending tool confirmation request. |

## Advanced Uses

- **Session state mutations without LLM output**: Append a synthetic `Event` whose `actions.stateDelta` updates user or session keys (`user:`, `app:`, `temp:` or unprefixed session keys) via `sessionService.appendEvent({session, event})`.
- **Controlling tool summarization**: Set `actions.skipSummarization = true` on a function-response event so `isFinalResponse(event)` evaluates to `true` and bypasses an extra LLM round-trip.
- **Branch-scoped multi-agent filtering**: Populate `event.branch` so sub-agents only inspect conversation history along their active branch path.

## Limitations

- `partial: true` events are transient streaming chunks and are ignored when persisting state deltas in `SessionService.appendEvent`.
- `temp:` keys in `actions.stateDelta` are stripped before persistence and exist only for the current invocation context.

## Related Samples

- [`samples/events/`](../../../../samples/events/README.md) — Runnable sample exercising `Event`, `EventActions`, `InMemoryRunner`, and event helper utilities.
