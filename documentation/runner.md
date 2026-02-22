# Runner

This document covers the Runner execution system in ADK-JS, including the complete execution lifecycle, InMemoryRunner, RunConfig options, session resumption, streaming modes, plugin callbacks, and LLM call limits.

## Runner Overview

The `Runner` class orchestrates agent execution, managing the complete lifecycle from session lookup through plugin callbacks, user message appending, agent execution, event persistence, and cleanup.

### Runner Configuration

```typescript
interface RunnerConfig {
  appName: string;                        // Application name (required)
  agent: BaseAgent;                       // Root agent to run (required)
  plugins?: BasePlugin[];                 // Optional plugins
  artifactService?: BaseArtifactService;  // Artifact storage
  sessionService: BaseSessionService;     // Session management (required)
  memoryService?: BaseMemoryService;      // Long-term memory
  credentialService?: BaseCredentialService; // Credential handling
}

const runner = new Runner({
  appName: 'my_app',
  agent: myAgent,
  sessionService: new InMemorySessionService(),
  plugins: [myPlugin]
});
```

## Complete Execution Lifecycle

The `runAsync()` method implements the complete execution lifecycle:

### Lifecycle Steps

```typescript
async *runAsync(params: {
  userId: string;
  sessionId: string;
  newMessage: Content;
  stateDelta?: Record<string, unknown>;
  runConfig?: RunConfig;
}): AsyncGenerator<Event, void, undefined>
```

**Complete Flow**:

1. **Setup**: Create OpenTelemetry span and context
2. **Session Lookup**: Retrieve session via `sessionService.getSession()`
   - Throws error if session not found
3. **CFC Validation**: If `runConfig.supportCfc` is enabled:
   - Validates model is Gemini 2.0+
   - Sets up `BuiltInCodeExecutor` if needed
4. **Create InvocationContext**: Initialize with all services and configuration
5. **Plugin: onUserMessageCallback**: Allow plugins to modify user message
   - Early-exit if plugin returns modified content
6. **Artifact Saving**: If `runConfig.saveInputBlobsAsArtifacts`:
   - Extract inline data from message parts
   - Save as artifacts with names like `artifact_{invocationId}_{index}`
   - Replace inline data with text placeholders
7. **Append User Message**: Save to session via `sessionService.appendEvent()`
   - Include `stateDelta` if provided
8. **Determine Agent**: Call `determineAgentForResumption()` to select which agent handles the request
9. **Plugin: beforeRunCallback**: Allow plugins to short-circuit execution
   - If returns `Content`, yield early-exit event and return
10. **Agent Execution**: Run `agent.runAsync(invocationContext)`
    - For each event from agent:
      - If not partial, append to session
      - Run `onEventCallback` plugin
      - Yield event (possibly modified by plugin)
11. **Plugin: afterRunCallback**: Post-execution cleanup and logging
12. **Cleanup**: End OpenTelemetry span

### Code Example

```typescript
import { Runner } from '@google/adk';
import { InMemorySessionService } from '@google/adk';

const runner = new Runner({
  appName: 'my_app',
  agent: myAgent,
  sessionService: new InMemorySessionService()
});

// Create session
const session = await runner.sessionService.createSession({
  appName: runner.appName,
  userId: 'user1',
  sessionId: 'session1'
});

// Run agent
for await (const event of runner.runAsync({
  userId: 'user1',
  sessionId: session.id,
  newMessage: {
    role: 'user',
    parts: [{ text: 'Hello!' }]
  },
  stateDelta: { 'user:name': 'Alice' }  // Optional state update
})) {
  console.log('Event:', event);
}
```

## Session Resumption

The `determineAgentForResumption()` method selects which agent should handle session resumption based on session history.

### Three Cases

**Case 1: Function Response Matching**

If the last event contains a function response, returns the agent that made the original function call.

```typescript
// Find event with functionResponse in last event
const event = findEventByLastFunctionResponseId(session.events);
if (event && event.author) {
  return rootAgent.findAgent(event.author) || rootAgent;
}
```

**Case 2: Last Agent with Transfer Ability**

Find the last agent that emitted a message and is transferable (routable) across the agent tree.

```typescript
// Iterate events in reverse order
for (let i = session.events.length - 1; i >= 0; i--) {
  const event = session.events[i];
  if (event.author === 'user' || !event.author) continue;

  if (event.author === rootAgent.name) {
    return rootAgent;
  }

  const agent = rootAgent.findSubAgent(event.author);
  if (agent && this.isRoutableLlmAgent(agent)) {
    return agent;
  }
}
```

**Case 3: Default to Root**

If no matching agent found, default to root agent.

```typescript
return rootAgent;
```

### isRoutableLlmAgent

An agent is routable if:
- It is an instance of `LlmAgent`
- All its ancestors have `disallowTransferToParent` set to `false`

```typescript
private isRoutableLlmAgent(agentToRun: BaseAgent): boolean {
  let agent: BaseAgent | undefined = agentToRun;
  while (agent) {
    if (!isLlmAgent(agent)) {
      return false;
    }
    if (agent.disallowTransferToParent) {
      return false;
    }
    agent = agent.parentAgent;
  }
  return true;
}
```

### findEventByLastFunctionResponseId

Utility function that finds the event containing a function call matching the last function response:

```typescript
function findEventByLastFunctionResponseId(events: Event[]): Event | null {
  if (!events.length) return null;

  const lastEvent = events[events.length - 1];
  const functionCallId = lastEvent.content?.parts?.find(
    (part) => part.functionResponse
  )?.functionResponse?.id;

  if (!functionCallId) return null;

  // Search backwards for matching function call
  for (let i = events.length - 2; i >= 0; i--) {
    const event = events[i];
    const functionCalls = getFunctionCalls(event);
    if (!functionCalls) continue;

    for (const functionCall of functionCalls) {
      if (functionCall.id === functionCallId) {
        return event;
      }
    }
  }
  return null;
}
```

## InMemoryRunner

`InMemoryRunner` is a convenience class that automatically wires in-memory services.

### Implementation

```typescript
export class InMemoryRunner extends Runner {
  constructor({
    agent,
    appName = 'InMemoryRunner',
    plugins = [],
  }: {
    agent: BaseAgent;
    appName?: string;
    plugins?: BasePlugin[];
  }) {
    super({
      appName,
      agent,
      plugins,
      artifactService: new InMemoryArtifactService(),
      sessionService: new InMemorySessionService(),
      memoryService: new InMemoryMemoryService(),
    });
  }
}
```

### Differences from Runner

| Feature | Runner | InMemoryRunner |
|---------|--------|----------------|
| SessionService | Must provide | Auto-wired with `InMemorySessionService` |
| ArtifactService | Optional | Auto-wired with `InMemoryArtifactService` |
| MemoryService | Optional | Auto-wired with `InMemoryMemoryService` |
| Default appName | Required | Defaults to `'InMemoryRunner'` |

### Usage

```typescript
import { InMemoryRunner, LlmAgent } from '@google/adk';

const agent = new LlmAgent({
  name: 'simple_agent',
  model: 'gemini-2.5-flash'
});

// Simplest setup
const runner = new InMemoryRunner({ agent });

// With custom app name and plugins
const runner2 = new InMemoryRunner({
  agent,
  appName: 'my_app',
  plugins: [loggingPlugin]
});
```

**Note**: `InMemoryRunner` is ideal for development, testing, and simple applications. For production with persistent storage, use `Runner` with custom service implementations.

## RunConfig Options

`RunConfig` controls runtime behavior of agent execution.

### Complete Configuration

```typescript
interface RunConfig {
  // Streaming
  streamingMode?: StreamingMode;          // NONE, SSE, or BIDI
  supportCfc?: boolean;                   // Compositional Function Calling (experimental)

  // Artifacts
  saveInputBlobsAsArtifacts?: boolean;    // Save user input blobs as artifacts

  // Cost control
  maxLlmCalls?: number;                   // Limit on total LLM calls (default: 500)

  // Tool execution
  pauseOnToolCalls?: boolean;             // Suspend on ANY tool call for client-side execution

  // Audio/Live features
  speechConfig?: SpeechConfig;            // Speech configuration for live agents
  responseModalities?: Modality[];        // Output modalities (e.g., AUDIO)
  outputAudioTranscription?: AudioTranscriptionConfig;
  inputAudioTranscription?: AudioTranscriptionConfig;
  enableAffectiveDialog?: boolean;        // Emotion detection and adaptation
  proactivity?: ProactivityConfig;        // Proactive response configuration
  realtimeInputConfig?: RealtimeInputConfig;
}
```

### Configuration Table

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `streamingMode` | `StreamingMode` | `NONE` | Streaming mode: NONE, SSE, or BIDI |
| `supportCfc` | `boolean` | `false` | Enable Compositional Function Calling (requires Gemini 2.0+, experimental) |
| `saveInputBlobsAsArtifacts` | `boolean` | `false` | Save user input blobs as artifacts |
| `maxLlmCalls` | `number` | `500` | Max LLM calls per run (≤0 means unbounded) |
| `pauseOnToolCalls` | `boolean` | `false` | Pause agent loop on ANY tool call |
| `speechConfig` | `SpeechConfig` | - | Speech configuration for live agents |
| `responseModalities` | `Modality[]` | - | Output modalities (defaults to AUDIO if not set) |
| `outputAudioTranscription` | `AudioTranscriptionConfig` | - | Output audio transcription config |
| `inputAudioTranscription` | `AudioTranscriptionConfig` | - | Input audio transcription config |
| `enableAffectiveDialog` | `boolean` | `false` | Enable emotion detection |
| `proactivity` | `ProactivityConfig` | - | Proactive response configuration |
| `realtimeInputConfig` | `RealtimeInputConfig` | - | Realtime input config for live agents |

### StreamingMode Enum

```typescript
enum StreamingMode {
  NONE = 'none',   // No streaming, wait for complete response
  SSE = 'sse',     // Server-Sent Events (unidirectional)
  BIDI = 'bidi'    // Bidirectional streaming
}
```

### createRunConfig Factory

```typescript
function createRunConfig(params: Partial<RunConfig> = {}): RunConfig {
  return {
    saveInputBlobsAsArtifacts: false,
    supportCfc: false,
    enableAffectiveDialog: false,
    streamingMode: StreamingMode.NONE,
    maxLlmCalls: validateMaxLlmCalls(params.maxLlmCalls || 500),
    pauseOnToolCalls: false,
    ...params,
  };
}
```

### Example Usage

```typescript
import { StreamingMode } from '@google/adk';

// SSE streaming with file upload handling
for await (const event of runner.runAsync({
  userId: 'user1',
  sessionId: session.id,
  newMessage: userMessage,
  runConfig: {
    streamingMode: StreamingMode.SSE,
    saveInputBlobsAsArtifacts: true,
    maxLlmCalls: 100
  }
})) {
  console.log(event);
}

// Client-side tool execution
for await (const event of runner.runAsync({
  userId: 'user1',
  sessionId: session.id,
  newMessage: userMessage,
  runConfig: {
    pauseOnToolCalls: true  // Agent pauses when tools are about to be called
  }
})) {
  // Inspect tool calls, execute client-side, resume agent
  console.log(event);
}
```

## Artifact Saving from User Input

The `saveInputBlobsAsArtifacts` option enables automatic artifact storage for user-uploaded files.

### How It Works

```typescript
private async saveArtifacts(
  invocationId: string,
  userId: string,
  sessionId: string,
  message: Content
): Promise<void> {
  if (!this.artifactService || !message.parts?.length) {
    return;
  }

  for (let i = 0; i < message.parts.length; i++) {
    const part = message.parts[i];
    if (!part.inlineData) continue;

    // Generate artifact filename
    const fileName = `artifact_${invocationId}_${i}`;

    // Save to artifact service
    await this.artifactService.saveArtifact({
      appName: this.appName,
      userId,
      sessionId,
      filename: fileName,
      artifact: part
    });

    // Replace inline data with text placeholder
    message.parts[i] = createPartFromText(
      `Uploaded file: ${fileName}. It is saved into artifacts`
    );
  }
}
```

### Example

```typescript
import { InMemoryRunner } from '@google/adk';

// User uploads an image
const userMessage = {
  role: 'user',
  parts: [
    { text: 'Analyze this image' },
    {
      inlineData: {
        mimeType: 'image/png',
        data: base64ImageData
      }
    }
  ]
};

// Run with artifact saving enabled
for await (const event of runner.runAsync({
  userId: 'user1',
  sessionId: session.id,
  newMessage: userMessage,
  runConfig: {
    saveInputBlobsAsArtifacts: true
  }
})) {
  console.log(event);
}

// The message is transformed to:
// parts: [
//   { text: 'Analyze this image' },
//   { text: 'Uploaded file: artifact_e-abc123_1. It is saved into artifacts' }
// ]
// And the artifact is saved with filename: artifact_e-abc123_1
```

## LLM Call Limits

The `InvocationCostManager` tracks and enforces LLM call limits via `maxLlmCalls`.

### InvocationCostManager

```typescript
class InvocationCostManager {
  private numberOfLlmCalls: number = 0;

  incrementAndEnforceLlmCallsLimit(runConfig?: RunConfig) {
    this.numberOfLlmCalls++;

    if (
      runConfig &&
      runConfig.maxLlmCalls! > 0 &&
      this.numberOfLlmCalls > runConfig.maxLlmCalls!
    ) {
      throw new Error(
        `Max number of llm calls limit of ${runConfig.maxLlmCalls!} exceeded`
      );
    }
  }
}
```

### Usage in InvocationContext

```typescript
class InvocationContext {
  private readonly invocationCostManager = new InvocationCostManager();

  incrementLlmCallCount() {
    this.invocationCostManager.incrementAndEnforceLlmCallsLimit(this.runConfig);
  }
}

// Called before each LLM call
context.incrementLlmCallCount();
```

### What Happens When Limit Exceeded

When `numberOfLlmCalls > maxLlmCalls`, an error is thrown:

```
Error: Max number of llm calls limit of 500 exceeded
```

This prevents infinite loops and runaway costs in agent systems.

### maxLlmCalls Values

| Value | Behavior |
|-------|----------|
| `> 0` | Enforces limit (default: 500) |
| `<= 0` | Unbounded (no limit enforced, logs warning) |

### Example

```typescript
// Limit to 10 LLM calls
for await (const event of runner.runAsync({
  userId: 'user1',
  sessionId: session.id,
  newMessage: userMessage,
  runConfig: {
    maxLlmCalls: 10
  }
})) {
  console.log(event);
}

// Unbounded (use with caution)
for await (const event of runner.runAsync({
  userId: 'user1',
  sessionId: session.id,
  newMessage: userMessage,
  runConfig: {
    maxLlmCalls: -1  // Logs warning, no enforcement
  }
})) {
  console.log(event);
}
```

## SSE Streaming

When `streamingMode` is `StreamingMode.SSE`, the Runner yields partial events as they're produced.

### How SSE Streaming Works

1. **Partial Events**: Events with `event.partial = true` are yielded but **not persisted** to session
2. **Final Events**: When streaming completes, final event with `event.partial = false` (or undefined) is yielded and persisted
3. **Text Accumulation**: Partial text responses are accumulated until final response

### Session Persistence Logic

```typescript
// In Runner.runAsync()
for await (const event of invocationContext.agent.runAsync(invocationContext)) {
  if (!event.partial) {
    // Only persist non-partial events
    await this.sessionService.appendEvent({ session, event });
  }

  // Yield all events (partial and final)
  const modifiedEvent = await this.pluginManager.runOnEventCallback({
    invocationContext,
    event
  });
  yield modifiedEvent || event;
}
```

### Example

```typescript
import { StreamingMode } from '@google/adk';

for await (const event of runner.runAsync({
  userId: 'user1',
  sessionId: session.id,
  newMessage: { role: 'user', parts: [{ text: 'Tell me a story' }] },
  runConfig: {
    streamingMode: StreamingMode.SSE
  }
})) {
  if (event.partial) {
    // Partial response - displayed to user but not saved
    process.stdout.write(event.content?.parts?.[0]?.text || '');
  } else {
    // Final response - saved to session
    console.log('\n[Final response saved]');
  }
}
```

**Use Case**: SSE streaming is ideal for real-time user interfaces where you want to display responses as they're generated without persisting intermediate states.

## Plugin Callback Flow

Plugins provide lifecycle hooks throughout the execution flow with early-exit semantics.

### Complete Plugin Callback Sequence

```
1. runOnUserMessageCallback
   ↓
2. runBeforeRunCallback
   ↓ (if no early exit)
3. agent.runAsync() starts
   ↓
4. For each event:
   - runBeforeAgentCallback (agent level)
   - runBeforeModelCallback (model level)
   - runBeforeToolCallback (tool level)
   - runOnEventCallback (event level)
   - runAfterToolCallback (tool level)
   - runAfterModelCallback (model level)
   - runAfterAgentCallback (agent level)
   ↓
5. runAfterRunCallback
```

### 1. onUserMessageCallback

Called when user sends a message, before appending to session.

```typescript
async onUserMessageCallback({
  userMessage,
  invocationContext
}: {
  userMessage: Content;
  invocationContext: InvocationContext;
}): Promise<Content | undefined>
```

**Early-exit**: If returns `Content`, that content replaces the user message.

**Example**: Input validation or transformation

```typescript
class ValidationPlugin extends BasePlugin {
  async onUserMessageCallback({ userMessage, invocationContext }) {
    const text = userMessage.parts?.[0]?.text;
    if (text && containsProfanity(text)) {
      // Replace with filtered message
      return {
        role: 'user',
        parts: [{ text: '[Message filtered]' }]
      };
    }
    return undefined;  // Continue with original message
  }
}
```

### 2. beforeRunCallback

Called before agent execution starts.

```typescript
async beforeRunCallback({
  invocationContext
}: {
  invocationContext: InvocationContext;
}): Promise<Content | undefined>
```

**Early-exit**: If returns `Content`, agent execution is skipped and that content is returned.

**Example**: Rate limiting or caching

```typescript
class RateLimitPlugin extends BasePlugin {
  async beforeRunCallback({ invocationContext }) {
    const userId = invocationContext.userId;
    if (isRateLimited(userId)) {
      // Skip agent execution, return error
      return {
        role: 'model',
        parts: [{ text: 'Rate limit exceeded. Please try again later.' }]
      };
    }
    return undefined;  // Continue to agent execution
  }
}
```

### 3. onEventCallback

Called for each event generated by the agent.

```typescript
async onEventCallback({
  invocationContext,
  event
}: {
  invocationContext: InvocationContext;
  event: Event;
}): Promise<Event | undefined>
```

**Early-exit**: If returns `Event`, that event replaces the original.

**Example**: Logging or event transformation

```typescript
class LoggingPlugin extends BasePlugin {
  async onEventCallback({ invocationContext, event }) {
    console.log(`[${event.author}] ${event.content?.parts?.[0]?.text}`);
    return undefined;  // Don't modify event
  }
}
```

### 4. afterRunCallback

Called after agent execution completes.

```typescript
async afterRunCallback({
  invocationContext
}: {
  invocationContext: InvocationContext;
}): Promise<void>
```

**Example**: Cleanup or analytics

```typescript
class AnalyticsPlugin extends BasePlugin {
  async afterRunCallback({ invocationContext }) {
    trackEvent({
      userId: invocationContext.userId,
      sessionId: invocationContext.session.id,
      invocationId: invocationContext.invocationId,
      eventCount: invocationContext.session.events.length
    });
  }
}
```

### Execution Order and Early-Exit Semantics

**For each callback type**:
1. Plugin callbacks execute in registration order
2. If any plugin returns non-`undefined`, subsequent plugins are skipped
3. The returned value is used instead of the original

**Example**:

```typescript
const runner = new Runner({
  appName: 'my_app',
  agent: myAgent,
  sessionService: sessionService,
  plugins: [plugin1, plugin2, plugin3]
});

// beforeRunCallback execution:
// 1. plugin1.beforeRunCallback() -> undefined (continue)
// 2. plugin2.beforeRunCallback() -> Content (early exit, plugin3 skipped)
// 3. Returned Content used instead of agent execution
```

### Plugin Manager Implementation

```typescript
class PluginManager {
  private async runCallbacks(
    plugins: Set<BasePlugin>,
    callback: (plugin: BasePlugin) => Promise<unknown>,
    callbackName: string
  ): Promise<unknown> {
    for (const plugin of plugins) {
      const result = await callback(plugin);
      if (result !== undefined) {
        logger.debug(
          `Plugin '${plugin.name}' returned a value for callback '${callbackName}', exiting early.`
        );
        return result;  // Early exit
      }
    }
    return undefined;
  }
}
```

## pauseOnToolCalls

The `pauseOnToolCalls` option enables client-side tool execution by suspending the agent loop on ANY tool call.

### How It Works

When `pauseOnToolCalls: true`:
1. Agent execution pauses before tools are called
2. Control yields to client with event containing tool calls
3. Client can:
   - Inspect tool calls
   - Modify arguments
   - Execute tools client-side
   - Provide results back to resume agent

### Difference from Long-Running Tools

| Feature | pauseOnToolCalls | Long-Running Tools |
|---------|------------------|--------------------|
| Scope | ALL tools | Specific tools marked `isLongRunning: true` |
| Control | Client decides execution | Tool executes asynchronously |
| Use Case | Client-side execution, inspection | Background jobs, async operations |

### Example

```typescript
for await (const event of runner.runAsync({
  userId: 'user1',
  sessionId: session.id,
  newMessage: userMessage,
  runConfig: {
    pauseOnToolCalls: true
  }
})) {
  // Check if event contains tool calls
  const functionCalls = getFunctionCalls(event);
  if (functionCalls) {
    console.log('Agent wants to call tools:', functionCalls);

    // Client can decide what to do:
    // - Execute tools client-side
    // - Modify arguments
    // - Reject certain calls
    // - Log for audit

    // Provide results to resume agent...
  }

  yield event;
}
```

**Use Cases**:
- Security: Review tool calls before execution
- Audit: Log all tool executions
- Client-side execution: Execute tools in browser/client environment
- Testing: Intercept and mock tool calls

## Summary

The Runner provides:

- **Complete Lifecycle Management**: Session lookup → plugin callbacks → agent execution → event persistence
- **Session Resumption**: Intelligent agent selection based on conversation history
- **InMemoryRunner**: Convenient setup for development and testing
- **Rich Configuration**: Streaming modes, artifact handling, cost controls, tool execution options
- **Artifact Handling**: Automatic file upload storage and placeholder replacement
- **Cost Controls**: LLM call limits with `InvocationCostManager`
- **SSE Streaming**: Real-time partial events without session persistence
- **Plugin Hooks**: Four lifecycle callbacks with early-exit semantics
- **Client-Side Tool Execution**: `pauseOnToolCalls` for full control

For related documentation:
- **[Architecture](./architecture.md)**: Design patterns and module organization
- **[Agents](./agents.md)**: Agent configuration and orchestration
- **[Sessions](./sessions.md)**: Session management and state
- **[Events](./events.md)**: Event system and event sourcing
- **[Plugins](./plugins.md)**: Creating custom plugins
- **[Tools](./tools.md)**: Tool system and custom tools
