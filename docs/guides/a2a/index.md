# A2A (Agent-to-Agent)

The `@google/adk/a2a` subpath (also re-exported from `@google/adk`) connects ADK agents to the Agent-to-Agent (A2A) protocol. It speaks A2A protocol v1.0 through `@a2a-js/sdk` 1.x and keeps answering and calling A2A v0.3 peers through the SDK's v0.3 compatibility layer (see [Protocol versions](#protocol-versions)). It lets you publish an ADK agent as an A2A server (`toA2a`, `getA2AAgentCard`, `A2AAgentExecutor`, `bearerTokenUserBuilder`, `AdkDefaultRequestHandler`, `getA2aRequestMetadata`) and invoke remote A2A agents from an ADK workflow (`RemoteA2AAgent`, `AGENT_CARD_PATH`, `AgentCardResolutionError`, `isAgentCardResolutionError`).

## Introduction

| Export                                                                                                                                                                     | Kind                      | Purpose                                                                                                                                                                                                                                                                           |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toA2a` / `ToA2aOptions`                                                                                                                                                   | Function / Interface      | Mounts an ADK agent on an Express application with `/.well-known/agent-card.json`, `/jsonrpc`, and `/rest` endpoints.                                                                                                                                                             |
| `bearerTokenUserBuilder` / `A2aUserBuilder`                                                                                                                                | Function / Type           | Constant-time shared-secret `Authorization: Bearer <token>` authenticator for `toA2a`.                                                                                                                                                                                            |
| `getA2AAgentCard`                                                                                                                                                          | Function                  | Builds an A2A v1.0 `AgentCard` from an ADK agent and the `AgentInterface` entries it is served on.                                                                                                                                                                                |
| `ResolveAgentCardOptions`                                                                                                                                                  | Interface                 | Configures origin and scheme validation when an agent card is fetched from a URL. Pass it as `ToA2aOptions.resolveAgentCardOptions` or `RemoteA2AAgentConfig.resolveAgentCardOptions`.                                                                                            |
| `AgentCardResolutionError` / `isAgentCardResolutionError`                                                                                                                  | Class / Function          | Error that `toA2a` throws when an agent card URL or file cannot be resolved, and its type guard. The `cause` holds the original error. `RemoteA2AAgent` does not throw it: it reports the same failure as a `Failed to initialize remote A2A agent <name>: <reason>` error event. |
| `A2AAgentExecutor` / `AgentExecutorConfig` / `ExecutorContext`                                                                                                             | Class / Interfaces        | Implements `@a2a-js/sdk`'s `AgentExecutor` by running an ADK `Runner` and publishing A2A task, artifact, and status events.                                                                                                                                                       |
| `AdkDefaultRequestHandler` / `getA2aRequestMetadata`                                                                                                                       | Class / Function          | Request handler for `A2AAgentExecutor`; exposes incoming `SendMessageRequest.metadata` on `ExecutorContext.a2aMetadata` and `InvocationContext.a2aMetadata`.                                                                                                                      |
| `RemoteA2AAgent` / `RemoteA2AAgentConfig` / `AGENT_CARD_PATH`                                                                                                              | Class / Interface / Const | `BaseAgent` subclass that delegates execution to a remote A2A server over streaming or non-streaming transport and converts responses back into ADK `Event` objects.                                                                                                              |
| `A2AStreamEventData`, `BeforeA2ARequestCallback`, `AfterA2ARequestCallback`, `BeforeExecuteCallback`, `AfterEventCallback`, `AfterExecuteCallback`, `RunnerOrRunnerConfig` | Types                     | Lifecycle callback and configuration types for `RemoteA2AAgent` and `A2AAgentExecutor`.                                                                                                                                                                                           |

## Get started

The example below builds an `AgentCard` for a deterministic ADK agent, executes the agent through `A2AAgentExecutor` into an in-memory event bus, and streams those A2A events back into ADK `Event` objects through `RemoteA2AAgent`. It runs offline without network sockets or API keys.

```ts
import type {AgentCard, SendMessageRequest, StreamResponse} from '@a2a-js/sdk';
import type {Client} from '@a2a-js/sdk/client';
import {
  AgentExecutionEvent,
  ExecutionEventBus,
  RequestContext,
  ServerCallContext,
} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  AGENT_CARD_PATH,
  BaseAgent,
  createEvent,
  Event,
  getA2AAgentCard,
  InMemoryRunner,
  InvocationContext,
  RemoteA2AAgent,
} from '@google/adk';

class OrderWorkerAgent extends BaseAgent {
  constructor() {
    super({
      name: 'order_worker',
      description: 'Looks up order shipping status.',
    });
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'model',
        parts: [{text: 'Order ORD-42 has shipped.'}],
      },
    });
  }

  protected override async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(ctx);
  }
}

const worker = new OrderWorkerAgent();
const card: AgentCard = await getA2AAgentCard(worker, [
  {
    url: 'http://localhost:8000/jsonrpc',
    protocolBinding: 'JSONRPC',
    protocolVersion: '1.0',
    tenant: '',
  },
]);

const executor = new A2AAgentExecutor({
  runner: new InMemoryRunner({agent: worker, appName: worker.name}),
});

const client = {
  async *sendMessageStream(
    params: SendMessageRequest,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const published: AgentExecutionEvent[] = [];
    const eventBus: ExecutionEventBus = {
      publish(event) {
        published.push(event);
      },
      on() {
        return this;
      },
      off() {
        return this;
      },
      once() {
        return this;
      },
      removeAllListeners() {
        return this;
      },
      finished() {},
    };
    const reqCtx = new RequestContext(
      params,
      params.message?.taskId || 'task-1',
      params.message?.contextId || 'ctx-1',
      new ServerCallContext(),
    );
    await executor.execute(reqCtx, eventBus);
    // The executor publishes `{kind, data}` events; a stream wraps each one
    // in a `StreamResponse` whose payload case has the same name.
    for (const {kind, data} of published) {
      yield {payload: {$case: kind, value: data}} as StreamResponse;
    }
  },
} as unknown as Client;

const remoteAgent = new RemoteA2AAgent({
  name: 'remote_order_worker',
  agentCard: card,
  client,
});
```

To expose an agent over HTTP with Express, pass an authenticator such as `bearerTokenUserBuilder` to `toA2a`:

```ts
import {bearerTokenUserBuilder, toA2a} from '@google/adk';

const token = process.env['A2A_BEARER_TOKEN'];
if (!token) {
  throw new Error('A2A_BEARER_TOKEN is required');
}

const app = await toA2a(worker, {
  host: 'localhost',
  port: 8000,
  authentication: bearerTokenUserBuilder(token),
});
// Serves /.well-known/agent-card.json (AGENT_CARD_PATH), /jsonrpc, and /rest.
```

### Protocol versions

- **Server (`toA2a`)**: the generated card lists four `supportedInterfaces`: JSON-RPC and HTTP+JSON for `protocolVersion: '1.0'`, then the same URLs for `protocolVersion: '0.3'`. The JSON-RPC, REST, and agent card handlers are mounted with `legacyCompat: {enabled: true}`, so an A2A v0.3 client keeps working. A JSON-RPC request is served as v1.0 when it carries the `A2A-Version: 1.0` header, and as v0.3 when the header is absent or `0.3`. The card endpoint returns the v1.0 card to `A2A-Version: 1.0`; otherwise it returns a v0.3 card that also embeds the v1.0 `supportedInterfaces`. A card you pass in `ToA2aOptions.agentCard` decides which versions are served: a request for a version it does not declare is rejected, and when it declares no v0.3 interface the compatibility layer stays off and the card endpoint always returns the v1.0 card.
- **Client (`RemoteA2AAgent`)**: the default client speaks A2A v1.0 when the card declares a v1.0 interface. A card that declares only v0.3 interfaces, including a card in the v0.3 shape (top-level `url`, `protocolVersion`, `additionalInterfaces`), is spoken to through the v0.3 compatibility transports. A `client` or `clientFactory` you supply is used as configured.
- **Executor event order (`A2AAgentExecutor`)**: A2A v1.0 requires a stream to open with a `Task`. The executor publishes the new task, or, for a request that continues a task, a snapshot of it, then a `TASK_STATE_WORKING` update, the artifact updates, and the final status update.

## How it works

### Event and part conversion

When `A2AAgentExecutor` and `RemoteA2AAgent` translate between ADK `Event` objects (`@google/genai` `Part` payloads) and A2A protocol messages, tasks, and artifacts, they preserve ADK semantics using `adk_`-prefixed metadata keys:

- **Text and thoughts**: GenAI `{text}` parts map to A2A text parts (`content: {$case: 'text', value}`, `{"text": ...}` on the wire). When `part.thought` is `true`, the A2A part carries `metadata: {adk_thought: true}`. Empty strings (`{text: ''}`) are preserved as text parts rather than falling through to data parts.
- **Files and video metadata**: GenAI `fileData` (`{fileUri, mimeType}`) maps to an A2A `url` part and `inlineData` (`{data, mimeType}`, base64) to an A2A `raw` part (bytes), with `mimeType` in the part's `mediaType`. If `part.videoMetadata` is present, it is stored under `metadata.adk_video_metadata`.
- **Structured tool and code parts**: GenAI `functionCall`, `functionResponse`, `executableCode`, and `codeExecutionResult` parts map to A2A `data` parts (`content: {$case: 'data', value}`) with `metadata: {adk_type: ...}` using `adk_type` values `'function_call'`, `'function_response'`, `'executable_code'`, and `'code_execution_result'`. When a `data` part arrives without a recognized `adk_type`, or its value is not a JSON object, ADK serializes the value to a JSON text part. Built-in tool declaration schemas and model-facing wire metadata keys (`adk_*`) remain `snake_case` across languages, while TypeScript interfaces and option bags use `camelCase`.
- **Long-running tools and human-in-the-loop pauses**: When a `functionCall` or `functionResponse` ID is listed in `event.longRunningToolIds`, the A2A `data` part is marked with `metadata.adk_is_long_running = true` and the final task status is a pause state. A pending `adk_request_credential` call ends the task in `TASK_STATE_AUTH_REQUIRED`; any other pending long-running call ends it in `TASK_STATE_INPUT_REQUIRED`. The final state follows the priority failed, then auth-required, then input-required, then completed. A2A v1.0 has no `final` flag: a status update in a terminal or pause state ends the turn. `RemoteA2AAgent` treats a task in either pause state as the end of the turn. If a session has an unanswered confirmation or credential request (`adk_request_confirmation`, `adk_request_credential`, or `adk_request_input`), `A2AAgentExecutor` keeps the input-required gate open across subsequent requests in the same `contextId` until the matching `functionResponse` is supplied.
- **Streaming artifact chunks**: During `A2AAgentExecutor.execute`, each ADK event with content is published as a `TaskArtifactUpdateEvent`. Streaming chunks (`event.partial === true`) reuse the same `artifactId` per author with `append: true` and `lastChunk: false`; the non-partial event closes the artifact with `append: false` and `lastChunk: true`. On the client side, `RemoteA2AAgent` aggregates partial chunks and emits the combined non-partial ADK event when `lastChunk: true` arrives.
- **Error status updates**: If any ADK event in the turn carries `errorCode` or `errorMessage`, `A2AAgentExecutor` publishes a final `TaskStatusUpdateEvent` with `state: TASK_STATE_FAILED` and a text message containing `event.errorMessage || event.errorCode`, plus `adk_error_code` and `adk_error_message` in metadata.
- **Task results on the client**: When `RemoteA2AAgent` receives a `Task`, `toAdkEvent` reads the parts of its artifacts and its status message. When neither has parts and the task did not fail, it reads the last `ROLE_AGENT` message in `task.history` instead, and never a `ROLE_USER` message. In a stream, a task that is not yet in a terminal or pause state (the stream's opening task) is read without its artifacts and history, which hold the output of earlier turns. A completed or canceled task with content sets `actions.skipSummarization` to `true` on the event. Long-running calls marked with `adk_is_long_running` are listed in `event.longRunningToolIds` for a `Task`, a `Message`, and each status or artifact update.
- **Runner resolution**: `A2AAgentExecutor` resolves `AgentExecutorConfig.runner` one time, on the first request, and reuses that `Runner` for every later request. A function is called one time, not one time per request, and a `RunnerConfig` builds one `Runner`. When the resolution fails, the next request tries again.
- **Debug request and response logs**: `RemoteA2AAgent` writes one `logger.debug` entry for each outgoing request, after the `beforeRequestCallbacks` run, and one for each response or stream chunk. The entries cut text at 100 characters and summarize large data values. They leave out file bytes, the arguments and response of an `adk_request_credential` call, and the content of `taskPushNotificationConfig`. Message and request metadata are logged in full, so do not put secrets in them when debug logging is on.
- **Request timeout (`timeoutMs`)**: `RemoteA2AAgentConfig.timeoutMs` is the maximum time, in milliseconds, that `RemoteA2AAgent` waits for the response headers of each HTTP request it sends with its own transports. The default is `600000` (10 minutes). It applies to the agent card fetch from an `http://` or `https://` URL and to each message request of the default client factory. It does not bound a response stream that has started, and it does not apply to the message requests of a `client` or `clientFactory` that you supply. The constructor throws for a value that is not a positive finite number.
- **Card description adoption**: When `description` is omitted in `RemoteA2AAgentConfig`, `RemoteA2AAgent` populates `description` from the resolved `AgentCard`. Descriptions fetched over `http://` or `https://` are capped at 1024 characters and enclosed in `<<<BEGIN_QUOTED_AGENT_CONTENT>>>` markers so a peer card cannot inject parent instructions.
- **Error events**: `RemoteA2AAgent` reports a failure as one event with `turnComplete: true` and does not reject the run. When the agent card cannot be resolved or the client cannot be created, `errorMessage` is `Failed to initialize remote A2A agent <name>: <reason>`. When the request fails, `errorMessage` is `A2A request failed: <reason>`, and `customMetadata` holds the same message under `a2a:error` and, when the request was built, the `SendMessageRequest` in its A2A v1.0 JSON form under `a2a:request`. Events relayed from the peer carry `a2a:response` in the same JSON form. A request that exceeds `timeoutMs` gives the reason `Request timed out after <n> ms.`. The remote agent did not see these events, so the next run sends again the session events that came after its last response.

### Security defaults

- **Authentication required by default (`toA2a`)**: `toA2a` fails closed and throws if neither `authentication` (an `A2aUserBuilder` such as `bearerTokenUserBuilder(token)`) nor `allowUnauthenticated: true` is provided. `toA2a` also mounts `express.json({limit: '50mb'})` without `express.urlencoded` so cross-origin HTML form posts cannot trigger endpoints without a CORS preflight.
- **Public card redaction (`getA2AAgentCard`)**: Because `/.well-known/agent-card.json` is a discovery document served without authentication, `getA2AAgentCard` builds skill descriptions from `agent.description` and tool descriptions, never from `instruction` or `globalInstruction` strings or dynamic instruction providers.
- **SSRF, redirect, and origin guards (`ResolveAgentCardOptions`)**: When `toA2a` or `RemoteA2AAgent` loads an `AgentCard` from an `http://` or `https://` URL, ADK refuses link-local addresses (`169.254.0.0/16`, `fe80::/10`), refuses HTTP redirects (`redirect: 'manual'`), requires `https:` (or `http:` on a loopback host) unless `allowInsecureRpc: true` is set in `resolveAgentCardOptions`, and requires every declared RPC URL (each `card.supportedInterfaces[].url`) to share the card's fetch origin unless `allowCrossOriginRpc: true` is set.
- **Peer trust boundary (`RemoteA2AAgent` and `toAdkEvent`)**:
  - `toAdkEvent` always attributes incoming peer events to the local `RemoteA2AAgent.name`, never to `'user'`, even if the peer sends a message with `role: 'user'`.
  - `toAdkEvent` ignores peer-supplied `adk_branch` and `adk_transfer_to_agent` metadata and strips internal `__adk_internal_*` keys from `adk_custom_metadata`, preventing a remote peer from forging conversation branches or hijacking local agent routing.
  - `RemoteA2AAgent` scrubs local `adk_request_credential` function calls and responses before forwarding session history to a remote peer, forwarding a credential response only when every call for that ID in the session was authored by that peer itself.

## Related samples

- [`samples/a2a/`](../../../samples/a2a/README.md) - Builds an `AgentCard`, runs a deterministic worker agent through `A2AAgentExecutor`, and consumes the A2A event stream through `RemoteA2AAgent` offline.
