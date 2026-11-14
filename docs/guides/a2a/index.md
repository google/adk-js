# A2A (Agent-to-Agent)

The `@google/adk/a2a` subpath (also re-exported from `@google/adk`) connects ADK agents to the Agent-to-Agent (A2A) protocol. It lets you publish an ADK agent as an A2A server (`toA2a`, `getA2AAgentCard`, `A2AAgentExecutor`, `bearerTokenUserBuilder`, `AdkDefaultRequestHandler`, `getA2aRequestMetadata`) and invoke remote A2A agents from an ADK workflow (`RemoteA2AAgent`, `AGENT_CARD_PATH`).

## Introduction

| Export                                                                                                                                                                     | Kind                      | Purpose                                                                                                                                                                                |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toA2a` / `ToA2aOptions`                                                                                                                                                   | Function / Interface      | Mounts an ADK agent on an Express application with `/.well-known/agent-card.json`, `/jsonrpc`, and `/rest` endpoints.                                                                  |
| `bearerTokenUserBuilder` / `A2aUserBuilder`                                                                                                                                | Function / Type           | Constant-time shared-secret `Authorization: Bearer <token>` authenticator for `toA2a`.                                                                                                 |
| `getA2AAgentCard`                                                                                                                                                          | Function                  | Builds an A2A `AgentCard` from an ADK agent and an optional list of transports.                                                                                                        |
| `ResolveAgentCardOptions`                                                                                                                                                  | Interface                 | Configures origin and scheme validation when an agent card is fetched from a URL. Pass it as `ToA2aOptions.resolveAgentCardOptions` or `RemoteA2AAgentConfig.resolveAgentCardOptions`. |
| `A2AAgentExecutor` / `AgentExecutorConfig` / `ExecutorContext`                                                                                                             | Class / Interfaces        | Implements `@a2a-js/sdk`'s `AgentExecutor` by running an ADK `Runner` and publishing A2A task, artifact, and status events.                                                            |
| `AdkDefaultRequestHandler` / `getA2aRequestMetadata`                                                                                                                       | Class / Function          | Preserves incoming `MessageSendParams.metadata` across A2A requests and exposes it on `ExecutorContext.a2aMetadata` and `InvocationContext.a2aMetadata`.                               |
| `RemoteA2AAgent` / `RemoteA2AAgentConfig` / `AGENT_CARD_PATH`                                                                                                              | Class / Interface / Const | `BaseAgent` subclass that delegates execution to a remote A2A server over streaming or non-streaming transport and converts responses back into ADK `Event` objects.                   |
| `A2AStreamEventData`, `BeforeA2ARequestCallback`, `AfterA2ARequestCallback`, `BeforeExecuteCallback`, `AfterEventCallback`, `AfterExecuteCallback`, `RunnerOrRunnerConfig` | Types                     | Lifecycle callback and configuration types for `RemoteA2AAgent` and `A2AAgentExecutor`.                                                                                                |

## Get started

The example below builds an `AgentCard` for a deterministic ADK agent, executes the agent through `A2AAgentExecutor` into an in-memory event bus, and streams those A2A events back into ADK `Event` objects through `RemoteA2AAgent`. It runs offline without network sockets or API keys.

```ts
import type {AgentCard, MessageSendParams} from '@a2a-js/sdk';
import type {Client} from '@a2a-js/sdk/client';
import {ExecutionEventBus, RequestContext} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  A2AStreamEventData,
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
  {url: 'http://localhost:8000/jsonrpc', transport: 'JSONRPC'},
]);

const executor = new A2AAgentExecutor({
  runner: new InMemoryRunner({agent: worker, appName: worker.name}),
});

const client = {
  async *sendMessageStream(
    params: MessageSendParams,
  ): AsyncGenerator<A2AStreamEventData, void, undefined> {
    const published: A2AStreamEventData[] = [];
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
      params.message,
      params.message.taskId ?? 'task-1',
      params.message.contextId ?? 'ctx-1',
    );
    await executor.execute(reqCtx, eventBus);
    for (const item of published) {
      yield item;
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

## How it works

### Event and part conversion

When `A2AAgentExecutor` and `RemoteA2AAgent` translate between ADK `Event` objects (`@google/genai` `Part` payloads) and A2A protocol messages, tasks, and artifacts, they preserve ADK semantics using `adk_`-prefixed metadata keys:

- **Text and thoughts**: GenAI `{text}` parts map to A2A `{kind: 'text', text}` parts. When `part.thought` is `true`, the A2A part carries `metadata: {adk_thought: true}`. Empty strings (`{text: ''}`) are preserved as text parts rather than falling through to data parts.
- **Files and video metadata**: GenAI `fileData` (`{fileUri, mimeType}`) and `inlineData` (`{data, mimeType}`) map to A2A `{kind: 'file', file: {uri | bytes, mimeType}}` parts. If `part.videoMetadata` is present, it is stored under `metadata.adk_video_metadata`.
- **Structured tool and code parts**: GenAI `functionCall`, `functionResponse`, `executableCode`, and `codeExecutionResult` parts map to A2A `{kind: 'data', data, metadata: {adk_type: ...}}` parts using `adk_type` values `'function_call'`, `'function_response'`, `'executable_code'`, and `'code_execution_result'`. When a `DataPart` arrives without a recognized `adk_type`, ADK serializes `data` to a JSON text part (`{text: JSON.stringify(part.data)}`). Built-in tool declaration schemas and model-facing wire metadata keys (`adk_*`) remain `snake_case` across languages, while TypeScript interfaces and option bags use `camelCase`.
- **Long-running tools and human-in-the-loop pauses**: When a `functionCall` or `functionResponse` ID is listed in `event.longRunningToolIds`, the A2A `DataPart` is marked with `metadata.adk_is_long_running = true` and the final task status is a pause state. A pending `adk_request_credential` call ends the task in `auth-required`; any other pending long-running call ends it in `input-required`. The final state follows the priority `failed`, then `auth-required`, then `input-required`, then `completed`. `RemoteA2AAgent` treats a task in either pause state as the end of the turn. If a session has an unanswered confirmation or credential request (`adk_request_confirmation`, `adk_request_credential`, or `adk_request_input`), `A2AAgentExecutor` keeps the `input-required` gate open across subsequent requests in the same `contextId` until the matching `functionResponse` is supplied.
- **Streaming artifact chunks**: During `A2AAgentExecutor.execute`, each ADK event with content is published as a `TaskArtifactUpdateEvent`. Streaming chunks (`event.partial === true`) reuse the same `artifactId` per author with `append: true` and `lastChunk: false`; the non-partial event closes the artifact with `append: false` and `lastChunk: true`. On the client side, `RemoteA2AAgent` aggregates partial chunks and emits the combined non-partial ADK event when `lastChunk: true` arrives.
- **Error status updates**: If any ADK event in the turn carries `errorCode` or `errorMessage`, `A2AAgentExecutor` publishes a final `TaskStatusUpdateEvent` with `state: 'failed'` and a text message containing `event.errorMessage || event.errorCode`, plus `adk_error_code` and `adk_error_message` in metadata.
- **Task results on the client**: When `RemoteA2AAgent` receives a `Task`, `toAdkEvent` reads the parts of its artifacts and its status message. When neither has parts and the task did not fail, it reads the last `agent` message in `task.history` instead, and never a `user` message. A `completed` or `canceled` task with content sets `actions.skipSummarization` to `true` on the event. Long-running calls marked with `adk_is_long_running` are listed in `event.longRunningToolIds` for a `Task`, a `Message`, and each status or artifact update.
- **Runner resolution**: `A2AAgentExecutor` resolves `AgentExecutorConfig.runner` one time, on the first request, and reuses that `Runner` for every later request. A function is called one time, not one time per request, and a `RunnerConfig` builds one `Runner`. When the resolution fails, the next request tries again.
- **Debug request and response logs**: `RemoteA2AAgent` writes one `logger.debug` entry for each outgoing request, after the `beforeRequestCallbacks` run, and one for each response or stream chunk. The entries cut text at 100 characters and summarize large data values. They leave out file bytes, the arguments and response of an `adk_request_credential` call, and the content of `pushNotificationConfig`. Message and request metadata are logged in full, so do not put secrets in them when debug logging is on.

### Security defaults

- **Authentication required by default (`toA2a`)**: `toA2a` fails closed and throws if neither `authentication` (an `A2aUserBuilder` such as `bearerTokenUserBuilder(token)`) nor `allowUnauthenticated: true` is provided. `toA2a` also mounts `express.json({limit: '50mb'})` without `express.urlencoded` so cross-origin HTML form posts cannot trigger endpoints without a CORS preflight.
- **Public card redaction (`getA2AAgentCard`)**: Because `/.well-known/agent-card.json` is a discovery document served without authentication, `getA2AAgentCard` builds skill descriptions from `agent.description` and tool descriptions, never from `instruction` or `globalInstruction` strings or dynamic instruction providers.
- **SSRF, redirect, and origin guards (`ResolveAgentCardOptions`)**: When `toA2a` or `RemoteA2AAgent` loads an `AgentCard` from an `http://` or `https://` URL, ADK refuses link-local addresses (`169.254.0.0/16`, `fe80::/10`), refuses HTTP redirects (`redirect: 'manual'`), requires `https:` (or `http:` on a loopback host) unless `allowInsecureRpc: true` is set in `resolveAgentCardOptions`, and requires every declared RPC URL (`card.url` and `card.additionalInterfaces`) to share the card's fetch origin unless `allowCrossOriginRpc: true` is set.
- **Peer trust boundary (`RemoteA2AAgent` and `toAdkEvent`)**:
  - `toAdkEvent` always attributes incoming peer events to the local `RemoteA2AAgent.name`, never to `'user'`, even if the peer sends a message with `role: 'user'`.
  - `toAdkEvent` ignores peer-supplied `adk_branch` and `adk_transfer_to_agent` metadata and strips internal `__adk_internal_*` keys from `adk_custom_metadata`, preventing a remote peer from forging conversation branches or hijacking local agent routing.
  - `RemoteA2AAgent` scrubs local `adk_request_credential` function calls and responses before forwarding session history to a remote peer, forwarding a credential response only when every call for that ID in the session was authored by that peer itself.

## Related samples

- [`samples/a2a/`](../../../samples/a2a/README.md) - Builds an `AgentCard`, runs a deterministic worker agent through `A2AAgentExecutor`, and consumes the A2A event stream through `RemoteA2AAgent` offline.
