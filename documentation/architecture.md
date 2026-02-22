# Architecture

This document describes the modular architecture of ADK-JS, including module organization, class hierarchies, design patterns, and the context hierarchy system.

## Module Organization

ADK-JS follows a modular architecture with clear separation of concerns. Each module in the `core/src` directory handles a specific aspect of agent functionality:

```
core/src/
├── agents/          # Agent classes, orchestration, invocation context
├── tools/           # Tool system (FunctionTool, AgentTool, MCPTool)
├── models/          # LLM abstractions (Gemini, Apigee)
├── sessions/        # Session management and persistence
├── events/          # Event system and event sourcing
├── runner/          # Execution runners (Runner, InMemoryRunner)
├── plugins/         # Plugin system and lifecycle hooks
├── artifacts/       # Artifact storage services
├── memory/          # Long-term memory services
├── auth/            # Authentication and credential management
├── code_executors/  # Code execution capabilities
├── telemetry/       # OpenTelemetry integration
└── utils/           # Utility functions and helpers
```

## Class Hierarchies

### Agent Hierarchy

The agent system is built on a hierarchy with `BaseAgent` as the abstract root:

```
BaseAgent (abstract)
├── LlmAgent          # Language model-powered agent
├── LoopAgent         # Runs sub-agents in a loop
├── SequentialAgent   # Runs sub-agents sequentially (LoopAgent with maxIterations=1)
└── ParallelAgent     # Runs sub-agents concurrently
```

**Symbol-based Type Checking**: ADK-JS uses Symbol-based type guards instead of `instanceof` for runtime type checking. Each class defines a unique Symbol via `Symbol.for()` with a namespaced key (e.g., `Symbol.for('adk.BaseAgent')`). This approach:

- Works across different module instances and bundler boundaries
- Survives serialization/deserialization better than prototype chains
- Works correctly with duck typing patterns
- Creates global symbols that are consistent across the application

Example usage:

```typescript
import { isLlmAgent } from '@google/adk';

if (isLlmAgent(agent)) {
  // TypeScript knows agent is LlmAgent here
  const model = agent.canonicalModel;
}
```

### Tool Hierarchy

```
BaseTool (abstract)
├── FunctionTool              # Wraps a function as a tool
├── LongRunningFunctionTool   # For async operations
├── AgentTool                 # Wraps an agent as a tool
├── GoogleSearchTool          # Built-in Google Search
└── MCPTool                   # Model Context Protocol tool

BaseToolset (abstract)
└── MCPToolset                # Discovers tools from MCP servers
```

### Model Hierarchy

```
BaseLlm (abstract)
├── Gemini           # Google Gemini API / Vertex AI
└── ApigeeLlm        # Apigee API gateway proxy
```

**LLMRegistry**: A factory/registry pattern that maps model name patterns to `BaseLlm` implementations:

- Uses `Map<string | RegExp, BaseLlmType>` to store regex patterns to LLM classes
- Resolves model names to implementations via pattern matching
- Includes LRU cache (max size 32) to avoid duplicate instances
- Auto-registers Gemini and ApigeeLlm at module load

### Context Hierarchy

The context system provides progressive capability enhancement through three layers:

```
ReadonlyContext (base layer)
├── provides: session, state (read-only), service references
└── CallbackContext extends ReadonlyContext
    ├── adds: mutable state, artifact operations, eventActions
    └── ToolContext extends CallbackContext
        └── adds: requestCredential(), searchMemory(), functionCallId
```

**Layer Details**:

1. **ReadonlyContext**: Base layer providing read-only access to session data and services
2. **CallbackContext**: Adds mutable state via `eventActions.stateDelta` and artifact operations (`loadArtifact`, `saveArtifact`, `listArtifacts`)
3. **ToolContext**: Tool-specific capabilities including credential requests and memory search

This design ensures that different parts of the system receive only the capabilities they need, following the principle of least privilege.

## Design Patterns

ADK-JS employs several well-established design patterns to achieve modularity, extensibility, and maintainability:

### 1. Template Method Pattern

**Used in**: `BaseAgent.runAsync()`

The Template Method pattern defines the skeleton of an algorithm in a base class, letting subclasses override specific steps without changing the algorithm's structure.

```typescript
// BaseAgent defines the execution skeleton
abstract class BaseAgent {
  async *runAsync(context: InvocationContext): AsyncGenerator<Event> {
    // Template method defines the flow
    const callbackContext = new CallbackContext(/* ... */);

    // Hook 1: Before agent callback
    const beforeResponse = await this.runBeforeAgentCallback(callbackContext);
    if (beforeResponse) {
      yield createEvent({ content: beforeResponse });
      return;
    }

    // Hook 2: Run the agent-specific implementation
    yield* this.runAsyncImpl(callbackContext);

    // Hook 3: After agent callback
    const afterResponse = await this.runAfterAgentCallback(callbackContext);
    if (afterResponse) {
      yield createEvent({ content: afterResponse });
    }
  }

  // Abstract method - subclasses must implement
  protected abstract runAsyncImpl(
    context: CallbackContext
  ): AsyncGenerator<Event>;
}
```

### 2. Strategy Pattern

**Used in**: `BaseLlm` interface

The Strategy pattern allows algorithms to be selected at runtime. Different LLM implementations can be swapped without changing client code.

```typescript
// Strategy interface
abstract class BaseLlm {
  abstract generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean
  ): AsyncGenerator<LlmResponse, void>;
}

// Concrete strategies
class Gemini extends BaseLlm { /* ... */ }
class ApigeeLlm extends BaseLlm { /* ... */ }

// Usage - strategy selected at runtime
const agent = new LlmAgent({
  model: 'gemini-2.5-flash'  // or 'apigee/vertex_ai/gemini-2.5-flash'
});
```

### 3. Registry/Factory Pattern

**Used in**: `LLMRegistry`

The Registry pattern maintains a mapping of identifiers to implementations, enabling dynamic instantiation.

```typescript
class LLMRegistry {
  private static llmRegistryDict: Map<string | RegExp, BaseLlmType>;

  static register<T extends BaseLlm>(llmCls: BaseLlmType<T>) {
    for (const pattern of llmCls.supportedModels) {
      this.llmRegistryDict.set(pattern, llmCls);
    }
  }

  static newLlm(model: string): BaseLlm {
    const LlmClass = this.resolve(model);
    return new LlmClass({ model });
  }
}

// Auto-registration at module load
LLMRegistry.register(Gemini);
LLMRegistry.register(ApigeeLlm);
```

### 4. Chain of Responsibility / Pipeline Pattern

**Used in**: Request/Response processors in `LlmAgent`

Multiple processors handle a request sequentially, each with the opportunity to process or pass it along.

```typescript
// Request processors execute in order
const requestProcessors = [
  new BasicLlmRequestProcessor(),
  new IdentityLlmRequestProcessor(),
  new InstructionsLlmRequestProcessor(),
  new ContentRequestProcessor(),
  new RequestConfirmationLlmRequestProcessor(),
  new CodeExecutionRequestProcessor(),
  new AgentTransferLlmRequestProcessor()
];

// Each processor is an AsyncGenerator that yields its results
for (const processor of requestProcessors) {
  yield* processor.runAsync(llmRequest, callbackContext);
}
```

### 5. Observer / Hook Pattern

**Used in**: `BasePlugin` lifecycle hooks

The Observer pattern allows objects to subscribe to and receive notifications about events.

```typescript
class BasePlugin {
  async onUserMessageCallback({ userMessage, invocationContext }) {
    // Called when user sends a message
    return undefined; // or modified Content
  }

  async beforeRunCallback({ invocationContext }) {
    // Called before agent execution
    return undefined; // or early exit Content
  }

  async onEventCallback({ invocationContext, event }) {
    // Called for each event
    return undefined; // or modified Event
  }

  async afterRunCallback({ invocationContext }) {
    // Called after agent execution
  }
}
```

**Early-exit semantics**: If any plugin returns a non-`undefined` value, subsequent plugins are skipped and the returned value is used.

### 6. Composite Pattern

**Used in**: Multi-agent systems (SequentialAgent, ParallelAgent)

The Composite pattern allows treating individual agents and compositions of agents uniformly.

```typescript
// Leaf agents
const agent1 = new LlmAgent({ name: 'agent1', model: 'gemini-2.5-flash' });
const agent2 = new LlmAgent({ name: 'agent2', model: 'gemini-2.5-flash' });

// Composite agent - treated the same as leaf agents
const composite = new SequentialAgent({
  name: 'composite',
  subAgents: [agent1, agent2]
});

// Both work the same way
const runner1 = new InMemoryRunner({ agent: agent1 });
const runner2 = new InMemoryRunner({ agent: composite });
```

### 7. Builder Pattern

**Used in**: `createRunConfig()`, `createEvent()`, `createEventActions()`

The Builder pattern constructs complex objects step by step with sensible defaults.

```typescript
export function createRunConfig(params: Partial<RunConfig> = {}) {
  return {
    saveInputBlobsAsArtifacts: false,
    supportCfc: false,
    enableAffectiveDialog: false,
    streamingMode: StreamingMode.NONE,
    maxLlmCalls: validateMaxLlmCalls(params.maxLlmCalls || 500),
    pauseOnToolCalls: false,
    ...params,  // Override with user-provided values
  };
}
```

### 8. AsyncGenerator Pattern

**Used throughout**: Agent execution, LLM streaming, tool pipelines

AsyncGenerators enable memory-efficient streaming, backpressure support, and composable pipelines.

```typescript
// Agent execution returns AsyncGenerator
async *runAsync(context: InvocationContext): AsyncGenerator<Event> {
  // Yield events as they're produced
  yield createEvent({ author: 'model', content: { ... } });

  // Compose generators
  yield* this.subAgent.runAsync(context);
}

// Consumption with for-await-of
for await (const event of agent.runAsync(context)) {
  console.log(event);
}
```

**Benefits**:
- Memory efficient - events processed one at a time
- Backpressure support - consumer controls flow
- Composable - generators can yield from other generators
- Cancellable - `generator.return()` stops execution

### 9. Adapter Pattern

**Used in**: `MCPTool` wraps MCP protocol tools

The Adapter pattern converts the interface of a class into another interface clients expect.

```typescript
class MCPTool extends BaseTool {
  constructor(
    private mcpToolDef: MCPToolDefinition,
    private session: MCPSession
  ) {
    super();
  }

  async runAsync(args: Record<string, unknown>, context: ToolContext) {
    // Adapts MCP protocol to ADK tool interface
    const result = await this.session.callTool({
      name: this.mcpToolDef.name,
      arguments: args
    });
    return result;
  }
}
```

### 10. Delta / Event Sourcing Pattern

**Used in**: Session state management

Event sourcing persists state changes as a sequence of events rather than just the current state.

```typescript
class State {
  constructor(
    private value: Record<string, unknown>,  // Current committed state
    private delta: Record<string, unknown>   // Pending changes
  ) {}

  get<T>(key: string, defaultValue?: T): T {
    // Check delta first, then value
    if (key in this.delta) return this.delta[key] as T;
    if (key in this.value) return this.value[key] as T;
    return defaultValue!;
  }

  set(key: string, value: unknown): void {
    // Update both delta and value
    this.delta[key] = value;
    this.value[key] = value;
  }
}

class EventActions {
  stateDelta: Record<string, unknown> = {};
  artifactDelta: Record<string, Artifact> = {};
  transferToAgent?: string;
  escalate?: boolean;
  // ...
}
```

**Flow**:
1. `CallbackContext` wraps `State` with `eventActions.stateDelta`
2. Tools/callbacks modify state via `context.state.set(key, value)`
3. Events carry `stateDelta` to session
4. `BaseSessionService.appendEvent()` applies `stateDelta` to `session.state`

**Benefits**:
- Atomic state updates per event
- Full audit trail
- Rollback capability
- Artifact versioning

## InvocationContext

The `InvocationContext` is the central context object for an agent invocation, carrying all necessary references and state throughout the execution lifecycle.

### Structure

```typescript
class InvocationContext {
  // Service references
  readonly artifactService?: BaseArtifactService;
  readonly sessionService?: BaseSessionService;
  readonly memoryService?: BaseMemoryService;
  readonly credentialService?: BaseCredentialService;

  // Current execution state
  readonly invocationId: string;      // Unique ID for this invocation
  agent: BaseAgent;                   // Current agent (can change during transfer)
  readonly session: Session;          // Current session
  readonly userContent?: Content;     // Original user message
  branch?: string;                    // Agent hierarchy path (e.g., "agent1.agent2")

  // Runtime configuration
  runConfig?: RunConfig;
  pluginManager: PluginManager;

  // Cost tracking
  private invocationCostManager: InvocationCostManager;

  // Live/streaming support
  liveRequestQueue?: LiveRequestQueue;
  activeStreamingTools?: Record<string, ActiveStreamingTool>;
  transcriptionCache?: TranscriptionEntry[];

  // Control flow
  endInvocation: boolean;             // Set to true to terminate invocation

  // Methods
  incrementLlmCallCount(): void;      // Tracks and enforces maxLlmCalls limit
}
```

### InvocationCostManager

Tracks the cost of invocation (primarily LLM calls) and enforces limits:

```typescript
class InvocationCostManager {
  private numberOfLlmCalls: number = 0;

  incrementAndEnforceLlmCallsLimit(runConfig?: RunConfig) {
    this.numberOfLlmCalls++;

    if (runConfig?.maxLlmCalls > 0 &&
        this.numberOfLlmCalls > runConfig.maxLlmCalls) {
      throw new Error(
        `Max number of llm calls limit of ${runConfig.maxLlmCalls} exceeded`
      );
    }
  }
}
```

### Invocation Lifecycle

An **invocation**:
1. Starts with a user message and ends with a final response
2. Can contain one or multiple agent calls
3. Is handled by `runner.runAsync()`
4. Runs an agent until it does not request to transfer to another agent

An **agent call**:
1. Is handled by `agent.runAsync()`
2. Ends when `agent.runAsync()` ends

An **LLM agent call**:
1. Can contain one or multiple steps
2. Runs steps in a loop until:
   - A final response is generated
   - The agent transfers to another agent
   - `endInvocation` is set to `true`

A **step**:
1. Calls the LLM only once and yields its response
2. Calls tools if requested and yields their responses
3. Ends when done calling LLM and tools, or if `endInvocation` is set

```
┌─────────────────────── invocation ──────────────────────────┐
┌──────────── llm_agent_call_1 ────────────┐ ┌─ agent_call_2 ─┐
┌──── step_1 ────────┐ ┌───── step_2 ──────┐
[call_llm] [call_tool] [call_llm] [transfer]
```

## State Management

ADK-JS uses a three-tier state prefix system:

### State Prefixes

| Prefix | Scope | Persistence | Use Case |
|--------|-------|-------------|----------|
| `app:` | Application-wide | Persisted | Shared across all users |
| `user:` | User-scoped | Persisted | User-specific preferences |
| `temp:` | Temporary | Not persisted | Session-only data |

```typescript
class State {
  static readonly APP_PREFIX = 'app:';
  static readonly USER_PREFIX = 'user:';
  static readonly TEMP_PREFIX = 'temp:';

  get<T>(key: string, defaultValue?: T): T {
    // Checks delta first, then value
  }

  set(key: string, value: unknown): void {
    // Updates both delta and value
  }
}

// Usage
context.state.set('user:preferences', { theme: 'dark' });
context.state.set('temp:cache', computedData);  // Not persisted
```

### State Persistence

`BaseSessionService.updateSessionState()` applies deltas to session state, skipping keys with `temp:` prefix:

```typescript
protected updateSessionState(
  session: Session,
  eventActions: EventActions
): void {
  for (const [key, value] of Object.entries(eventActions.stateDelta)) {
    if (key.startsWith(State.TEMP_PREFIX)) {
      continue;  // Skip temporary state
    }
    session.state[key] = value;
  }
}
```

## Summary

ADK-JS's architecture is designed for:

- **Modularity**: Clear separation of concerns across modules
- **Extensibility**: Plugin system and design patterns support customization
- **Type Safety**: TypeScript with Symbol-based type guards
- **Streaming**: AsyncGenerator pattern throughout
- **State Management**: Event sourcing with delta-based updates
- **Composability**: Agents, tools, and processors compose cleanly

For more details on specific components:
- **[Agents](./agents.md)**: Agent types and configuration
- **[Runner](./runner.md)**: Execution lifecycle
- **[Tools](./tools.md)**: Tool system
- **[Models](./models.md)**: LLM abstractions
- **[Sessions](./sessions.md)**: Session management
- **[Events](./events.md)**: Event system
- **[Plugins](./plugins.md)**: Plugin lifecycle hooks
