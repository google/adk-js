# Events

Events are the fundamental unit of communication in ADK-JS, representing all interactions between agents, users, and tools. Every action in a conversation generates events that are stored in the session history.

## Table of Contents

- [Event Interface](#event-interface)
- [EventActions](#eventactions)
- [Event Utility Functions](#event-utility-functions)
- [Branching for Parallel Agents](#branching-for-parallel-agents)
- [Snake Case and Camel Case Transforms](#snake-case-and-camel-case-transforms)
- [Partial Events](#partial-events)
- [AgentEvent Types](#agentevent-types)
- [mergeEventActions](#mergeeventactions)

## Event Interface

The `Event` interface extends `LlmResponse` and represents a single event in the conversation.

### Complete Structure

```typescript
interface Event extends LlmResponse {
  // Identification
  id: string;                    // Unique event ID (auto-generated)
  invocationId: string;          // Invocation ID (tracks execution context)
  author?: string;               // 'user' or agent name
  timestamp: number;             // Unix timestamp (milliseconds)

  // Actions taken by this event
  actions: EventActions;

  // Optional fields
  longRunningToolIds?: string[]; // IDs of long-running function calls
  branch?: string;               // Branch identifier for parallel execution

  // Inherited from LlmResponse
  content?: Content;                  // Event content
  groundingMetadata?: GroundingMetadata;
  partial?: boolean;                  // True for streaming chunks
  turnComplete?: boolean;
  errorCode?: string;
  errorMessage?: string;
  interrupted?: boolean;
  customMetadata?: Record<string, unknown>;
  usageMetadata?: GenerateContentResponseUsageMetadata;
  finishReason?: FinishReason;
  liveSessionResumptionUpdate?: LiveServerSessionResumptionUpdate;
  inputTranscription?: Transcription;
  outputTranscription?: Transcription;
}
```

### Field Descriptions

#### Core Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique 8-character alphanumeric identifier (auto-generated) |
| `invocationId` | `string` | Yes | Links event to specific agent execution |
| `author` | `string` | No | Source of event: `'user'` or agent name |
| `timestamp` | `number` | Yes | Creation time (milliseconds since epoch) |
| `actions` | `EventActions` | Yes | Actions and state changes from this event |

#### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `longRunningToolIds` | `string[]` | Function call IDs for async tools |
| `branch` | `string` | Branch path in parallel agent execution |
| `partial` | `boolean` | True for incomplete streaming responses |
| `content` | `Content` | Message content (text, function calls, etc.) |
| `errorCode` | `string` | Error identifier if event represents failure |
| `errorMessage` | `string` | Human-readable error description |
| `usageMetadata` | `object` | Token usage statistics |

### Creating Events

```typescript
import { createEvent, createEventActions } from '@google/adk';

// Minimal event
const event = createEvent();

// Event with content
const event = createEvent({
  author: 'my-agent',
  content: {
    role: 'model',
    parts: [{ text: 'Hello, how can I help?' }]
  }
});

// Event with actions
const event = createEvent({
  author: 'tool-agent',
  actions: createEventActions({
    stateDelta: { 'user:score': 100 },
    transferToAgent: 'another-agent'
  })
});
```

### Event ID Generation

Event IDs are 8-character alphanumeric strings:

```typescript
function createNewEventId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}
```

**Examples:** `a3Bc9Zx2`, `Qw7eRt1Y`, `9Mn4Kl8P`

### Author Field

The `author` field identifies the event source:

- `'user'` - Event from end user
- `'agent-name'` - Event from agent with that name
- `undefined` - System or unattributed events

```typescript
// User message
const userEvent = createEvent({
  author: 'user',
  content: { role: 'user', parts: [{ text: 'Hello' }] }
});

// Agent response
const agentEvent = createEvent({
  author: 'assistant',
  content: { role: 'model', parts: [{ text: 'Hi there!' }] }
});
```

## EventActions

`EventActions` tracks all state changes and control flow decisions made during an event.

### Interface

```typescript
interface EventActions {
  // State management
  stateDelta: {[key: string]: unknown};           // State changes
  artifactDelta: {[key: string]: number};         // Artifact version updates

  // Control flow
  transferToAgent?: string;                        // Target agent for transfer
  escalate?: boolean;                              // Escalate to parent agent
  skipSummarization?: boolean;                     // Skip LLM summarization

  // User interactions
  requestedAuthConfigs: {[key: string]: AuthConfig};        // Auth requests by call ID
  requestedToolConfirmations: {[key: string]: ToolConfirmation}; // Confirmations by call ID
}
```

### Field Details

#### stateDelta

Records state changes to be applied to the session:

```typescript
{
  stateDelta: {
    'user:name': 'Alice',
    'user:score': 100,
    'app:version': '1.2.3',
    'temp:cache': { data: [] }
  }
}
```

- Keys can have prefixes: `app:`, `user:`, `temp:` (see [Sessions](./sessions.md))
- Applied atomically when event is appended to session
- `temp:` prefixed keys excluded from persistence

#### artifactDelta

Tracks artifact version updates:

```typescript
{
  artifactDelta: {
    'report.pdf': 2,      // Updated to version 2
    'data.json': 5        // Updated to version 5
  }
}
```

- Key: artifact filename
- Value: new version number
- Used by artifact service for versioning

#### transferToAgent

Specifies agent transfer target:

```typescript
{
  transferToAgent: 'specialist-agent'
}
```

- Set by `transfer_to_agent` tool
- Runner uses this to determine next agent
- Enables agent-to-agent handoff

#### escalate

Signals early termination in LoopAgent:

```typescript
{
  escalate: true
}
```

- Causes LoopAgent to exit immediately
- Propagates control to parent agent
- Used for exception handling patterns

#### skipSummarization

Prevents LLM from summarizing function responses:

```typescript
{
  skipSummarization: true
}
```

- Set by `AgentTool` with `skipSummarization: true`
- Function response used directly without LLM processing
- Improves performance for structured tool outputs

#### requestedAuthConfigs

Maps function call IDs to authentication requests:

```typescript
{
  requestedAuthConfigs: {
    'call-abc123': {
      type: 'oauth2',
      provider: 'google',
      scopes: ['drive.readonly']
    }
  }
}
```

- Set via `toolContext.requestCredential(authConfig)`
- Key: `functionCallId` from tool context
- Value: `AuthConfig` object

#### requestedToolConfirmations

Maps function call IDs to confirmation requests:

```typescript
{
  requestedToolConfirmations: {
    'call-xyz789': {
      hint: 'Delete 42 files?',
      confirmed: false,
      payload: { fileCount: 42 }
    }
  }
}
```

- Set via `toolContext.requestConfirmation({hint, payload})`
- Key: `functionCallId` from tool context
- Value: `ToolConfirmation` object

### Creating EventActions

```typescript
import { createEventActions } from '@google/adk';

// Empty actions
const actions = createEventActions();

// With initial values
const actions = createEventActions({
  stateDelta: { 'user:score': 100 },
  transferToAgent: 'next-agent',
  escalate: true
});
```

**Defaults:**

```typescript
{
  stateDelta: {},
  artifactDelta: {},
  requestedAuthConfigs: {},
  requestedToolConfirmations: {}
}
```

## Event Utility Functions

ADK-JS provides utility functions for analyzing and manipulating events.

### isFinalResponse()

Determines if an event is the final response from an agent:

```typescript
function isFinalResponse(event: Event): boolean {
  if (
    event.actions.skipSummarization ||
    (event.longRunningToolIds && event.longRunningToolIds.length > 0)
  ) {
    return true;
  }

  return (
    getFunctionCalls(event).length === 0 &&
    getFunctionResponses(event).length === 0 &&
    !event.partial &&
    !hasTrailingCodeExecutionResult(event)
  );
}
```

**Returns true when:**
- `skipSummarization` is set, OR
- Event has long-running tool IDs, OR
- No function calls/responses AND not partial AND no trailing code execution

**Usage:**

```typescript
for await (const event of runner.runAsync(...)) {
  if (isFinalResponse(event)) {
    console.log('Final response:', event.content);
    break;
  }
}
```

### getFunctionCalls()

Extracts all function calls from event content:

```typescript
function getFunctionCalls(event: Event): FunctionCall[] {
  const funcCalls = [];
  if (event.content && event.content.parts) {
    for (const part of event.content.parts) {
      if (part.functionCall) {
        funcCalls.push(part.functionCall);
      }
    }
  }
  return funcCalls;
}
```

**Example:**

```typescript
const calls = getFunctionCalls(event);
for (const call of calls) {
  console.log(`Tool: ${call.name}`, call.args);
}
```

### getFunctionResponses()

Extracts all function responses from event content:

```typescript
function getFunctionResponses(event: Event): FunctionResponse[] {
  const funcResponses = [];
  if (event.content && event.content.parts) {
    for (const part of event.content.parts) {
      if (part.functionResponse) {
        funcResponses.push(part.functionResponse);
      }
    }
  }
  return funcResponses;
}
```

**Example:**

```typescript
const responses = getFunctionResponses(event);
for (const response of responses) {
  console.log(`Response for ${response.name}:`, response.response);
}
```

### hasTrailingCodeExecutionResult()

Checks if the last content part is a code execution result:

```typescript
function hasTrailingCodeExecutionResult(event: Event): boolean {
  if (event.content && event.content.parts?.length) {
    const lastPart = event.content.parts[event.content.parts.length - 1];
    return lastPart.codeExecutionResult !== undefined;
  }
  return false;
}
```

**Usage:**

```typescript
if (hasTrailingCodeExecutionResult(event)) {
  // Model executed code, might need another turn
}
```

### stringifyContent()

Concatenates all text parts into a single string:

```typescript
function stringifyContent(event: Event): string {
  if (!event.content?.parts) {
    return '';
  }
  return event.content.parts.map((part) => part.text ?? '').join('');
}
```

**Example:**

```typescript
const text = stringifyContent(event);
console.log('Event text:', text);
```

## Branching for Parallel Agents

The `branch` field enables isolated conversation histories for parallel agent execution.

### Branch Format

Branch paths use dot notation to represent the agent hierarchy:

```
agent_1.agent_2.agent_3
```

- `agent_1` is the root
- `agent_2` is a child of `agent_1`
- `agent_3` is a child of `agent_2`

### Use Case: ParallelAgent

When `ParallelAgent` runs sub-agents concurrently, each sub-agent operates in an isolated branch:

```typescript
const parallelAgent = new ParallelAgent({
  name: 'coordinator',
  agents: [
    new LlmAgent({ name: 'researcher' }),
    new LlmAgent({ name: 'analyzer' }),
    new LlmAgent({ name: 'writer' })
  ]
});
```

**Event branches:**

```
coordinator                      # Main branch
coordinator.researcher           # Researcher's branch
coordinator.analyzer             # Analyzer's branch
coordinator.writer               # Writer's branch
```

### Branch Isolation

Agents in different branches don't see each other's events:

```typescript
// Researcher sees only:
// - coordinator branch events
// - coordinator.researcher branch events

// Analyzer sees only:
// - coordinator branch events
// - coordinator.analyzer branch events

// Writer sees only:
// - coordinator branch events
// - coordinator.writer branch events
```

### Creating Branch Context

```typescript
function createBranchCtxForSubAgent(
  parentContext: InvocationContext,
  subAgent: BaseAgent
): InvocationContext {
  const branchId = parentContext.branch
    ? `${parentContext.branch}.${subAgent.name}`
    : subAgent.name;

  return new InvocationContext({
    ...parentContext,
    agent: subAgent,
    branch: branchId
  });
}
```

### Event Filtering by Branch

When retrieving session history, filter by branch:

```typescript
function filterEventsByBranch(
  events: Event[],
  branch: string
): Event[] {
  return events.filter(event => {
    if (!event.branch) return true;  // Root events visible to all
    return event.branch === branch || event.branch.startsWith(branch + '.');
  });
}
```

## Snake Case and Camel Case Transforms

ADK-JS provides bidirectional conversion between snake_case and camelCase for event serialization.

### Transform Functions

#### transformToCamelCaseEvent()

Converts snake_case event to camelCase `Event`:

```typescript
function transformToCamelCaseEvent(
  event: Record<string, unknown>
): Event {
  return toCamelCase(event, PRESERVE_KEYS_SNAKE_CASE) as Event;
}
```

**Example:**

```typescript
const snakeCaseEvent = {
  id: 'abc123',
  invocation_id: 'inv-456',
  author: 'my-agent',
  long_running_tool_ids: ['tool-1'],
  actions: {
    state_delta: { 'user:score': 100 },
    transfer_to_agent: 'next-agent'
  }
};

const event = transformToCamelCaseEvent(snakeCaseEvent);
// event.invocationId === 'inv-456'
// event.longRunningToolIds === ['tool-1']
// event.actions.stateDelta === { 'user:score': 100 }
// event.actions.transferToAgent === 'next-agent'
```

#### transformToSnakeCaseEvent()

Converts camelCase `Event` to snake_case object:

```typescript
function transformToSnakeCaseEvent(
  event: Event
): Record<string, unknown> {
  return toSnakeCase(event, PRESERVE_KEYS_CAMEL_CASE) as Record<string, unknown>;
}
```

**Example:**

```typescript
const event = createEvent({
  invocationId: 'inv-456',
  longRunningToolIds: ['tool-1'],
  actions: createEventActions({
    stateDelta: { 'user:score': 100 },
    transferToAgent: 'next-agent'
  })
});

const snakeCaseEvent = transformToSnakeCaseEvent(event);
// snakeCaseEvent.invocation_id === 'inv-456'
// snakeCaseEvent.long_running_tool_ids === ['tool-1']
// snakeCaseEvent.actions.state_delta === { 'user:score': 100 }
// snakeCaseEvent.actions.transfer_to_agent === 'next-agent'
```

### Preserved Keys

Certain nested objects preserve their original notation to avoid breaking user data:

#### Camel Case Preserved Keys

When converting TO camelCase, these paths remain unchanged:

```typescript
const PRESERVE_KEYS_SNAKE_CASE = [
  'actions.state_delta',                      // User state keys preserved
  'actions.artifact_delta',                   // Artifact filenames preserved
  'actions.requested_auth_configs',           // Auth config structure preserved
  'actions.requested_tool_confirmations',     // Confirmation payloads preserved
  'actions.custom_metadata',                  // Custom metadata preserved
  'content.parts.function_call.args',         // Function arguments preserved
  'content.parts.function_response.response', // Tool responses preserved
];
```

#### Snake Case Preserved Keys

When converting TO snake_case, these paths remain unchanged:

```typescript
const PRESERVE_KEYS_CAMEL_CASE = [
  'actions.stateDelta',
  'actions.artifactDelta',
  'actions.requestedAuthConfigs',
  'actions.requestedToolConfirmations',
  'actions.customMetadata',
  'content.parts.functionCall.args',
  'content.parts.functionResponse.response',
];
```

### Why Preserve Keys?

These fields contain user-defined data that may use any naming convention:

```typescript
// User's state uses their own keys
stateDelta: {
  'user:firstName': 'Alice',     // camelCase
  'app:api_endpoint': 'https://...', // snake_case
  'temp:CONSTANT_VALUE': 123     // UPPER_CASE
}

// Tool arguments use tool's schema
functionCall: {
  name: 'search_database',
  args: {
    search_query: 'example',     // Tool defines this
    maxResults: 10               // Mixed convention OK
  }
}
```

### Conversion Algorithm

```typescript
function toNotation(
  obj: unknown,
  converter: (key: string) => string,
  parentKey: string = '',
  preserveKeys: string[] = []
): unknown {
  if (Array.isArray(obj)) {
    return obj.map(item => toNotation(item, converter, parentKey, preserveKeys));
  }

  if (typeof obj === 'object' && obj !== null) {
    const source = obj as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(source)) {
      const convertedKey = converter(key);
      const fullPath = parentKey !== '' ? parentKey + '.' + key : key;

      if (preserveKeys.includes(fullPath)) {
        // Preserve this subtree
        result[convertedKey] = source[key];
      } else {
        // Recurse with conversion
        result[convertedKey] = toNotation(
          source[key],
          converter,
          fullPath,
          preserveKeys
        );
      }
    }

    return result;
  }

  return obj;
}
```

## Partial Events

Partial events represent incomplete streaming responses that should not be persisted.

### Characteristics

- `partial: true` - Marks event as incomplete
- Not saved to session history
- Used for streaming UI updates
- Final event has `partial: false` or `undefined`

### Streaming Flow

```typescript
for await (const event of runner.runAsync({
  userId: 'user-123',
  sessionId: 'session-abc',
  newMessage: userMessage
})) {
  if (event.partial) {
    // Update UI with partial content
    updateStreamingUI(event.content);
  } else {
    // Final event - saved to session
    displayFinalResponse(event.content);
  }
}
```

### Session Persistence

```typescript
// In BaseSessionService.appendEvent()
async appendEvent({session, event}: AppendEventRequest): Promise<Event> {
  if (event.partial) {
    return event;  // Skip persistence
  }

  // Only persist final events
  this.updateSessionState(session, event.actions);
  session.events.push(event);

  return event;
}
```

### Gemini Streaming Example

```typescript
// Streaming generates multiple partial events
async *generateContentAsync(llmRequest, stream = true) {
  const streamResult = await this.apiClient.models.generateContentStream({...});

  for await (const response of streamResult) {
    const llmResponse = createLlmResponse(response);
    llmResponse.partial = true;  // Mark as partial
    yield llmResponse;
  }

  // Final event is not partial
  yield {
    content: finalContent,
    partial: false  // or undefined
  };
}
```

## AgentEvent Types

`AgentEvent` is a discriminated union type for structured event streaming.

### Enum

```typescript
enum AgentEventType {
  THOUGHT = 'thought',
  CONTENT = 'content',
  TOOL_CALL = 'tool_call',
  TOOL_RESULT = 'tool_result',
  ERROR = 'error',
  ACTIVITY = 'activity',
  FINISHED = 'finished',
}
```

### Event Types

#### AgentThoughtEvent

Reasoning trace from the agent:

```typescript
interface AgentThoughtEvent {
  type: AgentEventType.THOUGHT;
  content: string;  // Thought text
}
```

**Example:**

```typescript
{
  type: 'thought',
  content: 'I need to search the database for user information...'
}
```

#### AgentContentEvent

Partial content delta for user-facing output:

```typescript
interface AgentContentEvent {
  type: AgentEventType.CONTENT;
  content: string;  // Text delta
}
```

**Example:**

```typescript
{
  type: 'content',
  content: 'Hello, '
}
```

#### AgentToolCallEvent

Tool execution request:

```typescript
interface AgentToolCallEvent {
  type: AgentEventType.TOOL_CALL;
  call: FunctionCall;  // From @google/genai
}
```

**Example:**

```typescript
{
  type: 'tool_call',
  call: {
    name: 'search_database',
    args: { query: 'user:123' }
  }
}
```

#### AgentToolResultEvent

Tool execution result:

```typescript
interface AgentToolResultEvent {
  type: AgentEventType.TOOL_RESULT;
  result: FunctionResponse;  // From @google/genai
}
```

**Example:**

```typescript
{
  type: 'tool_result',
  result: {
    name: 'search_database',
    response: { user: { name: 'Alice' } }
  }
}
```

#### AgentErrorEvent

Runtime error:

```typescript
interface AgentErrorEvent {
  type: AgentEventType.ERROR;
  error: Error;
}
```

**Example:**

```typescript
{
  type: 'error',
  error: new Error('Database connection failed')
}
```

#### AgentActivityEvent

Generic status update:

```typescript
interface AgentActivityEvent {
  type: AgentEventType.ACTIVITY;
  kind: string;                      // Activity category
  detail: Record<string, unknown>;   // Additional context
}
```

**Example:**

```typescript
{
  type: 'activity',
  kind: 'processing',
  detail: { stage: 'analysis', progress: 0.5 }
}
```

#### AgentFinishedEvent

Task completion:

```typescript
interface AgentFinishedEvent {
  type: AgentEventType.FINISHED;
  output: unknown;  // Final result
}
```

**Example:**

```typescript
{
  type: 'finished',
  output: { summary: '...', recommendations: [...] }
}
```

### Union Type

```typescript
type AgentEvent =
  | AgentThoughtEvent
  | AgentContentEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentErrorEvent
  | AgentActivityEvent
  | AgentFinishedEvent;
```

### Type Guards

```typescript
function isToolCall(event: AgentEvent): event is AgentToolCallEvent {
  return event.type === AgentEventType.TOOL_CALL;
}

for await (const event of stream) {
  if (isToolCall(event)) {
    console.log('Calling tool:', event.call.name);
  }
}
```

## mergeEventActions

Combines multiple `EventActions` objects into a single merged result.

### Signature

```typescript
function mergeEventActions(
  sources: Array<Partial<EventActions>>,
  target?: EventActions
): EventActions
```

### Merge Rules

1. **Dictionary fields** (stateDelta, artifactDelta, requestedAuthConfigs, requestedToolConfirmations):
   - Merged by adding all properties from each source
   - Later sources override earlier ones for same keys

2. **Scalar fields** (skipSummarization, transferToAgent, escalate):
   - Last non-undefined value wins

### Implementation

```typescript
function mergeEventActions(
  sources: Array<Partial<EventActions>>,
  target?: EventActions
): EventActions {
  const result = createEventActions();

  // Start with target if provided
  if (target) {
    Object.assign(result, target);
  }

  for (const source of sources) {
    if (!source) continue;

    // Merge dictionaries
    if (source.stateDelta) {
      Object.assign(result.stateDelta, source.stateDelta);
    }
    if (source.artifactDelta) {
      Object.assign(result.artifactDelta, source.artifactDelta);
    }
    if (source.requestedAuthConfigs) {
      Object.assign(result.requestedAuthConfigs, source.requestedAuthConfigs);
    }
    if (source.requestedToolConfirmations) {
      Object.assign(
        result.requestedToolConfirmations,
        source.requestedToolConfirmations
      );
    }

    // Last value wins for scalars
    if (source.skipSummarization !== undefined) {
      result.skipSummarization = source.skipSummarization;
    }
    if (source.transferToAgent !== undefined) {
      result.transferToAgent = source.transferToAgent;
    }
    if (source.escalate !== undefined) {
      result.escalate = source.escalate;
    }
  }

  return result;
}
```

### Usage Examples

#### Merging Tool Results

```typescript
const toolActions1 = createEventActions({
  stateDelta: { 'user:score': 100 }
});

const toolActions2 = createEventActions({
  stateDelta: { 'user:level': 5 },
  transferToAgent: 'next-agent'
});

const merged = mergeEventActions([toolActions1, toolActions2]);
// merged.stateDelta = { 'user:score': 100, 'user:level': 5 }
// merged.transferToAgent = 'next-agent'
```

#### Override Behavior

```typescript
const actions1 = createEventActions({
  stateDelta: { 'key': 'value1' },
  transferToAgent: 'agent1'
});

const actions2 = createEventActions({
  stateDelta: { 'key': 'value2' },  // Overrides key
  transferToAgent: 'agent2'         // Overrides transfer
});

const merged = mergeEventActions([actions1, actions2]);
// merged.stateDelta = { 'key': 'value2' }  // Last wins
// merged.transferToAgent = 'agent2'        // Last wins
```

#### Parallel Agent Merging

```typescript
// Three parallel agents produce actions
const researcherActions = createEventActions({
  stateDelta: { 'research_complete': true }
});

const analyzerActions = createEventActions({
  stateDelta: { 'analysis_score': 85 }
});

const writerActions = createEventActions({
  stateDelta: { 'draft_ready': true },
  escalate: true
});

const combined = mergeEventActions([
  researcherActions,
  analyzerActions,
  writerActions
]);
// combined.stateDelta = {
//   'research_complete': true,
//   'analysis_score': 85,
//   'draft_ready': true
// }
// combined.escalate = true
```

---

## Related Documentation

- [Sessions](./sessions.md) - Session storage and state management
- [Agents](./agents.md) - Agent execution and event generation
- [Tools](./tools.md) - Tool context and event actions
- [Runner](./runner.md) - Event streaming and lifecycle
