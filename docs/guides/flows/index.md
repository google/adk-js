# Flows

The LLM flow pipeline in the Agent Development Kit builds each `LlmRequest`, invokes the model, processes each `LlmResponse`, executes tool calls including live streaming tools, and routes agent transfers. In `@google/adk`, the flow engine is integrated directly into `LlmAgent`, while processors and function-call helpers are exposed as composable units:

- `BaseLlmRequestProcessor` and `BaseLlmResponseProcessor` - Abstract base classes for processors that inspect or mutate `LlmRequest` before the model call and `LlmResponse` after the model call, optionally yielding `Event` objects.
- `CONTENT_REQUEST_PROCESSOR`, `INTERACTIONS_REQUEST_PROCESSOR`, `AgentTransferLlmRequestProcessor`, `ContextCompactorRequestProcessor`, and `CodeExecutionResponseProcessor` - Built-in request and response processors exported from `@google/adk`.
- `handleFunctionCallsLive`, `findEventByFunctionCallId`, `findMatchingFunctionCall`, and `isToolNotFound` - Function-calling helpers for live sessions, event correlation, and unresolvable tool detection.
- `createRunConfig` and `StreamingMode` - Runtime configuration helpers for `supportCfc`, SSE streaming, and LLM call limits.

## Introduction

Every turn of an `LlmAgent` runs through a three-stage flow that transforms session history and user input into model calls, tool executions, and output events:

1. **Preprocess**: Each `BaseLlmRequestProcessor` in `agent.requestProcessors` runs in order, populating `llmRequest.config`, `llmRequest.contents`, `llmRequest.toolsDict`, and `llmRequest.liveConnectConfig`. Each configured tool then runs its `processLlmRequest` hook to register its declaration or mutate `llmRequest`.
2. **Call the model**: In turn-by-turn mode through `Runner.runAsync`, `callLlmAsync` runs `beforeModelCallback`, increments the invocation LLM call counter, calls `llm.generateContentAsync` or bridges to `runLiveFlow` when `runConfig.supportCfc` is enabled, and runs `afterModelCallback`. In bidirectional streaming mode through `Runner.runLive`, `runLiveFlow` opens a `BaseLlmConnection`, drains `invocationContext.liveRequestQueue` in `runSendLoop`, and processes server responses in `runReceiveLoop`.
3. **Postprocess**: Each `BaseLlmResponseProcessor` in `agent.responseProcessors` runs in order, the merged model event is yielded, any `functionCall` parts are executed via `handleFunctionCallsAsync` or `handleFunctionCallsLive` in live mode, and any `transferToAgent` action delegates to the target agent.

## Get started

Add a custom `BaseLlmRequestProcessor` and `BaseLlmResponseProcessor` to an `LlmAgent`:

```ts
import {
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
  CONTENT_REQUEST_PROCESSOR,
  Event,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  appendInstructions,
} from '@google/adk';

class LocaleRequestProcessor extends BaseLlmRequestProcessor {
  async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const locale =
      (invocationContext.session.state['locale'] as string | undefined) ??
      'en-US';
    appendInstructions(llmRequest, [`Respond using locale ${locale}.`]);
  }
}

class TagResponseProcessor extends BaseLlmResponseProcessor {
  async *runAsync(
    _invocationContext: InvocationContext,
    llmResponse: LlmResponse,
  ): AsyncGenerator<Event, void, void> {
    const content = llmResponse.content;
    const parts = content?.parts;
    const firstPart = parts?.[0];
    if (content && parts && firstPart?.text) {
      content.parts = [
        {...firstPart, text: `[verified] ${firstPart.text}`},
        ...parts.slice(1),
      ];
    }
  }
}

export const agent = new LlmAgent({
  name: 'assistant_agent',
  model: 'gemini-flash-latest',
  instruction: 'Answer user questions concisely.',
  requestProcessors: [new LocaleRequestProcessor(), CONTENT_REQUEST_PROCESSOR],
  responseProcessors: [new TagResponseProcessor()],
});
```

## How it works

1. **Default request processor chain**: When `config.requestProcessors` is omitted, `LlmAgent` initializes `this.requestProcessors` in this order:
   - `BASIC_LLM_REQUEST_PROCESSOR`: Copies `agent.generateContentConfig`, sets `llmRequest.model`, and applies `agent.outputSchema` when tools are not combined with an unsupported model.
   - `AUTH_PREPROCESSOR`: Resumes pending credential requests for `adk_request_credential` from user responses.
   - `IDENTITY_LLM_REQUEST_PROCESSOR`: Appends the agent `name` and `description` to the system instruction.
   - `INSTRUCTIONS_LLM_REQUEST_PROCESSOR`: Resolves `agent.globalInstruction` and `agent.instruction` as a string or `InstructionProvider`, interpolates session state variables, and appends them to `llmRequest`.
   - `REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR`: Resumes tool calls gated by `adk_request_confirmation`.
   - `REQUEST_INPUT_LLM_REQUEST_PROCESSOR`: Resumes workflow and tool input interrupts for `adk_request_input`.
   - `ContextCompactorRequestProcessor`: Inserted immediately before `CONTENT_REQUEST_PROCESSOR` when `config.contextCompactors` is non-empty, compacting older session events.
   - `CONTENT_REQUEST_PROCESSOR`: Builds `llmRequest.contents` from `session.events`, re-attributing other agents' events and filtering incomplete or internal branches.
   - `NL_PLANNING_REQUEST_PROCESSOR`: Applies `agent.planner` for `BuiltInPlanner` or `PlanReActPlanner` and strips `thought` flags from historical request parts.
   - `INTERACTIONS_REQUEST_PROCESSOR`: Populates interaction metadata when configured.
   - `CODE_EXECUTION_REQUEST_PROCESSOR`: Extracts inline data files, converts historical code blocks when using a client-side `BaseCodeExecutor`, or attaches `BuiltInCodeExecutor` to `llmRequest`.
   - `TOOL_FILTER_REQUEST_PROCESSOR`: Populates `llmRequest.allowedTools` when tool filtering is active.
   - `AGENT_TRANSFER_LLM_REQUEST_PROCESSOR`: Appended unless `disallowTransferToParent && disallowTransferToPeers && !subAgents.length`, adding transfer instructions and registering the `transfer_to_agent` tool.
2. **Default response processor chain**: When `config.responseProcessors` is omitted, `LlmAgent` runs:
   - `NL_PLANNING_RESPONSE_PROCESSOR`: Applies `agent.planner.processPlanningResponse` to split or mark thought parts.
   - `CODE_EXECUTION_RESPONSE_PROCESSOR`: Extracts fenced code blocks from model responses, executes them via `agent.codeExecutor`, saves generated files as artifacts, and yields execution result events.
3. **Compositional Function Calling with `runConfig.supportCfc`**:
   - In `Runner.runAsync`, enabling `runConfig.supportCfc` verifies that the root `LlmAgent` model is Gemini 2.0 or newer and installs `BuiltInCodeExecutor` if not already set.
   - In `applyLiveRunConfig`, `supportCfc: true` forces `llmRequest.liveConnectConfig.responseModalities = [Modality.TEXT]`.
   - In `LlmAgent.callLlmAsync`, `supportCfc: true` increments the invocation LLM call counter, initializes `invocationContext.liveRequestQueue ??= new LiveRequestQueue()`, iterates `this.runLiveFlow(invocationContext)` inside a `try / finally` that guarantees `liveRequestQueue.close()`, runs `handleAfterModelCallback` on each event, yields partial events only when `runConfig.streamingMode === StreamingMode.SSE` while always yielding non-partial events, and closes `liveRequestQueue` when `turnComplete` is `true`. In `runOneStepAsync`, pre-processed `Event` items yielded under `supportCfc: true` are yielded directly without re-running `postprocess`.
4. **Live tool execution with `handleFunctionCallsLive`**:
   - `LlmAgent.postprocessLive` calls `handleFunctionCallsLive` whenever a live model response contains `functionCall` parts.
   - Regular synchronous and asynchronous tools execute via `tool.runAsync`, with `beforeToolCallbacks`, `afterToolCallbacks`, and plugin callbacks applied in the same order as `handleFunctionCallsAsync`.
   - Async-generator `FunctionTool` instances where `execute` is an `async function*` are launched in a background `Task` via `tool._callLive({args, toolContext, invocationContext})` and registered in `invocationContext.activeStreamingTools[tool.name]`. Each yielded value is pushed to `invocationContext.liveRequestQueue` as a user `Content` message formatted as `"Function <name> returned: <value>"`, while the initial function call immediately returns `{status: 'The function is running asynchronously and the results are pending.'}`.
   - During `runSendLoop`, every incoming `LiveRequest` on `invocationContext.liveRequestQueue` is also forwarded to `activeStreamingTool.stream.send(liveRequest)` for any active tool with an input `stream` queue.
   - A function call with `name: 'stop_streaming'` and `args: {function_name: '<toolName>'}` cancels `invocationContext.activeStreamingTools[toolName].task` and waits up to 1 second for it to finish.

## Configuration options

The flow pipeline is configured through `LlmAgentConfig`, `RunConfig`, and `handleFunctionCallsLive` parameters.

### `LlmAgentConfig` flow options

The `LlmAgentConfig` interface configures the request and response processor chains, agent transfer rules, and model or tool callbacks on `new LlmAgent(config)`.

| Option                     | Type                         | Default       | Description                                                                                                            |
| :------------------------- | :--------------------------- | :------------ | :--------------------------------------------------------------------------------------------------------------------- |
| `requestProcessors`        | `BaseLlmRequestProcessor[]`  | Default chain | Ordered list of processors that build or mutate `LlmRequest` before each model call.                                   |
| `responseProcessors`       | `BaseLlmResponseProcessor[]` | Default chain | Ordered list of processors that inspect or mutate `LlmResponse` after each model call.                                 |
| `disallowTransferToParent` | `boolean`                    | `false`       | Prevents `AGENT_TRANSFER_LLM_REQUEST_PROCESSOR` from offering the parent agent as a transfer target.                   |
| `disallowTransferToPeers`  | `boolean`                    | `false`       | Prevents `AGENT_TRANSFER_LLM_REQUEST_PROCESSOR` from offering sibling agents as transfer targets.                      |
| `includeContents`          | `'default' \| 'none'`        | `'default'`   | Controls whether `CONTENT_REQUEST_PROCESSOR` includes prior conversation history or only the current turn.             |
| `beforeModelCallback`      | `BeforeModelCallback`        | `undefined`   | Callback or array of callbacks invoked before calling the model; returning an `LlmResponse` skips the model call.      |
| `afterModelCallback`       | `AfterModelCallback`         | `undefined`   | Callback or array of callbacks invoked after receiving an `LlmResponse`; returning an `LlmResponse` replaces it.       |
| `beforeToolCallback`       | `BeforeToolCallback`         | `undefined`   | Callback or array of callbacks invoked before executing a tool; returning a response object skips the tool execution.  |
| `afterToolCallback`        | `AfterToolCallback`          | `undefined`   | Callback or array of callbacks invoked after executing a tool; returning a response object replaces the tool response. |

When `requestProcessors` or `responseProcessors` is omitted, `LlmAgent` constructs the default chain described in the previous section. Setting `disallowTransferToParent` and `disallowTransferToPeers` to `true` on an agent with no `subAgents` omits `AGENT_TRANSFER_LLM_REQUEST_PROCESSOR`, keeping the agent in single-agent flow mode so the runner returns control to the parent on the next turn.

### `RunConfig` flow options

The `RunConfig` interface controls streaming mode, Compositional Function Calling, output modalities, and LLM call limits for a single invocation.

| Option               | Type            | Default              | Description                                                                                                                 |
| :------------------- | :-------------- | :------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| `streamingMode`      | `StreamingMode` | `StreamingMode.NONE` | Set `StreamingMode.SSE` to yield partial streaming events during `runAsync`; `StreamingMode.NONE` yields complete turns.    |
| `supportCfc`         | `boolean`       | `false`              | Routes `callLlmAsync` through `runLiveFlow` with `Modality.TEXT` and `BuiltInCodeExecutor`.                                 |
| `responseModalities` | `Modality[]`    | `undefined`          | Output modalities copied onto `llmRequest.liveConnectConfig`, overridden to `[Modality.TEXT]` when `supportCfc` is enabled. |
| `maxLlmCalls`        | `number`        | `500`                | Maximum number of LLM calls permitted in a single invocation; values `<= 0` disable enforcement.                            |
| `pauseOnToolCalls`   | `boolean`       | `false`              | Suspends the agent loop immediately after yielding a model event that contains function calls.                              |

Passing `supportCfc: true` in `runConfig` switches turn-by-turn `callLlmAsync` execution onto the bidirectional live connection while still enforcing `maxLlmCalls`, applying `afterModelCallback`, and filtering partial events according to `StreamingMode`.

### `handleFunctionCallsLive` parameters

The `handleFunctionCallsLive` function accepts an options object describing the live function-call event and active tool registry.

| Option                 | Type                               | Default     | Description                                                                                 |
| :--------------------- | :--------------------------------- | :---------- | :------------------------------------------------------------------------------------------ |
| `invocationContext`    | `InvocationContext`                | Required    | Current invocation context holding `liveRequestQueue`, `activeStreamingTools`, and plugins. |
| `functionCallEvent`    | `Event`                            | Required    | Model event containing the `functionCall` parts to execute.                                 |
| `toolsDict`            | `Record<string, BaseTool>`         | Required    | Map of callable tool names to `BaseTool` instances.                                         |
| `beforeToolCallbacks`  | `SingleBeforeToolCallback[]`       | Required    | Canonical before-tool callbacks to run after plugin callbacks.                              |
| `afterToolCallbacks`   | `SingleAfterToolCallback[]`        | Required    | Canonical after-tool callbacks to run after plugin callbacks.                               |
| `filters`              | `Set<string>`                      | `undefined` | Optional allowlist of `functionCall.id` values to execute.                                  |
| `toolConfirmationDict` | `Record<string, ToolConfirmation>` | `undefined` | Per-call confirmation decisions keyed by `functionCall.id`.                                 |
| `resumeInputsDict`     | `Record<string, ResumeInputs>`     | `undefined` | Per-call resume payloads keyed by `functionCall.id`.                                        |

When `handleFunctionCallsLive` executes an async-generator `FunctionTool`, it registers the background `Task` under `invocationContext.activeStreamingTools[tool.name]` and preserves any `stream` queue already attached to that entry.

## Advanced applications

The examples below show how to run streaming tools with `stop_streaming` in live mode and how to run Compositional Function Calling (`supportCfc: true`) on `LlmAgent`.

### Streaming tools and `stop_streaming` in live mode

Pass an async generator function as `execute` in `FunctionTool` so `handleFunctionCallsLive` starts a background `Task` in `invocationContext.activeStreamingTools`, pushes each yielded value to `invocationContext.liveRequestQueue`, and stops the task when the model calls `stop_streaming`:

```ts
import {
  FunctionTool,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  PluginManager,
  createEvent,
  createSession,
  handleFunctionCallsLive,
} from '@google/adk';
import {z} from 'zod';

const monitorStock = new FunctionTool({
  name: 'monitor_stock',
  description: 'Streams stock price updates.',
  parameters: z.object({ticker: z.string()}),
  execute: async function* ({ticker}) {
    yield `${ticker}: $180.50`;
    yield `${ticker}: $181.25`;
  },
});

const stopStreaming = new FunctionTool({
  name: 'stop_streaming',
  description: 'Stops an active streaming function by name.',
  parameters: z.object({function_name: z.string()}),
  execute: async () => ({}),
});

const liveRequestQueue = new LiveRequestQueue();
const agent = new LlmAgent({
  name: 'stock_agent',
  model: 'gemini-flash-latest',
  tools: [monitorStock, stopStreaming],
});
const ctx = new InvocationContext({
  invocationId: 'inv-1',
  agent,
  session: createSession({id: 's-1', appName: 'app', userId: 'u-1'}),
  liveRequestQueue,
  pluginManager: new PluginManager(),
});

await handleFunctionCallsLive({
  invocationContext: ctx,
  functionCallEvent: createEvent({
    invocationId: ctx.invocationId,
    author: agent.name,
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'call-1',
            name: 'monitor_stock',
            args: {ticker: 'GOOG'},
          },
        },
      ],
    },
  }),
  toolsDict: {monitor_stock: monitorStock, stop_streaming: stopStreaming},
  beforeToolCallbacks: [],
  afterToolCallbacks: [],
});

await ctx.activeStreamingTools?.['monitor_stock']?.task?.promise;
const firstUpdate = await liveRequestQueue.get();
// firstUpdate.content?.parts?.[0]?.text === "Function monitor_stock returned: GOOG: $180.50"
```

### Compositional Function Calling (`supportCfc: true`)

Pass `createRunConfig({supportCfc: true, streamingMode: StreamingMode.SSE})` on `InvocationContext` or `Runner.runAsync` to route `callLlmAsync` through `runLiveFlow` with `[Modality.TEXT]` while executing tool calls in live mode:

```ts
import {
  InvocationContext,
  LlmAgent,
  PluginManager,
  StreamingMode,
  createEvent,
  createRunConfig,
  createSession,
} from '@google/adk';

async function runWithCfc(agent: LlmAgent) {
  const session = createSession({
    id: 's-cfc',
    appName: 'app',
    userId: 'u-1',
    events: [
      createEvent({
        invocationId: 'inv-cfc',
        author: 'user',
        content: {role: 'user', parts: [{text: 'Compute the latest total.'}]},
      }),
    ],
  });
  const ctx = new InvocationContext({
    invocationId: 'inv-cfc',
    agent,
    session,
    runConfig: createRunConfig({
      supportCfc: true,
      streamingMode: StreamingMode.SSE,
    }),
    pluginManager: new PluginManager(),
  });

  for await (const event of agent.runAsync(ctx)) {
    // Receives live-processed tool calls, tool responses, and model turns.
    void event;
  }
}
```

## Limitations

- **Custom `requestProcessors` and `responseProcessors` replace the defaults**: Passing `requestProcessors` or `responseProcessors` to `new LlmAgent({...})` replaces the default processor array rather than appending to it. Because several internal processors such as `BASIC_LLM_REQUEST_PROCESSOR`, `IDENTITY_LLM_REQUEST_PROCESSOR`, `INSTRUCTIONS_LLM_REQUEST_PROCESSOR`, and `NL_PLANNING_REQUEST_PROCESSOR` are not exported from the root `@google/adk` barrel, use `beforeModelCallback` and `afterModelCallback` when you want to keep the full default chain intact, or mutate `agent.requestProcessors.push(...)` and `agent.responseProcessors.push(...)` after constructing the `LlmAgent`.
- **`supportCfc` requires Gemini 2.0 or newer and forces text modality**: `Runner.runAsync` throws if `runConfig.supportCfc` is enabled on a model earlier than Gemini 2.0, and `applyLiveRunConfig` overrides `liveConnectConfig.responseModalities` to `[Modality.TEXT]`.
- **`stop_streaming` cancellation timeout is 1 second**: `stop_streaming` calls `task.cancel()` and waits up to 1000 ms for the background `Task` to settle. If a custom task ignores `AbortSignal` and stays pending past 1000 ms, `stop_streaming` logs a warning and returns `{status: 'The task is not cancelled yet for <name>.'}`.
- **`AudioTranscriber` is internal**: `AudioTranscriber` (`core/src/flows/llm_flows/audio_transcriber.ts`) is an internal helper and is not re-exported from the top-level `@google/adk` barrel; live audio sessions emit native `inputTranscription` and `outputTranscription` events on `LlmAgent`.

## Related samples

- [samples/flows/](../../../samples/flows/README.md) - Runnable offline sample demonstrating custom `BaseLlmRequestProcessor` and `BaseLlmResponseProcessor` stages on an `LlmAgent`, live streaming tool execution and `stop_streaming` via `handleFunctionCallsLive`, and Compositional Function Calling (`supportCfc`).

## Related guides

- [Tools](../tools/index.md) - `BaseTool`, `FunctionTool` with `_callLive` streaming, `LongRunningFunctionTool`, `AgentTool`, and `ToolContext`.
- [Code executors](../code_executors/index.md) - Server-side and client-side code executors and `CodeExecutionResponseProcessor`.
- [Planners](../planners/index.md) - `BasePlanner`, `BuiltInPlanner`, and `PlanReActPlanner` used by the planning processors.
- [Auth](../auth/index.md) - `AuthConfig`, `AuthHandler`, and `AUTH_PREPROCESSOR` credential resumption.
