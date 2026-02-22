# Agents

This document covers the agent system in ADK-JS, including agent types, configuration options, agent orchestration patterns, agent transfer, callbacks, instructions, and naming rules.

## Agent Hierarchy

All agents extend from `BaseAgent`, which provides the common interface and lifecycle management:

```
BaseAgent (abstract)
├── LlmAgent          # Language model-powered agent
├── LoopAgent         # Runs sub-agents in a loop until maxIterations or escalate
├── SequentialAgent   # Runs sub-agents sequentially (LoopAgent with maxIterations=1)
└── ParallelAgent     # Runs sub-agents concurrently with isolated branches
```

### Symbol-based Type Checking

ADK-JS uses Symbol-based type guards instead of `instanceof` for runtime type checking. Each class defines a unique Symbol via `Symbol.for()` with a namespaced key.

**Why Symbols over instanceof?**
- Works across different module instances and bundler boundaries
- Survives serialization/deserialization better than prototype chains
- Works correctly with duck typing patterns
- Creates global symbols that are consistent across the application

```typescript
import { isLlmAgent, isLoopAgent } from '@google/adk';

function processAgent(agent: BaseAgent) {
  if (isLlmAgent(agent)) {
    // TypeScript knows agent is LlmAgent here
    const model = agent.canonicalModel;
  }

  if (isLoopAgent(agent)) {
    // TypeScript knows agent is LoopAgent here
    const maxIterations = agent.maxIterations;
  }
}
```

## LlmAgent

`LlmAgent` is the primary agent type that uses a language model to process user input and generate responses.

### Configuration Options

```typescript
interface LlmAgentConfig extends BaseAgentConfig {
  // Core settings
  name: string;                                    // Agent identifier (required)
  description?: string;                            // Human-readable description
  model: string | BaseLlm;                         // LLM to use (e.g., 'gemini-2.5-flash')

  // Instructions
  instruction?: string | InstructionProvider;      // Agent behavior guidance
  globalInstruction?: string | InstructionProvider; // Applies to entire agent tree

  // Tools
  tools?: ToolUnion[];                             // Array of tools available to agent

  // Model configuration
  generateContentConfig?: GenerateContentConfig;   // Temperature, topK, topP, etc.

  // Input/Output control
  includeContents?: 'default' | 'none';            // Conversation history mode
  inputSchema?: Schema;                            // JSON schema for input validation
  outputSchema?: Schema;                           // JSON schema for output validation
  outputKey?: string;                              // State key to store output

  // Agent transfer control
  disallowTransferToParent?: boolean;              // Prevent transfer to parent agent
  disallowTransferToPeers?: boolean;               // Prevent transfer to peer agents

  // Callbacks
  beforeModelCallback?: SingleAgentCallback | SingleAgentCallback[];
  afterModelCallback?: SingleAgentCallback | SingleAgentCallback[];

  // Request/Response processing
  requestProcessors?: BaseLlmRequestProcessor[];
  responseProcessors?: BaseLlmResponseProcessor[];

  // Code execution
  codeExecutor?: BaseCodeExecutor;                 // For executing generated code
}
```

### Complete Configuration Table

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | Required | Agent identifier (must be valid identifier, cannot be 'user') |
| `description` | `string` | - | Human-readable description |
| `model` | `string \| BaseLlm` | Required | LLM model name or instance |
| `instruction` | `string \| InstructionProvider` | - | Agent behavior guidance |
| `globalInstruction` | `string \| InstructionProvider` | - | Applies to entire agent tree (only root's used) |
| `tools` | `ToolUnion[]` | `[]` | Tools available to agent |
| `generateContentConfig` | `GenerateContentConfig` | - | Model parameters (temperature, etc.) |
| `includeContents` | `'default' \| 'none'` | `'default'` | Controls conversation history sent to model |
| `inputSchema` | `Schema` | - | JSON schema for input validation |
| `outputSchema` | `Schema` | - | JSON schema for output validation |
| `outputKey` | `string` | - | State key where output is stored |
| `disallowTransferToParent` | `boolean` | `false` | Prevents transfer to parent agent and replying to end-user |
| `disallowTransferToPeers` | `boolean` | `false` | Prevents transfer to peer agents |
| `beforeModelCallback` | `SingleAgentCallback \| SingleAgentCallback[]` | - | Runs before LLM call |
| `afterModelCallback` | `SingleAgentCallback \| SingleAgentCallback[]` | - | Runs after LLM call |
| `requestProcessors` | `BaseLlmRequestProcessor[]` | Default pipeline | Custom request processors |
| `responseProcessors` | `BaseLlmResponseProcessor[]` | Default pipeline | Custom response processors |
| `codeExecutor` | `BaseCodeExecutor` | - | Executor for generated code |

### Basic Example

```typescript
import { LlmAgent, FunctionTool } from '@google/adk';
import { z } from 'zod';

const weatherTool = new FunctionTool({
  name: 'get_weather',
  description: 'Get current weather',
  parameters: z.object({
    location: z.string()
  }),
  execute: async ({ location }) => {
    return { temperature: 72, condition: 'sunny' };
  }
});

const agent = new LlmAgent({
  name: 'weather_assistant',
  description: 'Helps with weather queries',
  model: 'gemini-2.5-flash',
  instruction: 'You are a helpful weather assistant. Use the get_weather tool when needed.',
  tools: [weatherTool],
  generateContentConfig: {
    temperature: 0.7,
    topP: 0.95,
    maxOutputTokens: 1024
  }
});
```

## Agent Transfer

Agent transfer allows control to move between agents in a multi-agent system using the built-in `transfer_to_agent` FunctionTool.

### How Transfer Works

1. **Tool Definition**: Built-in `FunctionTool` with name `'transfer_to_agent'` and parameter `agentName`
2. **Transfer Targets**: `getTransferTargets()` returns available agents based on disallow flags
3. **Execution**: `transferToAgent()` validates target and sets `event.actions.transferToAgent`
4. **Routing**: `Runner.determineAgentForResumption()` uses this to find the next agent

### Transfer Control Flags

```typescript
const restrictedAgent = new LlmAgent({
  name: 'restricted_agent',
  model: 'gemini-2.5-flash',
  disallowTransferToParent: true,  // Cannot transfer to parent or reply to user
  disallowTransferToPeers: true    // Cannot transfer to peer agents
});
```

**Important**: Setting `disallowTransferToParent: true` also prevents the agent from replying to the end-user.

### Example: Multi-Agent Transfer

```typescript
import { LlmAgent, SequentialAgent, InMemoryRunner } from '@google/adk';

const researcher = new LlmAgent({
  name: 'researcher',
  model: 'gemini-2.5-flash',
  instruction: 'Research topics thoroughly. Transfer to writer when done.'
});

const writer = new LlmAgent({
  name: 'writer',
  model: 'gemini-2.5-flash',
  instruction: 'Write polished content based on research.'
});

const coordinator = new LlmAgent({
  name: 'coordinator',
  model: 'gemini-2.5-flash',
  instruction: 'Coordinate between researcher and writer.',
  subAgents: [researcher, writer]
});

// The LLM can use transfer_to_agent tool to switch between agents
// Example: transfer_to_agent(agentName: "writer")
```

## LoopAgent

`LoopAgent` runs sub-agents sequentially in a loop until `maxIterations` is reached or an `escalate` action occurs.

### Configuration

```typescript
interface LoopAgentConfig extends BaseAgentConfig {
  name: string;
  description?: string;
  subAgents: BaseAgent[];
  maxIterations?: number;  // Default: Number.MAX_SAFE_INTEGER
}
```

### Behavior

1. For each iteration < `maxIterations`:
   - Runs each sub-agent in sequence
   - Checks `event.actions.escalate` after each agent
   - If `escalate` is true, exits immediately
2. The `escalate` pattern allows sub-agents to signal early termination

### Example

```typescript
import { LoopAgent, LlmAgent } from '@google/adk';

const validator = new LlmAgent({
  name: 'validator',
  model: 'gemini-2.5-flash',
  instruction: 'Validate the solution. Set escalate if valid.'
});

const solver = new LlmAgent({
  name: 'solver',
  model: 'gemini-2.5-flash',
  instruction: 'Generate a solution to the problem.'
});

const loopAgent = new LoopAgent({
  name: 'problem_solver',
  description: 'Iteratively solve and validate',
  subAgents: [solver, validator],
  maxIterations: 5  // Max 5 attempts
});
```

## SequentialAgent

`SequentialAgent` runs sub-agents sequentially (exactly once). It's implemented as a `LoopAgent` with `maxIterations=1`.

### Example

```typescript
import { SequentialAgent, LlmAgent } from '@google/adk';

const step1 = new LlmAgent({
  name: 'step1',
  model: 'gemini-2.5-flash',
  instruction: 'Process step 1'
});

const step2 = new LlmAgent({
  name: 'step2',
  model: 'gemini-2.5-flash',
  instruction: 'Process step 2'
});

const pipeline = new SequentialAgent({
  name: 'pipeline',
  description: 'Execute steps in sequence',
  subAgents: [step1, step2]
});
```

## ParallelAgent

`ParallelAgent` runs sub-agents concurrently with isolated branches and merges their output.

### Implementation

1. **Branch Creation**: `createBranchCtxForSubAgent()` creates isolated `InvocationContext` for each sub-agent
2. **Concurrent Execution**: Maps each sub-agent to `subAgent.runAsync(branchContext)`
3. **Event Merging**: `mergeAgentRuns()` uses `Promise.race` pattern to yield events from whichever generator produces next

### Example

```typescript
import { ParallelAgent, LlmAgent } from '@google/adk';

const analyst1 = new LlmAgent({
  name: 'analyst1',
  model: 'gemini-2.5-flash',
  instruction: 'Analyze from perspective 1'
});

const analyst2 = new LlmAgent({
  name: 'analyst2',
  model: 'gemini-2.5-flash',
  instruction: 'Analyze from perspective 2'
});

const parallelAnalysis = new ParallelAgent({
  name: 'parallel_analysis',
  description: 'Run multiple analyses concurrently',
  subAgents: [analyst1, analyst2]
});
```

**Note**: Events from different sub-agents are interleaved as they're produced, maintaining per-agent ordering but not global ordering.

## Agent Naming Rules

Agent names must follow strict validation rules enforced by `validateAgentName()`:

### Rules

1. **Valid Identifier**: Must start with letter or underscore, contain letters, digits, underscores, hyphens
   - Validated via regex: `/^[\p{ID_Start}$_][\p{ID_Continue}$_-]*$/u`
2. **Reserved Names**: Cannot be `'user'` (reserved for end-user input)

### Examples

```typescript
// Valid names
new LlmAgent({ name: 'my_agent', model: 'gemini-2.5-flash' });
new LlmAgent({ name: 'agent-1', model: 'gemini-2.5-flash' });
new LlmAgent({ name: '_helper', model: 'gemini-2.5-flash' });

// Invalid names
new LlmAgent({ name: 'user', model: 'gemini-2.5-flash' });  // Reserved
new LlmAgent({ name: '123agent', model: 'gemini-2.5-flash' });  // Starts with digit
```

## Agent Callbacks

Callbacks provide hooks into the agent execution lifecycle with early-exit semantics.

### Callback Types

```typescript
type SingleAgentCallback = (context: CallbackContext) => Promise<Content | undefined>;
```

### beforeAgentCallback

Runs before `runAsyncImpl()`. If returns `Content`, agent execution is skipped.

```typescript
const agent = new LlmAgent({
  name: 'cached_agent',
  model: 'gemini-2.5-flash',
  beforeAgentCallback: async (context) => {
    // Check cache before running agent
    const cached = context.state.get('temp:cache');
    if (cached) {
      return { role: 'model', parts: [{ text: cached }] };
    }
    return undefined;  // Continue to agent
  }
});
```

### afterAgentCallback

Runs after `runAsyncImpl()`. If returns `Content`, replaces agent response.

```typescript
const agent = new LlmAgent({
  name: 'filtered_agent',
  model: 'gemini-2.5-flash',
  afterAgentCallback: async (context) => {
    // Filter or modify response
    const response = context.state.get('temp:last_response');
    if (containsProfanity(response)) {
      return { role: 'model', parts: [{ text: '[Content filtered]' }] };
    }
    return undefined;  // Use original response
  }
});
```

### Array Behavior

Callbacks can be arrays. They execute in order until one returns non-`undefined`.

```typescript
const agent = new LlmAgent({
  name: 'multi_callback',
  model: 'gemini-2.5-flash',
  beforeAgentCallback: [
    async (ctx) => checkCache(ctx),
    async (ctx) => checkRateLimit(ctx),
    async (ctx) => checkAuth(ctx)
  ]
});
```

### Execution Order

1. Plugin callbacks run first
2. If plugin returns non-`undefined`, agent callbacks are skipped
3. Otherwise, agent callbacks run in order

## Instruction System

Instructions guide agent behavior and can be static strings or dynamic functions.

### String Instructions

Support template syntax with `{key}` placeholders that inject session state values:

```typescript
const agent = new LlmAgent({
  name: 'personalized_agent',
  model: 'gemini-2.5-flash',
  instruction: 'You are a helpful assistant for {user:name}. ' +
               'Your task is to {app:current_task}. ' +
               'Optional context: {temp:context?}'
});
```

**Template Features**:
- `{key}`: Inject state value (throws if missing)
- `{key?}`: Optional key (empty string if missing)
- `{app:key}`: Application-wide state
- `{user:key}`: User-scoped state
- `{temp:key}`: Temporary state
- `{artifact.filename}`: Inject artifact content

### InstructionProvider Functions

Dynamic instructions computed at runtime:

```typescript
type InstructionProvider = (context: ReadonlyContext) => string | Promise<string>;

const agent = new LlmAgent({
  name: 'dynamic_agent',
  model: 'gemini-2.5-flash',
  instruction: async (context) => {
    const timeOfDay = new Date().getHours();
    const greeting = timeOfDay < 12 ? 'Good morning' : 'Good afternoon';
    const userName = context.state.get('user:name', 'there');
    return `${greeting}, ${userName}! How can I help you today?`;
  }
});
```

### instruction vs globalInstruction

- `instruction`: Applies to specific agent
- `globalInstruction`: Applies to entire agent tree (only root agent's `globalInstruction` is used)

```typescript
const rootAgent = new LlmAgent({
  name: 'root',
  model: 'gemini-2.5-flash',
  globalInstruction: 'Always be polite and professional.',  // Applies to all agents
  instruction: 'You coordinate tasks.'
});

const subAgent = new LlmAgent({
  name: 'sub',
  model: 'gemini-2.5-flash',
  globalInstruction: 'This is ignored',  // Only root's globalInstruction is used
  instruction: 'You handle specific tasks.'
});
```

## Output Configuration

### outputKey and outputSchema

Store agent output in session state for use by other agents or tools:

```typescript
const agent = new LlmAgent({
  name: 'data_extractor',
  model: 'gemini-2.5-flash',
  instruction: 'Extract structured data from the input.',
  outputKey: 'extracted_data',  // State key where output is stored
  outputSchema: z.object({      // Optional JSON schema validation
    name: z.string(),
    age: z.number(),
    email: z.string().email()
  }).schema
});

// Later, another agent can access the data
const processorAgent = new LlmAgent({
  name: 'processor',
  model: 'gemini-2.5-flash',
  instruction: 'Process the data: {extracted_data}'
});
```

**How it works**:
1. `maybeSaveOutputToState()` checks for `outputKey`
2. Waits for final response (not partial)
3. Extracts text from response
4. If `outputSchema` is set, parses as JSON and validates
5. Stores in `event.actions.stateDelta[outputKey]`
6. `BaseSessionService.appendEvent()` applies delta to `session.state`

**Important**: When `outputSchema` is set, tools and agent transfers are disabled for that agent.

## Model Inheritance

Child agents can inherit the LLM from ancestor agents via the `canonicalModel` getter.

### Inheritance Logic

```typescript
get canonicalModel(): BaseLlm {
  // 1. Check if this.model is BaseLlm instance
  if (this.model is BaseLlm) {
    return this.model;
  }

  // 2. Check if this.model is non-empty string
  if (this.model is string && not empty) {
    return LLMRegistry.newLlm(this.model);
  }

  // 3. Traverse parent chain
  let ancestorAgent = this.parentAgent;
  while (ancestorAgent exists) {
    if (isLlmAgent(ancestorAgent)) {
      return ancestorAgent.canonicalModel;
    }
    ancestorAgent = ancestorAgent.parentAgent;
  }

  // 4. No model found - throw error
  throw Error('No model specified');
}
```

**LRU Cache**: `LLMRegistry.newLlm()` uses an LRU cache to avoid creating duplicate instances of the same model.

### Example

```typescript
const rootAgent = new LlmAgent({
  name: 'root',
  model: 'gemini-2.5-flash'  // Specified here
});

const childAgent = new LlmAgent({
  name: 'child',
  // No model specified - inherits from parent
});

rootAgent.subAgents = [childAgent];
// childAgent.canonicalModel returns rootAgent's Gemini instance
```

## includeContents Option

Controls what conversation history is sent to the model.

### Options

| Value | Behavior | Use Case |
|-------|----------|----------|
| `'default'` | Calls `getContents()` for full conversation history | Multi-turn dialogue with state tracking |
| `'none'` | Calls `getCurrentTurnContents()` for current turn only | Stateless operations, single-shot tasks, privacy/context isolation |

### Example

```typescript
// Agent with full conversation history (default)
const chatAgent = new LlmAgent({
  name: 'chat_agent',
  model: 'gemini-2.5-flash',
  includeContents: 'default'  // Can omit, this is default
});

// Agent without conversation history
const functionAgent = new LlmAgent({
  name: 'function_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Execute the requested function.',
  includeContents: 'none'  // Only sees current turn
});
```

**Token Usage**: Setting `includeContents: 'none'` significantly reduces token usage and context window utilization, but the agent loses awareness of previous conversation turns.

## Request/Response Processors

LLM request and response processors form a pipeline that pre/post-processes LLM calls.

### Default Request Processor Pipeline

```typescript
const defaultRequestProcessors = [
  new BasicLlmRequestProcessor(),
  new IdentityLlmRequestProcessor(),
  new InstructionsLlmRequestProcessor(),
  new ContentRequestProcessor(),
  new RequestConfirmationLlmRequestProcessor(),
  new CodeExecutionRequestProcessor(),
  new AgentTransferLlmRequestProcessor()
];
```

These run sequentially before the LLM call, each as an `AsyncGenerator`.

### Custom Processors

You can override with custom processors:

```typescript
class CustomRequestProcessor extends BaseLlmRequestProcessor {
  async *runAsync(
    llmRequest: LlmRequest,
    context: CallbackContext
  ): AsyncGenerator<Event> {
    // Custom pre-processing logic
    llmRequest.appendInstructions('Custom instruction');
    yield* this.next?.runAsync(llmRequest, context) ?? [];
  }
}

const agent = new LlmAgent({
  name: 'custom_agent',
  model: 'gemini-2.5-flash',
  requestProcessors: [
    new CustomRequestProcessor(),
    ...defaultRequestProcessors
  ]
});
```

## Summary

ADK-JS agents provide:

- **Flexible Configuration**: Rich options for behavior, tools, I/O control
- **Orchestration Patterns**: Sequential, parallel, and loop-based execution
- **Agent Transfer**: Dynamic routing between agents
- **Lifecycle Hooks**: beforeAgent/afterAgent callbacks with early-exit semantics
- **Dynamic Instructions**: Template syntax and provider functions
- **State Management**: outputKey/outputSchema for structured data flow
- **Model Inheritance**: Efficient model sharing across agent hierarchies
- **Pipeline Customization**: Request/response processor extensibility

For related documentation:
- **[Architecture](./architecture.md)**: Design patterns and module organization
- **[Runner](./runner.md)**: Execution lifecycle and runtime configuration
- **[Tools](./tools.md)**: Creating and using tools
- **[Sessions](./sessions.md)**: Session and state management
