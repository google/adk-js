# Plugins

Plugins provide a structured way to intercept and modify agent, tool, and LLM behaviors at critical execution points. Unlike agent callbacks which apply to specific agents, plugins apply globally to all agents in the Runner.

## Overview

Plugins are best used for adding cross-cutting concerns like:
- Logging and monitoring
- Security policies and access control
- Caching and performance optimization
- Request/response transformation
- Error handling and recovery

## BasePlugin Lifecycle Hooks

The `BasePlugin` class provides 14 lifecycle callback methods that intercept different stages of agent execution.

### User Message and Runner Callbacks

#### onUserMessageCallback

Called when a user message is received, before the invocation starts.

```typescript
async onUserMessageCallback(params: {
  invocationContext: InvocationContext;
  userMessage: Content;
}): Promise<Content | undefined>
```

**Parameters:**
- `invocationContext` - Context for the current invocation
- `userMessage` - The content from the user

**Returns:** Optional `Content` to replace user message, or `undefined` to continue

#### beforeRunCallback

Called before the runner starts execution.

```typescript
async beforeRunCallback(params: {
  invocationContext: InvocationContext;
}): Promise<Content | undefined>
```

**Returns:** Optional `Content` to short-circuit execution

#### onEventCallback

Called after each event is yielded from the runner.

```typescript
async onEventCallback(params: {
  invocationContext: InvocationContext;
  event: Event;
}): Promise<Event | undefined>
```

**Returns:** Optional modified `Event`, or `undefined` to use original

#### afterRunCallback

Called after the runner run completes.

```typescript
async afterRunCallback(params: {
  invocationContext: InvocationContext;
}): Promise<void>
```

### Agent Callbacks

#### beforeAgentCallback

Called before an agent's primary logic is invoked.

```typescript
async beforeAgentCallback(params: {
  agent: BaseAgent;
  callbackContext: CallbackContext;
}): Promise<Content | undefined>
```

**Returns:** Optional `Content` to replace agent response

#### afterAgentCallback

Called after an agent's primary logic completes.

```typescript
async afterAgentCallback(params: {
  agent: BaseAgent;
  callbackContext: CallbackContext;
}): Promise<Content | undefined>
```

**Returns:** Optional `Content` to replace agent response

### Model Callbacks

#### beforeModelCallback

Called before a request is sent to the model.

```typescript
async beforeModelCallback(params: {
  callbackContext: CallbackContext;
  llmRequest: LlmRequest;
}): Promise<LlmResponse | undefined>
```

**Parameters:**
- `callbackContext` - Context for the agent call
- `llmRequest` - The request being sent (can be modified)

**Returns:** Optional `LlmResponse` to use instead of calling the model

#### afterModelCallback

Called after a response is received from the model.

```typescript
async afterModelCallback(params: {
  callbackContext: CallbackContext;
  llmResponse: LlmResponse;
}): Promise<LlmResponse | undefined>
```

**Parameters:**
- `callbackContext` - Context for the agent call
- `llmResponse` - The response received (can be modified)

**Returns:** Optional `LlmResponse` to replace the original

#### onModelErrorCallback

Called when a model call encounters an error.

```typescript
async onModelErrorCallback(params: {
  callbackContext: CallbackContext;
  llmRequest: LlmRequest;
  error: Error;
}): Promise<LlmResponse | undefined>
```

**Parameters:**
- `callbackContext` - Context for the agent call
- `llmRequest` - The request that caused the error
- `error` - The error that was raised

**Returns:** Optional `LlmResponse` to use instead of propagating the error

**Use Cases:**
- Fallback to cached responses when API is down
- Retry with different model parameters
- Return default/safe responses for certain error types
- Implement exponential backoff retry logic

### Tool Callbacks

#### beforeToolCallback

Called before a tool is executed.

```typescript
async beforeToolCallback(params: {
  tool: BaseTool;
  toolArgs: Record<string, unknown>;
  toolContext: ToolContext;
}): Promise<Record<string, unknown> | undefined>
```

**Parameters:**
- `tool` - The tool being called
- `toolArgs` - Tool arguments (can be modified)
- `toolContext` - Context for the tool execution

**Returns:** Optional result object to use instead of executing the tool

#### afterToolCallback

Called after a tool is executed.

```typescript
async afterToolCallback(params: {
  tool: BaseTool;
  toolArgs: Record<string, unknown>;
  toolContext: ToolContext;
  result: Record<string, unknown>;
}): Promise<Record<string, unknown> | undefined>
```

**Parameters:**
- `result` - The result from tool execution (can be modified)

**Returns:** Optional result object to replace the original

#### onToolErrorCallback

Called when a tool call encounters an error.

```typescript
async onToolErrorCallback(params: {
  tool: BaseTool;
  toolArgs: Record<string, unknown>;
  toolContext: ToolContext;
  error: Error;
}): Promise<Record<string, unknown> | undefined>
```

**Parameters:**
- `error` - The error that occurred

**Returns:** Optional result object to use instead of propagating the error

## PluginManager and Early-Exit Semantics

The `PluginManager` implements an early-exit strategy when executing plugin callbacks:

1. **Iteration**: Processes all registered plugins in order
2. **Callback Execution**: Calls the specified callback method on each plugin
3. **Result Check**: After each callback, checks if `result !== undefined`
4. **Early Exit**: If any plugin returns a non-undefined value, immediately returns that value and stops processing remaining plugins
5. **Debug Logging**: Logs when early exit occurs
6. **Error Handling**: Logs and re-throws any plugin errors with context

### Impact on Agent Callbacks

When a plugin returns a non-undefined value:
- Remaining plugins are skipped
- **Agent callbacks are also skipped** because the plugin result is returned before agent callbacks are reached

This design allows plugins to implement global policies that take precedence over agent-specific logic.

## Plugin vs Agent Callback Ordering

### Execution Order

1. **Plugins execute first** via `PluginManager`
2. If no plugin returns a value, **agent callbacks execute**
3. Within each group, callbacks execute in registration order

**Example from LlmAgent:**

```typescript
// Plugin callbacks run first
const beforeModelCallbackResponse =
  await invocationContext.pluginManager.runBeforeModelCallback({
    callbackContext,
    llmRequest,
  });

if (beforeModelCallbackResponse) {
  return beforeModelCallbackResponse;  // Short-circuit
}

// If no plugin override, run agent callbacks
for (const callback of this.canonicalBeforeModelCallbacks) {
  const callbackResponse = await callback({
    context: callbackContext,
    request: llmRequest,
  });
  if (callbackResponse) {
    return callbackResponse;
  }
}
```

### Change Propagation

Plugins and agent callbacks can both modify input parameters:
- **In-place mutation**: Modify the object directly (e.g., `llmRequest.contents.push(...)`)
- **Field updates**: Change specific fields (e.g., `llmRequest.config.temperature = 0.5`)
- **Return replacement**: Return a completely new object to replace the original

Modifications made by one plugin are visible to all subsequent plugins and agent callbacks.

**Pattern:**
```
Plugin 1 modifies llmRequest
  → Plugin 2 sees modifications
  → Agent callback sees all modifications

If Plugin 1 returns a value:
  → Plugins 2+ and agent callbacks are skipped
```

## Registration

Plugins are registered with the Runner through the constructor:

```typescript
const runner = new Runner({
  appName: 'myApp',
  agent: myAgent,
  sessionService: sessionService,
  plugins: [new LoggingPlugin(), new SecurityPlugin()],
});
```

### Duplicate Prevention

The `PluginManager` prevents duplicate registration:
- **Instance check**: Throws error if same plugin instance already registered
- **Name check**: Throws error if plugin with same name already registered

```typescript
class PluginManager {
  registerPlugin(plugin: BasePlugin): void {
    if (this.plugins.has(plugin)) {
      throw new Error(`Plugin '${plugin.name}' already registered.`);
    }
    if (Array.from(this.plugins).some((p) => p.name === plugin.name)) {
      throw new Error(`Plugin with name '${plugin.name}' already registered.`);
    }

    this.plugins.add(plugin);
    logger.info(`Plugin '${plugin.name}' registered.`);
  }
}
```

## SecurityPlugin

The `SecurityPlugin` implements tool call policy enforcement using a policy engine.

### Policy Engine Interface

```typescript
export interface BasePolicyEngine {
  evaluate(context: ToolCallPolicyContext): Promise<PolicyCheckResult>;
}

export interface PolicyCheckResult {
  outcome: string;
  reason?: string;
}

export enum PolicyOutcome {
  ALLOW = 'ALLOW',    // Tool call is allowed
  DENY = 'DENY',      // Tool call is rejected
  CONFIRM = 'CONFIRM' // Tool call needs external confirmation
}
```

### Default Implementation

```typescript
export class InMemoryPolicyEngine implements BasePolicyEngine {
  async evaluate(): Promise<PolicyCheckResult> {
    // Default permissive implementation
    return Promise.resolve({
      outcome: PolicyOutcome.ALLOW,
      reason: 'For prototyping purpose, all tool calls are allowed.',
    });
  }
}
```

### Policy Enforcement Flow

1. **First Call**: When no check state exists, calls `checkToolCallPolicy()`
2. **ALLOW**: Returns `undefined`, allowing tool execution
3. **DENY**: Returns `{error: 'This tool call is rejected by policy engine. Reason: {reason}'}`
4. **CONFIRM**: Calls `toolContext.requestConfirmation()` and returns partial error
5. **Confirmation Flow**: On subsequent call, checks `toolContext.toolConfirmation`:
   - If confirmed: Clears confirmation and allows execution
   - If not confirmed: Returns rejection error

### State Tracking

Uses session state key `TOOL_CALL_SECURITY_CHECK_STATES` to track which function calls have been checked, preventing duplicate policy evaluations.

### Example Custom Policy Engine

```typescript
class CustomPolicyEngine implements BasePolicyEngine {
  async evaluate(context: ToolCallPolicyContext): Promise<PolicyCheckResult> {
    // Deny access to file system tools
    if (context.tool.name.includes('file') || context.tool.name.includes('write')) {
      return {
        outcome: PolicyOutcome.DENY,
        reason: 'File system access is not permitted',
      };
    }

    // Require confirmation for database operations
    if (context.tool.name.includes('database') || context.tool.name.includes('sql')) {
      return {
        outcome: PolicyOutcome.CONFIRM,
        reason: 'Database operations require user confirmation',
      };
    }

    // Allow all other tools
    return {
      outcome: PolicyOutcome.ALLOW,
      reason: 'Tool is permitted',
    };
  }
}

// Use custom policy engine
const securityPlugin = new SecurityPlugin({
  policyEngine: new CustomPolicyEngine(),
});
```

## LoggingPlugin

The `LoggingPlugin` is a built-in plugin that logs important information at each callback point for debugging and monitoring.

### Features

- Logs all critical events to the console
- Uses grey color formatting for log output
- Serves as a demo for developers creating custom plugins
- All callbacks return `undefined`, so they never short-circuit execution

### Implemented Callbacks

- `onUserMessageCallback`: Logs user message, invocation ID, session details
- `beforeRunCallback`: Logs invocation starting
- `onEventCallback`: Logs event details, function calls, responses
- `afterRunCallback`: Logs invocation completed
- `beforeAgentCallback`: Logs agent starting
- `afterAgentCallback`: Logs agent completed
- `beforeModelCallback`: Logs LLM request details, system instruction (truncated to 200 chars)
- `afterModelCallback`: Logs LLM response, token usage
- `beforeToolCallback`: Logs tool starting with arguments
- `afterToolCallback`: Logs tool completed with result
- `onModelErrorCallback`: Logs LLM errors
- `onToolErrorCallback`: Logs tool errors

### Usage

```typescript
const runner = new Runner({
  agent: myAgent,
  sessionService: sessionService,
  plugins: [new LoggingPlugin()],
});
```

## Error Recovery with Plugins

Plugins can implement sophisticated error recovery strategies:

### Model Error Recovery

```typescript
class ModelErrorRecoveryPlugin extends BasePlugin {
  private cache = new Map<string, LlmResponse>();

  override async beforeModelCallback({callbackContext, llmRequest}) {
    // Check cache
    const cacheKey = JSON.stringify(llmRequest);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;  // Use cached response
    }
    return undefined;
  }

  override async afterModelCallback({callbackContext, llmResponse}) {
    // Cache successful responses
    const cacheKey = JSON.stringify(llmRequest);
    this.cache.set(cacheKey, llmResponse);
    return undefined;
  }

  override async onModelErrorCallback({llmRequest, error}) {
    // Check cache on error
    const cacheKey = JSON.stringify(llmRequest);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;  // Fallback to cache
    }

    // Return safe default response
    return {
      content: {
        role: 'model',
        parts: [{text: 'I apologize, but I encountered an error. Please try again.'}],
      },
    };
  }
}
```

### Tool Error Recovery

```typescript
class ToolErrorRecoveryPlugin extends BasePlugin {
  override async onToolErrorCallback({tool, toolArgs, error}) {
    // Log error for monitoring
    console.error(`Tool ${tool.name} failed:`, error);

    // Return graceful error message
    return {
      error: `The ${tool.name} tool encountered an error. Please try again with different parameters.`,
    };
  }
}
```

## Creating Custom Plugins

### Basic Plugin Template

```typescript
class MyCustomPlugin extends BasePlugin {
  constructor(name = 'my_custom_plugin') {
    super(name);
  }

  override async beforeModelCallback({callbackContext, llmRequest}) {
    // Add custom logic here
    // Modify llmRequest if needed

    // Return undefined to continue normal flow
    return undefined;

    // Or return LlmResponse to short-circuit
    // return {...};
  }
}
```

### Example: Request Modification Plugin

```typescript
class RequestModificationPlugin extends BasePlugin {
  constructor(private additionalInstruction: string) {
    super('request_modification');
  }

  override async beforeModelCallback({callbackContext, llmRequest}) {
    // Add additional context to every model call
    if (!llmRequest.config) {
      llmRequest.config = {};
    }

    const currentInstruction = llmRequest.config.systemInstruction || '';
    llmRequest.config.systemInstruction =
      currentInstruction + '\n\n' + this.additionalInstruction;

    return undefined;  // Continue with modified request
  }
}

// Usage
const plugin = new RequestModificationPlugin(
  'Always respond in a friendly and helpful tone.'
);
```

## Best Practices

1. **Return `undefined` to continue**: Only return non-undefined values when you want to override behavior
2. **Modify in-place sparingly**: Prefer returning new objects for clarity
3. **Use descriptive plugin names**: Makes debugging easier
4. **Log important actions**: Helps with debugging and monitoring
5. **Handle errors gracefully**: Don't let plugin errors break the entire system
6. **Keep plugins focused**: Each plugin should have a single responsibility
7. **Test error scenarios**: Ensure your error recovery logic works correctly

## See Also

- [Agents](./agents.md) - Understanding agent callbacks
- [Tools](./tools.md) - Tool execution lifecycle
- [Events](./events.md) - Event structure and handling
