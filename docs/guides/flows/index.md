# Flows

The LLM flow pipeline in the Agent Development Kit builds each `LlmRequest`, invokes the model, processes each `LlmResponse`, executes tool calls concurrently across turn-by-turn and live streaming sessions, reconnects dropped live sessions via resumption handles, and routes agent transfers. In `@google/adk`, the flow engine is integrated directly into `LlmAgent`, while processors and function-call helpers are exposed as composable units:

- `BaseLlmRequestProcessor` and `BaseLlmResponseProcessor` - Abstract base classes for processors that inspect or mutate `LlmRequest` before the model call and `LlmResponse` after the model call, optionally yielding `Event` objects.
- `CONTENT_REQUEST_PROCESSOR`, `INTERACTIONS_REQUEST_PROCESSOR`, `AgentTransferLlmRequestProcessor`, `isAgentTransferLlmRequestProcessor`, `ContextCompactorRequestProcessor`, `CodeExecutionResponseProcessor`, and `injectSessionState` - Built-in request and response processors, type guard, and instruction state-interpolation utility exported from `@google/adk`.
- `SetModelResponseTool`, `SET_MODEL_RESPONSE_TOOL_NAME`, and `isSetModelResponseTool` - Structured-response tool and type guard used by `LlmAgent` when `outputSchema` and tools are configured together on models that do not natively combine `responseSchema` with function declarations.
- `Aclosing` and `isAclosing` - Async-generator lifecycle wrapper and type guard guaranteeing `return(undefined)` runs on early exit, consumer errors, and `next()` rejections across flow steps, processors, and live tool streams.
- `handleFunctionCallsLive`, `findEventByFunctionCallId`, `findMatchingFunctionCall`, and `isToolNotFound` - Function-calling helpers for live sessions, event correlation, and unresolvable tool detection.
- `createRunConfig` and `StreamingMode` - Runtime configuration helpers for `supportCfc`, `sessionResumption`, SSE streaming, and LLM call limits.

## Introduction

Every turn of an `LlmAgent` runs through a three-stage flow that transforms session history and user input into model calls, tool executions, and output events:

1. **Preprocess**: Each `BaseLlmRequestProcessor` in `agent.requestProcessors` runs in order, populating `llmRequest.config`, `llmRequest.contents`, `llmRequest.toolsDict`, and `llmRequest.liveConnectConfig`. Each configured toolset and tool then runs its `processLlmRequest` hook to register declarations or mutate `llmRequest`.
2. **Call the model**: In turn-by-turn mode through `Runner.runAsync`, `callLlmAsync` runs `beforeModelCallback`, increments the invocation LLM call counter, calls `llm.generateContentAsync` or bridges to `runLiveFlow` when `runConfig.supportCfc` is enabled, and runs `afterModelCallback`. In bidirectional streaming mode through `Runner.runLive`, `runLiveFlow` opens a `BaseLlmConnection`, drains `invocationContext.liveRequestQueue` in `runSendLoop`, processes server responses in `runReceiveLoop`, and transparently reconnects when a session resumption handle is available.
3. **Postprocess**: Each `BaseLlmResponseProcessor` in `agent.responseProcessors` runs in order, the merged model event is yielded, any `functionCall` parts are executed concurrently via `Promise.allSettled` (`handleFunctionCallsAsync` in turn-by-turn mode or `handleFunctionCallsLive` in live mode) and merged in original call order, and any `transferToAgent` action delegates to the target agent.

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
    const rawLocale = invocationContext.session.state['locale'];
    const locale = typeof rawLocale === 'string' ? rawLocale : 'en-US';
    appendInstructions(llmRequest, [`Respond using locale ${locale}.`]);
    yield* [];
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
    yield* [];
  }
}

export const agent = new LlmAgent({
  name: 'assistantAgent',
  model: 'gemini-flash-latest',
  instruction: 'Answer user questions concisely.',
  requestProcessors: [new LocaleRequestProcessor(), CONTENT_REQUEST_PROCESSOR],
  responseProcessors: [new TagResponseProcessor()],
});
```

## How it works

1. **Default request processor chain**: When `config.requestProcessors` is omitted, `LlmAgent` initializes `this.requestProcessors` in this order:
   - `BASIC_LLM_REQUEST_PROCESSOR`: Copies `agent.generateContentConfig`, sets `llmRequest.model`, and sets native `responseSchema` (`application/json`) when `agent.outputSchema` is configured (`agent.mode !== 'task'`) and either no function tools (including `transfer_to_agent` when reachable transfer targets exist) are declared or `canUseOutputSchemaWithTools(agent.canonicalModel)` is `true` (Gemini 2.0+ on Vertex AI). When `invocationContext.runConfig` is set, it also copies `responseModalities`, `speechConfig`, `inputAudioTranscription`, `outputAudioTranscription`, `realtimeInputConfig`, `enableAffectiveDialog`, `proactivity`, and `sessionResumption` onto `llmRequest.liveConnectConfig`.
   - `AUTH_PREPROCESSOR`: Resumes pending credential requests for `adk_request_credential` from user responses.
   - `IDENTITY_LLM_REQUEST_PROCESSOR`: Appends the agent `name` and `description` to the system instruction.
   - `INSTRUCTIONS_LLM_REQUEST_PROCESSOR`: Resolves `agent.globalInstruction` and `agent.instruction` as a string or `InstructionProvider`, interpolates `{state}` and `{artifact.*}` placeholders on string instructions via `injectSessionState(template, readonlyContext)` (or lets custom `InstructionProvider` functions call `injectSessionState` directly), and appends them to `llmRequest`. In non-live, non-CFC turn-by-turn mode (`!invocationContext.liveRequestQueue && !invocationContext.runConfig?.supportCfc`), when `agent.outputSchema` (`agent.mode !== 'task'`) is configured alongside function tools (including reachable `transfer_to_agent` targets) and the model cannot combine native `responseSchema` with tools, it also appends the `set_model_response` final-output instruction.
   - `REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR`: Resumes tool calls gated by `adk_request_confirmation`.
   - `REQUEST_INPUT_LLM_REQUEST_PROCESSOR`: Resumes workflow and tool input interrupts for `adk_request_input`.
   - `ContextCompactorRequestProcessor`: Inserted immediately before `CONTENT_REQUEST_PROCESSOR` when `config.contextCompactors` is non-empty, compacting older session events.
   - `CONTENT_REQUEST_PROCESSOR`: Builds `llmRequest.contents` from `session.events`, filtering incomplete or internal branches and re-attributing events authored by other agents as user-role context (`For context:`). When converting another agent's event, `CONTENT_REQUEST_PROCESSOR` excludes `thought: true` text parts and `thoughtSignature` metadata, drops foreign events that contain only thoughts or signatures, and summarizes foreign `functionCall` and `functionResponse` parts as plain text without leaking thought metadata.
   - `NL_PLANNING_REQUEST_PROCESSOR`: Applies `agent.planner` for `BuiltInPlanner` or `PlanReActPlanner` and strips `thought` flags from historical request parts.
   - `INTERACTIONS_REQUEST_PROCESSOR`: Populates interaction metadata when configured.
   - `CODE_EXECUTION_REQUEST_PROCESSOR`: Extracts inline data files, converts historical code blocks when using a client-side `BaseCodeExecutor`, or attaches `BuiltInCodeExecutor` to `llmRequest`.
   - `TOOL_FILTER_REQUEST_PROCESSOR`: Populates `llmRequest.allowedTools` when tool filtering is active.
   - `AGENT_TRANSFER_LLM_REQUEST_PROCESSOR`: Appended unless `disallowTransferToParent && disallowTransferToPeers && !subAgents.length`, adding transfer instructions and registering the `transfer_to_agent` tool.
2. **Default response processor chain**: When `config.responseProcessors` is omitted, `LlmAgent` runs:
   - `NL_PLANNING_RESPONSE_PROCESSOR`: Applies `agent.planner.processPlanningResponse` to split or mark thought parts.
   - `CODE_EXECUTION_RESPONSE_PROCESSOR`: Extracts fenced code blocks from model responses, executes them via `agent.codeExecutor`, saves generated files as artifacts, and yields execution result events.
3. **Concurrent parallel function-call execution and `stateDelta` merging**:
   - When a model response contains multiple `functionCall` parts, both `LlmAgent` turn-by-turn execution and `handleFunctionCallsLive` dispatch all filtered calls concurrently via `Promise.allSettled` (awaiting all started calls before rethrowing any callback error) rather than awaiting each call sequentially. On JavaScript's single-threaded event loop, yielding `async` tools interleave across `await` points while synchronous or non-yielding `async` work runs to completion before yielding.
   - Each call receives its own deep-cloned `functionCall.args` and `Context` (`toolContext`), runs plugin and canonical `beforeToolCallbacks`, invokes the tool (converting unhandled tool errors into `{error}` response payloads after `onToolErrorCallback`), and runs plugin and canonical `afterToolCallbacks`.
   - Regardless of completion order, `functionResponse` parts in the merged `Event` preserve the model's original `functionCall` order, and the merged `Event` keeps the first response event's `invocationId`, `author`, and `branch`.
   - `EventActions` from parallel calls are merged in call order, and when multiple parallel calls read and write the same key through `toolContext.state` and finish out of call order, the latest value recorded on `session.state` (along with its write-order stamp) is re-applied so out-of-order scalar, array, or nested-array updates are never overwritten by an earlier stale snapshot. Direct writes to `toolContext.actions.stateDelta` that bypass `toolContext.state` keep call-order precedence.
   - Custom TypeScript tools, parameters, and agent names use `camelCase` or `kebab-case`, whereas ADK framework built-in control tools (`set_model_response`, `transfer_to_agent` with `{agent_name}`, `stop_streaming` with `{function_name}`, `adk_request_credential`, `adk_request_confirmation`, and `adk_request_input`) use `snake_case` wire schemas shared across ADK runtimes.
4. **Live session resumption and multi-agent transfers (`runLiveFlow`)**:
   - `LlmAgent` seeds `invocationContext.liveSessionResumptionHandle` from `runConfig.sessionResumption?.handle` (or `Runner.runLive({liveSessionResumptionHandle})`) and updates it whenever the server emits `liveSessionResumptionUpdate.newHandle`.
   - When a resumption handle is active, `runLiveFlow` attaches `{handle, transparent: sessionResumption?.transparent ?? true}` to `llmRequest.liveConnectConfig.sessionResumption` and skips `connection.sendHistory(...)` because the server already holds the conversation state.
   - If the server sends `goAway` or the connection drops with a recoverable WebSocket/network error while a resumption handle is present, `runLiveFlow` tears down the current connection and reconnects up to 5 times; unrecoverable connection errors (such as close code `1007`) reject immediately without retrying.
   - When a live model turn invokes `transfer_to_agent`, `runLiveFlow` aborts the parent send loop, closes the parent connection, clears the parent's `liveSessionResumptionHandle` and `runConfig.sessionResumption.handle` so the target sub-agent opens a fresh live session (replaying history as needed), yields the sub-agent's live events, and restores the parent's context in `finally`.
5. **Compositional Function Calling with `runConfig.supportCfc`**:
   - In `Runner.runAsync`, enabling `runConfig.supportCfc` verifies that the root `LlmAgent` model is Gemini 2.0 or newer and installs `BuiltInCodeExecutor` if not already set.
   - In `applyLiveRunConfig`, `supportCfc: true` forces `llmRequest.liveConnectConfig.responseModalities = [Modality.TEXT]`.
   - In `LlmAgent.callLlmAsync`, `supportCfc: true` increments the invocation LLM call counter, initializes `invocationContext.liveRequestQueue ??= new LiveRequestQueue()`, iterates `this.runLiveFlow(invocationContext)` inside a `try / finally` that guarantees `liveRequestQueue.close()`, runs `handleAfterModelCallback` on each event, yields partial events only when `runConfig.streamingMode === StreamingMode.SSE` while always yielding non-partial events, and closes `liveRequestQueue` when `turnComplete` is `true`. In `runOneStepAsync`, pre-processed `Event` items yielded under `supportCfc: true` are yielded directly without re-running `postprocess`.
6. **Live tool execution with `handleFunctionCallsLive`**:
   - `LlmAgent.postprocessLive` calls `handleFunctionCallsLive` whenever a live model response contains `functionCall` parts, running multiple calls in the same turn concurrently.
   - Regular synchronous and asynchronous tools execute via `tool.runAsync`, with `beforeToolCallbacks`, `afterToolCallbacks`, and plugin callbacks applied in the same order as turn-by-turn mode.
   - Async-generator `FunctionTool` instances where `execute` is an `async function*` are launched in a background `Task` via `tool._callLive({args, toolContext, invocationContext})` and registered in `invocationContext.activeStreamingTools[tool.name]`. Each yielded value is pushed to `invocationContext.liveRequestQueue` as a user `Content` message formatted as `"Function <name> returned: <value>"`, while the initial function call immediately returns `{status: 'The function is running asynchronously and the results are pending.'}`.
   - During `runSendLoop`, every incoming `LiveRequest` on `invocationContext.liveRequestQueue` is also forwarded to `activeStreamingTool.stream.send(liveRequest)` for any active tool with an input `stream` queue.
   - A function call with `name: 'stop_streaming'` and `args: {function_name: '<toolName>'}` cancels the active `Task` for `toolName`, waits up to 1 second for it to finish, and clears the stored task reference only if a concurrent call has not already replaced it with a newer `Task`.
7. **Structured output alongside tools (`SetModelResponseTool`) and live-mode handling**:
   - In `LlmAgent.runOneStepAsync` (`mode !== 'task'`, `!invocationContext.liveRequestQueue && !invocationContext.runConfig?.supportCfc`), when `outputSchema` is configured alongside function tools (`this.tools`, reachable `transfer_to_agent` targets, or processor-registered `llmRequest.toolsDict` entries) and `!canUseOutputSchemaWithTools(this.canonicalModel)`, `LlmAgent` appends `new SetModelResponseTool(this.outputSchemaSource ?? this.outputSchema)` unless `tools` already contains an instance matching `isSetModelResponseTool` (preventing duplicate `set_model_response` registration). During `allowedTools` filtering, `SET_MODEL_RESPONSE_TOOL_NAME` (`'set_model_response'`) is always retained so tool filters cannot block final structured responses.
   - In `LlmAgent.postprocess`, after yielding the `functionResponse` event for `set_model_response`, `LlmAgent` reads `functionResponseEvent.actions.setModelResponse` and yields a synthesized final model-authored text event containing `JSON.stringify(response)` (stamped with `invocationContext.invocationId` and `invocationContext.branch`). `maybeSaveOutputToState` parses and validates that JSON payload against `outputSchemaSource ?? outputSchema` and writes it to `event.actions.stateDelta[outputKey]`.
   - In `LlmAgent.runLiveFlow` (and when `runConfig.supportCfc` routes `callLlmAsync` through `runLiveFlow`), when `outputSchema` is set and `mode !== 'task'`, `LlmAgent` logs a `logger.warn` notice stating that `outputSchema` is not supported in live mode and will be ignored, and both `InstructionsLlmRequestProcessor` and `LlmAgent.runOneStepAsync` skip `set_model_response` instruction and tool injection so the live model is not told to call an unregistered tool.
8. **Deterministic async-generator cleanup (`Aclosing`)**:
   - `LlmAgent` flow loops (`runAsyncImpl`, `runLiveImpl`, `runLiveFlow`, `runLivePreprocess`, `runReceiveLoop`, `postprocessLive`, `runOneStepAsync`, `postprocess`, `callLlmAsync`, and `runAndHandleError`), `CodeExecutionRequestProcessor`, `CodeExecutionResponseProcessor`, and live streaming tool helpers (`callToolLive` and `processFunctionLiveHelper`) wrap `AsyncGenerator` consumers in `new Aclosing(...)`.
   - Unlike bare `for await...of` (which does not invoke `return()` when `generator.next()` itself rejects), `Aclosing` awaits `return(undefined)` at most once on early `break`/`return`, downstream consumer errors (such as `liveRequestQueue.sendContent` throwing), and `next()` rejections. When `stop_streaming` aborts a suspended live streaming tool, `processFunctionLiveHelper` triggers `generator.close()` non-blockingly so `stop_streaming` settles within its 1-second timeout while still finalizing the generator once its pending `await` settles.

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

The `RunConfig` interface controls streaming mode, Compositional Function Calling, live session resumption, output modalities, and LLM call limits for a single invocation.

| Option               | Type                      | Default              | Description                                                                                                                                         |
| :------------------- | :------------------------ | :------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| `streamingMode`      | `StreamingMode`           | `StreamingMode.NONE` | Set `StreamingMode.SSE` to yield partial streaming events during `runAsync`; `StreamingMode.NONE` yields complete turns.                            |
| `supportCfc`         | `boolean`                 | `false`              | Routes `callLlmAsync` through `runLiveFlow` with `Modality.TEXT` and `BuiltInCodeExecutor`.                                                         |
| `responseModalities` | `Modality[]`              | `undefined`          | Output modalities copied onto `llmRequest.liveConnectConfig`, overridden to `[Modality.TEXT]` when `supportCfc` is enabled.                         |
| `sessionResumption`  | `SessionResumptionConfig` | `undefined`          | Live session resumption settings shallow-cloned onto `llmRequest.liveConnectConfig.sessionResumption` (`transparent` defaults to `true` on resume). |
| `maxLlmCalls`        | `number`                  | `500`                | Maximum number of LLM calls permitted in a single invocation; values `<= 0` disable enforcement.                                                    |
| `pauseOnToolCalls`   | `boolean`                 | `false`              | Suspends the agent loop immediately after yielding a model event that contains function calls.                                                      |

Passing `supportCfc: true` in `runConfig` switches turn-by-turn `callLlmAsync` execution onto the bidirectional live connection while still enforcing `maxLlmCalls`, applying `afterModelCallback`, and filtering partial events according to `StreamingMode`.

### `handleFunctionCallsLive` parameters

The `handleFunctionCallsLive` function accepts an options object describing the live function-call event and active tool registry.

| Option                 | Type                               | Default     | Description                                                                                 |
| :--------------------- | :--------------------------------- | :---------- | :------------------------------------------------------------------------------------------ |
| `invocationContext`    | `InvocationContext`                | Required    | Current invocation context holding `liveRequestQueue`, `activeStreamingTools`, and plugins. |
| `functionCallEvent`    | `Event`                            | Required    | Model event containing the `functionCall` parts to execute concurrently.                    |
| `toolsDict`            | `Record<string, BaseTool>`         | Required    | Map of callable tool names to `BaseTool` instances.                                         |
| `beforeToolCallbacks`  | `SingleBeforeToolCallback[]`       | Required    | Canonical before-tool callbacks to run after plugin callbacks.                              |
| `afterToolCallbacks`   | `SingleAfterToolCallback[]`        | Required    | Canonical after-tool callbacks to run after plugin callbacks.                               |
| `filters`              | `Set<string>`                      | `undefined` | Optional allowlist of `functionCall.id` values to execute.                                  |
| `toolConfirmationDict` | `Record<string, ToolConfirmation>` | `undefined` | Per-call confirmation decisions keyed by `functionCall.id`.                                 |
| `resumeInputsDict`     | `Record<string, ResumeInputs>`     | `undefined` | Per-call resume payloads keyed by `functionCall.id`.                                        |

When `handleFunctionCallsLive` executes an async-generator `FunctionTool`, it registers the background `Task` under `invocationContext.activeStreamingTools[tool.name]` and preserves any `stream` queue already attached to that entry.

## Advanced applications

The examples below show how to execute parallel tool calls that share `toolContext.state`, how to run streaming tools with `stop_streaming` in live mode, how to configure live session resumption, and how to run Compositional Function Calling (`supportCfc: true`) on `LlmAgent`.

### Concurrent parallel tool calls and `toolContext.state`

When the model emits multiple `functionCall` parts in a single turn, `LlmAgent` executes them concurrently via `Promise.allSettled`, merges `functionResponse` parts in original call order, and preserves out-of-order `toolContext.state` scalar, array, and nested-object updates:

```ts
import {FunctionTool, InMemoryRunner, LlmAgent} from '@google/adk';
import {z} from 'zod';

const checkRegionHealth = new FunctionTool({
  name: 'checkRegionHealth',
  description: 'Checks region health and appends the region to checkedRegions.',
  parameters: z.object({region: z.string()}),
  execute: async ({region}, toolContext) => {
    const checked = toolContext?.state.get<string[]>('checkedRegions') ?? [];
    toolContext?.state.set('checkedRegions', [...checked, region]);
    return {region, healthy: true};
  },
});

const opsAgent = new LlmAgent({
  name: 'opsAgent',
  model: 'gemini-flash-latest',
  instruction: 'Check requested regions in parallel with checkRegionHealth.',
  tools: [checkRegionHealth],
});

export async function runParallelHealthCheck(): Promise<string[]> {
  const runner = new InMemoryRunner({agent: opsAgent, appName: 'ops-app'});
  const session = await runner.sessionService.createSession({
    appName: 'ops-app',
    userId: 'u-1',
  });

  let checkedRegions: string[] = [];
  for await (const event of runner.runAsync({
    userId: 'u-1',
    sessionId: session.id,
    newMessage: {
      role: 'user',
      parts: [{text: 'Check us-central1 and europe-west1.'}],
    },
  })) {
    const updated = event.actions.stateDelta['checkedRegions'];
    if (Array.isArray(updated)) {
      checkedRegions = updated.filter(
        (item): item is string => typeof item === 'string',
      );
    }
  }
  return checkedRegions;
}
```

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

const monitorStockPrice = new FunctionTool({
  name: 'monitorStockPrice',
  description: 'Streams stock price updates.',
  parameters: z.object({stockSymbol: z.string()}),
  execute: async function* ({stockSymbol}) {
    yield `${stockSymbol}: $180.50`;
    yield `${stockSymbol}: $181.25`;
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
  name: 'stockAgent',
  model: 'gemini-flash-latest',
  tools: [monitorStockPrice, stopStreaming],
});
const ctx = new InvocationContext({
  invocationId: 'inv-1',
  agent,
  session: createSession({id: 's-1', appName: 'stock-app', userId: 'u-1'}),
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
            name: 'monitorStockPrice',
            args: {stockSymbol: 'GOOG'},
          },
        },
      ],
    },
  }),
  toolsDict: {
    monitorStockPrice,
    stop_streaming: stopStreaming,
  },
  beforeToolCallbacks: [],
  afterToolCallbacks: [],
});

await ctx.activeStreamingTools?.['monitorStockPrice']?.task?.promise;
export const firstUpdate = await liveRequestQueue.get();
// firstUpdate.content?.parts?.[0]?.text === "Function monitorStockPrice returned: GOOG: $180.50"
```

### Live session resumption (`runConfig.sessionResumption`)

Configure `sessionResumption` in `createRunConfig` so `Runner.runLive` records `liveSessionResumptionUpdate.newHandle` events and transparently reconnects on `goAway` or transient connection drops without replaying history:

```ts
import {
  InMemorySessionService,
  LiveRequestQueue,
  LlmAgent,
  Runner,
  createRunConfig,
} from '@google/adk';

export async function runResumableLiveSession(
  agent: LlmAgent,
  resumeHandle?: string,
): Promise<string | undefined> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'live-app',
    userId: 'u-1',
  });
  const runner = new Runner({
    appName: 'live-app',
    agent,
    sessionService,
  });
  const liveRequestQueue = new LiveRequestQueue();
  let latestHandle = resumeHandle;

  for await (const event of runner.runLive({
    userId: 'u-1',
    sessionId: session.id,
    liveRequestQueue,
    runConfig: createRunConfig({
      sessionResumption: {transparent: true, handle: latestHandle},
    }),
  })) {
    if (event.liveSessionResumptionUpdate?.newHandle) {
      latestHandle = event.liveSessionResumptionUpdate.newHandle;
    }
  }

  return latestHandle;
}
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

export async function runWithCfc(agent: LlmAgent): Promise<void> {
  const session = createSession({
    id: 's-cfc',
    appName: 'cfc-app',
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

### Structured output alongside tools (`SetModelResponseTool`)

Configure `outputSchema`, `outputKey`, and `tools` together on an `LlmAgent` so turn-by-turn flows automatically inject `SetModelResponseTool` (`set_model_response`) when needed, validate the structured payload, emit a final model JSON event, and persist the validated value under `outputKey`:

```ts
import {Aclosing, FunctionTool, InMemoryRunner, LlmAgent} from '@google/adk';
import {z} from 'zod';

const lookupServiceLatency = new FunctionTool({
  name: 'lookupServiceLatency',
  description: 'Returns the p95 latency in milliseconds for a service.',
  parameters: z.object({serviceName: z.string()}),
  execute: async ({serviceName}) => ({serviceName, p95Ms: 42}),
});

const reportSchema = z.object({
  serviceName: z.string(),
  p95Ms: z.number(),
  withinSlo: z.boolean(),
});

export const structuredOpsAgent = new LlmAgent({
  name: 'structuredOpsAgent',
  model: 'gemini-flash-latest',
  instruction:
    'Inspect latency with lookupServiceLatency and report SLO compliance.',
  tools: [lookupServiceLatency],
  outputSchema: reportSchema,
  outputKey: 'sloReport',
});

export async function runStructuredReport(): Promise<unknown> {
  const runner = new InMemoryRunner({
    agent: structuredOpsAgent,
    appName: 'structured-ops-app',
  });
  const session = await runner.sessionService.createSession({
    appName: 'structured-ops-app',
    userId: 'u-1',
  });

  let report: unknown;
  for await (const event of new Aclosing(
    runner.runAsync({
      userId: 'u-1',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [{text: 'Check SLO status for checkout.'}],
      },
    }),
  )) {
    if (event.actions.stateDelta['sloReport'] !== undefined) {
      report = event.actions.stateDelta['sloReport'];
    }
  }
  return report;
}
```

## Limitations

- **Custom `requestProcessors` and `responseProcessors` replace the defaults**: Passing `requestProcessors` or `responseProcessors` to `new LlmAgent({...})` replaces the default processor array rather than appending to it. Because several internal processors such as `BASIC_LLM_REQUEST_PROCESSOR`, `IDENTITY_LLM_REQUEST_PROCESSOR`, `INSTRUCTIONS_LLM_REQUEST_PROCESSOR`, and `NL_PLANNING_REQUEST_PROCESSOR` are not exported from the root `@google/adk` barrel, use `beforeModelCallback` and `afterModelCallback` when you want to keep the full default chain intact, or mutate `agent.requestProcessors.push(...)` and `agent.responseProcessors.push(...)` after constructing the `LlmAgent`.
- **Live sessions ignore `outputSchema`**: Bidirectional live streaming (`Runner.runLive` / `LlmAgent.runLive`) has no single final structured turn; when `outputSchema` is set with `mode !== 'task'`, `LlmAgent` logs a warning, omits the `set_model_response` instruction, and does not auto-inject `SetModelResponseTool`. To capture structured values during a live session, expose a `FunctionTool` that writes to `toolContext.state`.
- **Synchronous CPU work blocks sibling parallel tools on the single-threaded event loop**: Although `Promise.allSettled` starts every filtered tool call in a batch concurrently, synchronous functions and `async` functions that do not `await` block the Node.js or browser event loop until they return or reach an `await` point.
- **Live session reconnects are bounded**: `runLiveFlow` retries recoverable live connection drops and `goAway` signals up to 5 times when a resumption handle is present, and throws once the cap is exceeded.
- **`supportCfc` requires Gemini 2.0 or newer and forces text modality**: `Runner.runAsync` throws if `runConfig.supportCfc` is enabled on a model earlier than Gemini 2.0 (requiring a numeric major version `>= 2` such as `gemini-2.5-flash`), and `applyLiveRunConfig` overrides `liveConnectConfig.responseModalities` to `[Modality.TEXT]`.
- **`stop_streaming` cancellation timeout is 1 second**: `stop_streaming` calls `task.cancel()` and waits up to 1000 ms for the background `Task` to settle. If a custom task ignores `AbortSignal` and stays pending past 1000 ms, `stop_streaming` logs a warning and returns `{status: 'The task is not cancelled yet for <name>.'}`.
- **`AudioTranscriber` is internal**: `AudioTranscriber` (`core/src/flows/llm_flows/audio_transcriber.ts`) is an internal helper and is not re-exported from the top-level `@google/adk` barrel; live audio sessions emit native `inputTranscription` and `outputTranscription` events on `LlmAgent`.

## Related samples

- [samples/flows/](../../../samples/flows/README.md) - Runnable offline sample demonstrating custom `BaseLlmRequestProcessor` and `BaseLlmResponseProcessor` stages with concurrent parallel tool execution and foreign-agent thought filtering, live streaming tool execution and `stop_streaming` via `handleFunctionCallsLive`, live session resumption on `goAway`, Compositional Function Calling (`supportCfc`), and structured output alongside tools via `SetModelResponseTool` with `Aclosing` cleanup.

## Related guides

- [Tools](../tools/index.md) - `BaseTool`, `FunctionTool` with `_callLive` streaming, `LongRunningFunctionTool`, `AgentTool`, and `ToolContext`.
- [Code executors](../code_executors/index.md) - Server-side and client-side code executors and `CodeExecutionResponseProcessor`.
- [Planners](../planners/index.md) - `BasePlanner`, `BuiltInPlanner`, and `PlanReActPlanner` used by the planning processors.
- [Auth](../auth/index.md) - `AuthConfig`, `AuthHandler`, and `AUTH_PREPROCESSOR` credential resumption.
