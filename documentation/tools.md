# Tools

Tools extend agent capabilities by enabling them to perform actions, access external data, and interact with APIs. ADK-JS provides a flexible tool system with multiple implementations and integration patterns.

## Table of Contents

- [BaseTool](#basetool)
- [FunctionTool](#functiontool)
- [AgentTool](#agenttool)
- [GoogleSearchTool](#googlesearchtool)
- [MCP Integration](#mcp-integration)
- [BaseToolset](#basetoolset)
- [ToolContext](#toolcontext)
- [Tool Callbacks](#tool-callbacks)
- [Tool Confirmation](#tool-confirmation)
- [Long-Running Tools](#long-running-tools)
- [PauseOnToolCalls](#pauseontoolcalls)

## BaseTool

The abstract base class for all tools in ADK-JS. All tool implementations extend `BaseTool`.

### Core Properties

```typescript
abstract class BaseTool {
  readonly name: string;
  readonly description: string;
  readonly isLongRunning: boolean;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Unique identifier for the tool |
| `description` | `string` | Human-readable description used in LLM prompts |
| `isLongRunning` | `boolean` | Whether the tool executes asynchronously (default: `false`) |

### Core Methods

#### `runAsync(request: RunAsyncToolRequest): Promise<unknown>`

Executes the tool with given arguments and context.

```typescript
interface RunAsyncToolRequest {
  args: Record<string, unknown>;
  toolContext: ToolContext;
}
```

#### `processLlmRequest(request: ToolProcessLlmRequest): Promise<void>`

Preprocesses the LLM request before it's sent. Default implementation adds the tool's function declaration to the request.

```typescript
interface ToolProcessLlmRequest {
  toolContext: ToolContext;
  llmRequest: LlmRequest;
}
```

#### `_getDeclaration(): FunctionDeclaration | undefined`

Returns the OpenAPI-compatible function declaration for this tool. Required for tools that need to be added to LLM requests.

### Type Guard

Use the type guard to check if an object is a `BaseTool`:

```typescript
import { isBaseTool } from '@google/adk';

if (isBaseTool(obj)) {
  // obj is BaseTool
}
```

BaseTool uses Symbol-based type checking via `Symbol.for('google.adk.baseTool')` for cross-module compatibility.

## FunctionTool

`FunctionTool` wraps a TypeScript function as a tool, with optional Zod schema validation for parameters.

### Basic Usage

```typescript
import { FunctionTool } from '@google/adk';

const weatherTool = new FunctionTool({
  description: 'Get current weather for a location',
  execute: async (location: string) => {
    // Fetch weather data
    return { temp: 72, condition: 'sunny' };
  }
});
```

### With Zod v3 Schema Validation

```typescript
import { FunctionTool } from '@google/adk';
import { z } from 'zod/v3';

const calculateTool = new FunctionTool({
  name: 'calculate',
  description: 'Perform mathematical calculations',
  parameters: z.object({
    expression: z.string().describe('Mathematical expression to evaluate'),
    precision: z.number().optional().describe('Decimal places for result')
  }),
  execute: async ({ expression, precision }) => {
    // Zod automatically validates and types the input
    const result = eval(expression);
    return precision ? result.toFixed(precision) : result;
  }
});
```

### With Zod v4 Schema

```typescript
import { z } from 'zod/v4';

const searchTool = new FunctionTool({
  description: 'Search for documents',
  parameters: z.object({
    query: z.string(),
    limit: z.number().default(10)
  }),
  execute: async ({ query, limit }, toolContext) => {
    // Access session state via toolContext
    const userId = toolContext.state.get('userId');
    return await searchDatabase(query, limit, userId);
  }
});
```

### Configuration Options

```typescript
type ToolOptions<TParameters extends ToolInputParameters> = {
  name?: string;              // Auto-derived from function name if not provided
  description: string;        // Required
  parameters?: TParameters;   // ZodObject (v3/v4), Schema, or undefined
  execute: ToolExecuteFunction<TParameters>;
  isLongRunning?: boolean;    // Set to true for async operations
};
```

### Parameter Types

FunctionTool supports three parameter types:

```typescript
type ToolInputParameters =
  | z3.ZodObject<z3.ZodRawShape>  // Zod v3
  | z4.ZodObject<z4.ZodRawShape>  // Zod v4
  | Schema                        // JSON Schema
  | undefined;                    // No parameters or plain string
```

When using Zod schemas, the execute function receives typed, validated arguments:

```typescript
// With Zod schema - automatic type inference
execute: async ({ field1, field2 }) => {
  // field1 and field2 are typed based on your schema
}

// Without schema - receives string
execute: async (input: string) => {
  // input is plain string
}
```

### Accessing ToolContext

The second parameter of `execute` provides access to session state, artifacts, and more:

```typescript
execute: async (args, toolContext) => {
  // Access state
  const value = toolContext.state.get('key');

  // Save artifacts
  await toolContext.saveArtifact('output.json', data);

  // Request authentication
  toolContext.requestCredential(authConfig);

  return result;
}
```

### Type Guard

```typescript
import { isFunctionTool } from '@google/adk';

if (isFunctionTool(obj)) {
  // obj is FunctionTool
}
```

## AgentTool

`AgentTool` wraps an entire agent as a tool, allowing hierarchical agent composition.

### Basic Usage

```typescript
import { AgentTool, LlmAgent } from '@google/adk';

const researchAgent = new LlmAgent({
  name: 'researcher',
  model: 'gemini-2.5-flash',
  instruction: 'Research the given topic thoroughly'
});

const researchTool = new AgentTool({
  agent: researchAgent,
  skipSummarization: false
});

// Use in parent agent
const mainAgent = new LlmAgent({
  name: 'main',
  model: 'gemini-2.5-flash',
  tools: [researchTool]
});
```

### Configuration

```typescript
interface AgentToolConfig {
  agent: BaseAgent;           // The agent to wrap
  skipSummarization?: boolean; // Prevent model from summarizing output
}
```

### Input/Output Schemas

AgentTool automatically generates tool parameters based on the wrapped agent's configuration:

- **With `inputSchema`**: Uses the agent's input schema as tool parameters
- **Without `inputSchema`**: Creates default schema with single `request` string parameter
- **With `outputSchema`**: Returns structured JSON object
- **Without `outputSchema`**: Returns plain text string

```typescript
const structuredAgent = new LlmAgent({
  name: 'analyzer',
  model: 'gemini-2.5-flash',
  inputSchema: {
    type: Type.OBJECT,
    properties: {
      data: { type: Type.STRING },
      format: { type: Type.STRING }
    },
    required: ['data']
  },
  outputSchema: {
    type: Type.OBJECT,
    properties: {
      summary: { type: Type.STRING },
      insights: { type: Type.ARRAY }
    }
  }
});

const analyzerTool = new AgentTool({ agent: structuredAgent });
// LLM will call with: { data: "...", format: "..." }
// Returns: { summary: "...", insights: [...] }
```

### Execution Flow

When an AgentTool executes:

1. Creates temporary `Runner` with `ForwardingArtifactService` to share artifacts with parent
2. Creates in-memory session initialized with parent's state
3. Runs sub-agent with user's message
4. Forwards `stateDelta` updates back to parent's `ToolContext`
5. Returns final response (text or JSON based on outputSchema)

### State Propagation

```typescript
execute: async ({ args, toolContext }) => {
  // Sub-agent starts with parent's state
  const session = await runner.sessionService.createSession({
    appName: this.agent.name,
    userId: 'tmp_user',
    state: toolContext.state.toRecord()  // Parent state copied
  });

  for await (const event of runner.runAsync(...)) {
    if (event.actions.stateDelta) {
      // Changes propagated back to parent
      toolContext.state.update(event.actions.stateDelta);
    }
  }
}
```

### Type Guard

```typescript
import { isAgentTool } from '@google/adk';

if (isAgentTool(obj)) {
  // obj is AgentTool
}
```

## GoogleSearchTool

Built-in tool for Gemini models that retrieves Google Search results. This is a server-side tool that executes within the model, not locally.

### Usage

```typescript
import { GOOGLE_SEARCH } from '@google/adk';

const agent = new LlmAgent({
  name: 'search_agent',
  model: 'gemini-2.5-flash',
  tools: [GOOGLE_SEARCH]
});
```

### Model Compatibility

- **Gemini 1.x**: Uses `googleSearchRetrieval` config (cannot be combined with other tools)
- **Gemini 2.x**: Uses `googleSearch` config (can be combined with other tools)

```typescript
// Gemini 1.x
llmRequest.config.tools.push({
  googleSearchRetrieval: {}
});

// Gemini 2.x
llmRequest.config.tools.push({
  googleSearch: {}
});
```

### Implementation Details

Unlike `FunctionTool`, `GoogleSearchTool`:

- Has no local execution (`runAsync()` returns `Promise.resolve()`)
- Adds tool config directly to `llmRequest.config.tools` in `processLlmRequest()`
- Throws error if used with unsupported models

## MCP Integration

Model Context Protocol (MCP) integration enables agents to use tools from external MCP-compliant servers.

### MCPToolset

Dynamically discovers and provides tools from an MCP server.

```typescript
import { MCPToolset } from '@google/adk';
import { StdioConnectionParams } from '@google/adk';

// Stdio connection (Node.js process)
const toolset = new MCPToolset({
  type: 'StdioConnectionParams',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
});

// HTTP connection
const httpToolset = new MCPToolset({
  type: 'StreamableHTTPConnectionParams',
  url: 'http://localhost:8788/mcp'
});

// Get tools
const tools = await toolset.getTools();

// Use with agent
const agent = new LlmAgent({
  name: 'mcp_agent',
  model: 'gemini-2.5-flash',
  tools: tools
});
```

### Connection Types

```typescript
type MCPConnectionParams =
  | StdioConnectionParams
  | StreamableHTTPConnectionParams;

interface StdioConnectionParams {
  type: 'StdioConnectionParams';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface StreamableHTTPConnectionParams {
  type: 'StreamableHTTPConnectionParams';
  url: string;
}
```

### Tool Filtering

Filter which MCP tools to expose:

```typescript
// Filter by name array
const toolset = new MCPToolset(
  connectionParams,
  ['read_file', 'write_file']  // Only these tools
);

// Filter by predicate
const toolset = new MCPToolset(
  connectionParams,
  (tool, context) => tool.name.startsWith('file_')
);
```

### MCPTool

Individual tool wrapper that translates MCP tool schemas to Gemini format:

```typescript
class MCPTool extends BaseTool {
  _getDeclaration(): FunctionDeclaration {
    return {
      name: this.mcpTool.name,
      description: this.mcpTool.description,
      parameters: toGeminiSchema(this.mcpTool.inputSchema),
      response: toGeminiSchema(this.mcpTool.outputSchema)
    };
  }

  async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const session = await this.mcpSessionManager.createSession();
    return await session.callTool({
      name: this.mcpTool.name,
      arguments: request.args
    });
  }
}
```

### Session Management

`MCPSessionManager` manages MCP client sessions using `@modelcontextprotocol/sdk`:

- Creates and reuses sessions per connection
- Handles stdio and HTTP transports
- Sends `callTool` requests to MCP server
- Returns results to ADK runtime

## BaseToolset

Abstract base class for creating dynamic tool collections.

### Interface

```typescript
abstract class BaseToolset {
  constructor(readonly toolFilter: ToolPredicate | string[]);

  abstract getTools(context?: ReadonlyContext): Promise<BaseTool[]>;
  abstract close(): Promise<void>;

  protected isToolSelected(tool: BaseTool, context: ReadonlyContext): boolean;
  async processLlmRequest(toolContext: ToolContext, llmRequest: LlmRequest): Promise<void>;
}
```

### Tool Filtering

```typescript
type ToolPredicate = (tool: BaseTool, context: ReadonlyContext) => boolean;

// Array of names
const toolset = new MyToolset(['tool1', 'tool2']);

// Predicate function
const toolset = new MyToolset((tool, context) => {
  const userRole = context.state.get('role');
  return tool.name.startsWith('admin_') ? userRole === 'admin' : true;
});
```

### Custom Implementation

```typescript
class CustomToolset extends BaseToolset {
  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    // Discover tools dynamically
    const allTools = await discoverTools();

    // Apply filter
    return allTools.filter(tool =>
      this.isToolSelected(tool, context)
    );
  }

  async close(): Promise<void> {
    // Cleanup resources
  }
}
```

### Lifecycle

The `close()` method is called when the toolset is no longer needed:

- End of agent server lifecycle
- Runner cleanup
- Release connections, files, and resources

## ToolContext

`ToolContext` extends `CallbackContext` and provides tools with access to the invocation environment.

### Hierarchy

```
ReadonlyContext
  └─ CallbackContext
       └─ ToolContext
```

### Properties

```typescript
class ToolContext extends CallbackContext {
  readonly functionCallId?: string;      // Maps responses to calls
  toolConfirmation?: ToolConfirmation;   // Confirmation state

  get actions(): EventActions;           // Alias for eventActions
}
```

### Methods

#### State Access

Inherited from `CallbackContext`:

```typescript
// Read state
const value = toolContext.state.get<string>('user:name');

// Update state (affects current event's stateDelta)
toolContext.state.set('result', { status: 'complete' });
```

#### Artifact Operations

```typescript
// Save artifact
await toolContext.saveArtifact('report.pdf', pdfBuffer);

// Load artifact
const data = await toolContext.loadArtifact('data.json');

// List artifacts
const filenames = await toolContext.listArtifacts();
```

#### Memory Search

```typescript
const results = await toolContext.searchMemory('relevant context');
// Returns SearchMemoryResponse with matching memories
```

#### Authentication

```typescript
// Request credentials
toolContext.requestCredential({
  type: 'oauth2',
  provider: 'google',
  scopes: ['drive.readonly']
});

// Get auth response (after user provides credentials)
const credential = toolContext.getAuthResponse(authConfig);
if (credential) {
  // Use credential.token
}
```

#### Tool Confirmation

```typescript
toolContext.requestConfirmation({
  hint: 'About to delete all files. Are you sure?',
  payload: { fileCount: 42 }
});
// Execution pauses until user confirms
```

### Function Call ID

The `functionCallId` maps tool responses to the original function call:

```typescript
if (!toolContext.functionCallId) {
  throw new Error('functionCallId is required for this operation');
}

// Store result keyed by call ID
toolContext.actions.requestedAuthConfigs[toolContext.functionCallId] = authConfig;
```

## Tool Callbacks

Intercept and modify tool execution with `beforeToolCallback` and `afterToolCallback`.

### Configuration

```typescript
const agent = new LlmAgent({
  name: 'agent',
  model: 'gemini-2.5-flash',
  beforeToolCallback: async (toolContext, toolName, args) => {
    console.log(`Calling tool: ${toolName}`);
    // Return non-null to skip tool execution and use this result
    return null;
  },
  afterToolCallback: async (toolContext, toolName, result) => {
    console.log(`Tool ${toolName} returned:`, result);
    // Return non-null to replace tool result
    return null;
  }
});
```

### Execution Flow

```
1. Plugin beforeToolCallback (first priority)
   ├─ Returns non-null? → Use result, skip rest
   └─ Returns null? → Continue

2. Agent canonical beforeToolCallbacks array
   ├─ Iterate in order
   ├─ First non-null return → Use result, skip rest
   └─ All return null? → Continue

3. tool.runAsync() - Execute actual tool

4. Plugin afterToolCallback (first priority)
   ├─ Returns non-null? → Replace result, skip rest
   └─ Returns null? → Continue

5. Agent canonical afterToolCallbacks array
   ├─ Iterate in order
   └─ First non-null return → Replace result
```

### Early-Exit Semantics

Any callback returning a non-null value short-circuits the rest of the chain:

```typescript
beforeToolCallback: async (toolContext, toolName, args) => {
  if (toolName === 'dangerous_operation') {
    // Override - tool never executes
    return { error: 'Operation not allowed' };
  }
  return null; // Continue to tool execution
}
```

### Multiple Callbacks

Use arrays for multiple callbacks:

```typescript
const agent = new LlmAgent({
  beforeToolCallback: [
    async (ctx, name, args) => {
      // Logging
      console.log(`Tool: ${name}`);
      return null;
    },
    async (ctx, name, args) => {
      // Authorization check
      if (!hasPermission(name)) {
        return { error: 'Unauthorized' };
      }
      return null;
    }
  ]
});
```

## Tool Confirmation

Allow tools to request user confirmation before execution.

### Requesting Confirmation

```typescript
const deleteTool = new FunctionTool({
  description: 'Delete files',
  parameters: z.object({
    paths: z.array(z.string())
  }),
  execute: async ({ paths }, toolContext) => {
    // Request confirmation
    toolContext.requestConfirmation({
      hint: `Delete ${paths.length} files?`,
      payload: { paths }
    });

    // If confirmed, this code continues
    // If not confirmed, execution pauses
    return deleteFiles(paths);
  }
});
```

### Confirmation Object

```typescript
class ToolConfirmation {
  hint?: string;        // User-facing confirmation message
  confirmed: boolean;   // Initially false
  payload?: unknown;    // Additional context for UI
}
```

### Execution Flow

```
1. Tool calls requestConfirmation()
   └─ Creates ToolConfirmation with confirmed=false

2. Stored in eventActions.requestedToolConfirmations[functionCallId]

3. generateRequestConfirmationEvent() creates special function call
   └─ name: 'adk_request_confirmation'
   └─ args: { originalFunctionCall, toolConfirmation }

4. RequestConfirmationLlmRequestProcessor handles round-trip
   ├─ Prompts user for confirmation
   └─ Updates toolConfirmation.confirmed = true

5. Original tool execution resumes with confirmed=true
```

### Checking Confirmation

```typescript
execute: async (args, toolContext) => {
  if (toolContext.toolConfirmation?.confirmed) {
    // User confirmed - proceed
    return performDangerousOperation();
  } else {
    // Not confirmed - should not reach here
    // (confirmation flow ensures this)
  }
}
```

## Long-Running Tools

Tools that execute asynchronously and may return results later.

### LongRunningFunctionTool

```typescript
import { LongRunningFunctionTool } from '@google/adk';

const longTask = new LongRunningFunctionTool({
  description: 'Start background processing job',
  execute: async (jobConfig) => {
    // Start async job
    startBackgroundJob(jobConfig);
    // Don't wait for completion
    return null;
  }
});
```

### Behavior Differences

| Property | Regular Tool | Long-Running Tool |
|----------|--------------|-------------------|
| `isLongRunning` | `false` | `true` |
| Description suffix | None | Appends note about async behavior |
| Loop behavior | Waits for response | Continues if returns null |
| Event tracking | Standard | `longRunningToolIds` array |

### Implementation

```typescript
class LongRunningFunctionTool extends FunctionTool {
  constructor(options: ToolOptions) {
    super({
      ...options,
      isLongRunning: true,  // Automatically set
      description: options.description + '\n[Long-running tool note]'
    });
  }
}
```

### Execution Flow

```
1. Tool executes and returns null
   └─ No immediate response event created

2. functionCallId added to longRunningToolIds Set

3. Agent loop continues without waiting

4. Event includes longRunningToolIds: ['id1', 'id2']

5. Client tracks long-running calls
   └─ Can poll or wait for completion notification
```

### Use Cases

- File uploads/downloads
- External API calls with callbacks
- Database migrations
- Report generation
- Batch processing

## PauseOnToolCalls

Enable client-side tool execution by pausing agent loop on any tool call.

### Configuration

```typescript
import { Runner } from '@google/adk';

const runner = new Runner({
  agent: myAgent,
  // ... other config
});

for await (const event of runner.runAsync({
  userId: 'user1',
  sessionId: 'session1',
  newMessage: userMessage,
  runConfig: {
    pauseOnToolCalls: true  // Enable pausing
  }
})) {
  // Handle events
}
```

### Behavior

When `pauseOnToolCalls: true`:

1. Agent execution pauses whenever tools are about to be called
2. Control yields to client with event containing tool calls
3. Client can:
   - Inspect tool call details
   - Modify arguments
   - Execute tools client-side
   - Provide custom results
   - Cancel execution

### Example Usage

```typescript
for await (const event of runner.runAsync({
  userId: 'user1',
  sessionId: 'session1',
  newMessage: { role: 'user', parts: [{ text: 'Use the calculator' }] },
  runConfig: { pauseOnToolCalls: true }
})) {
  const functionCalls = getFunctionCalls(event);

  if (functionCalls.length > 0) {
    // Client-side execution
    for (const call of functionCalls) {
      console.log(`Paused on: ${call.name}`, call.args);

      // Execute client-side
      const result = executeLocally(call.name, call.args);

      // Resume with result
      await runner.runAsync({
        userId: 'user1',
        sessionId: 'session1',
        newMessage: createFunctionResponse(call.id, result)
      });
    }
  }
}
```

### Differences from Long-Running Tools

| Feature | `pauseOnToolCalls` | Long-Running Tools |
|---------|-------------------|-------------------|
| Scope | ALL tools | Specific tools |
| Control | Client decides | Tool decides |
| Use case | Client-side execution | Async server operations |
| Configuration | RunConfig option | Tool property |

### Security Implications

Enable `pauseOnToolCalls` when:

- Tools access sensitive local resources
- Client needs to audit tool calls
- Execution requires user approval
- Tools should run in client environment

---

## Related Documentation

- [Agents](./agents.md) - Agent types and configuration
- [Models](./models.md) - LLM integration
- [Sessions](./sessions.md) - Session and state management
- [Events](./events.md) - Event system and structure
