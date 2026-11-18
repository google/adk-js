/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {AgentCard} from '@a2a-js/sdk';
import {ClientFactory} from '@a2a-js/sdk/client';
import {
  AgentTool,
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  Event,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  runWithAgentEngineContext,
} from '@google/adk';
import {context, propagation, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {W3CTraceContextPropagator} from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import express from 'express';
import {createServer, type IncomingHttpHeaders, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {RemoteA2AAgent} from '../../src/a2a/a2a_remote_agent.js';
import {toA2a} from '../../src/a2a/agent_to_a2a.js';

const CALLEE = 'peer';
const CALLER = 'remote_peer';
const CALLEE_ROOT = `invoke_workflow ${CALLEE}`;
const CALLER_AGENT = `invoke_agent ${CALLER}`;
const TRACE_A = '0af7651916cd43dd8448eb211c80319c';
const SPAN_A = 'b7ad6b7169203331';
const TRACE_B = '11111111111111111111111111111111';
const SPAN_B = '2222222222222222';

const spanExporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(tracerProvider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

afterAll(async () => {
  await tracerProvider.shutdown();
  trace.disable();
  propagation.disable();
  context.disable();
  contextManager.disable();
});

/** A callee that answers once, after an optional delay. */
class PeerAgent extends BaseAgent {
  constructor(private readonly delayMillis = 0) {
    super({name: CALLEE, description: 'Answers pings.'});
  }

  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    if (this.delayMillis > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMillis));
    }
    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'pong'}]},
    });
  }

  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {}
}

/** Calls the remote agent tool once, then answers. */
class ToolCallingLlm extends BaseLlm {
  constructor() {
    super({model: 'tool-calling-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const last = request.contents[request.contents.length - 1];
    if (last.parts?.some((part) => part.functionResponse)) {
      yield {content: {role: 'model', parts: [{text: 'done'}]}};
      return;
    }
    yield {
      content: {
        role: 'model',
        parts: [{functionCall: {name: CALLER, args: {request: 'ping'}}}],
      },
    };
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not supported.');
  }
}

interface ServedPeer {
  readonly baseUrl: string;
  readonly card: AgentCard;
  /** Headers of every request the server received, in order. */
  readonly requests: Array<{url?: string; headers: IncomingHttpHeaders}>;
}

let server: Server | undefined;

/** Serves `agent` with `toA2a` on a loopback port. */
async function servePeer({
  agent = new PeerAgent(),
  app,
}: {agent?: BaseAgent; app?: express.Application} = {}): Promise<ServedPeer> {
  const httpServer = createServer();
  server = httpServer;
  httpServer.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => httpServer.once('listening', resolve));
  const {port} = httpServer.address() as AddressInfo;
  const served = await toA2a(agent, {
    host: '127.0.0.1',
    port,
    app,
    allowUnauthenticated: true,
  });
  const requests: ServedPeer['requests'] = [];
  httpServer.on('request', (req) => {
    requests.push({url: req.url, headers: req.headers});
  });
  httpServer.on('request', served);
  const baseUrl = `http://127.0.0.1:${port}`;
  const card = (await (
    await fetch(`${baseUrl}/.well-known/agent-card.json`)
  ).json()) as AgentCard;
  requests.length = 0;
  return {baseUrl, card, requests};
}

afterEach(async () => {
  spanExporter.reset();
  const httpServer = server;
  server = undefined;
  if (!httpServer) {
    return;
  }
  httpServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
});

/** Returns the card with `transport` as its preferred transport. */
function withTransport(
  card: AgentCard,
  transport: 'JSONRPC' | 'HTTP+JSON',
  streaming: boolean,
): AgentCard {
  const url = card.additionalInterfaces?.find(
    (entry) => entry.transport === transport,
  )?.url;
  if (!url) {
    return expect.fail(`The card has no ${transport} interface.`);
  }
  return {
    ...card,
    url,
    preferredTransport: transport,
    capabilities: {...card.capabilities, streaming},
  };
}

async function runCaller(agent: BaseAgent): Promise<void> {
  const runner = new InMemoryRunner({agent, appName: 'caller-app'});
  const session = await runner.sessionService.createSession({
    appName: 'caller-app',
    userId: 'user-1',
  });
  for await (const _ of runner.runAsync({
    userId: 'user-1',
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'ping'}]},
  })) {
    // Drain the run.
  }
}

function spansNamed(name: string): ReadableSpan[] {
  return spanExporter.getFinishedSpans().filter((span) => span.name === name);
}

function onlySpan(name: string): ReadableSpan {
  const spans = spansNamed(name);
  expect(spans).toHaveLength(1);
  return spans[0];
}

/** Waits until `count` callee root spans have ended, and returns them. */
async function calleeRoots(count = 1): Promise<ReadableSpan[]> {
  await vi.waitFor(() => expect(spansNamed(CALLEE_ROOT)).toHaveLength(count));
  return spansNamed(CALLEE_ROOT);
}

/** Returns whether `ancestor` is on the parent chain of `span`. */
function isDescendantOf(span: ReadableSpan, ancestor: ReadableSpan): boolean {
  const byId = new Map(
    spanExporter
      .getFinishedSpans()
      .map((candidate) => [candidate.spanContext().spanId, candidate]),
  );
  let parentId = span.parentSpanContext?.spanId;
  while (parentId) {
    if (parentId === ancestor.spanContext().spanId) {
      return true;
    }
    parentId = byId.get(parentId)?.parentSpanContext?.spanId;
  }
  return false;
}

function expectChildOf(span: ReadableSpan, parent: ReadableSpan): void {
  expect(span.spanContext().traceId).toBe(parent.spanContext().traceId);
  expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  expect(span.attributes).not.toHaveProperty('supportID');
}

/** Sends a raw JSON-RPC `message/send` request. */
async function sendRaw(
  baseUrl: string,
  {
    headers = {},
    blocking = true,
  }: {headers?: Record<string, string>; blocking?: boolean} = {},
): Promise<Response> {
  return fetch(`${baseUrl}/jsonrpc`, {
    method: 'POST',
    headers: {'content-type': 'application/json', ...headers},
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: crypto.randomUUID(),
          role: 'user',
          parts: [{kind: 'text', text: 'ping'}],
        },
        configuration: {blocking},
      },
    }),
  });
}

async function expectSuccess(response: Response): Promise<void> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as {result?: unknown; error?: unknown};
  expect(body.error).toBeUndefined();
  expect(body.result).toBeDefined();
}

describe('A2A trace context propagation', () => {
  describe.each(['JSONRPC', 'HTTP+JSON'] as const)('over %s', (transport) => {
    it.each([
      {mode: 'a unary request', streaming: false},
      {mode: 'a streaming request', streaming: true},
    ])(
      'parents the callee root span on the caller agent span for $mode',
      async ({streaming}) => {
        const {card} = await servePeer();

        await runCaller(
          new RemoteA2AAgent({
            name: CALLER,
            agentCard: withTransport(card, transport, streaming),
          }),
        );

        const [calleeRoot] = await calleeRoots();
        expectChildOf(calleeRoot, onlySpan(CALLER_AGENT));
        const traceIds = new Set(
          spanExporter
            .getFinishedSpans()
            .map((span) => span.spanContext().traceId),
        );
        expect(traceIds.size).toBe(1);
      },
    );
  });

  it('parents the callee root span on the agent span under the tool span', async () => {
    const {card} = await servePeer();
    const remote = new RemoteA2AAgent({
      name: CALLER,
      description: 'Remote peer.',
      agentCard: card,
    });

    await runCaller(
      new LlmAgent({
        name: 'orchestrator',
        model: new ToolCallingLlm(),
        tools: [new AgentTool({agent: remote})],
      }),
    );

    const [calleeRoot] = await calleeRoots();
    const callerAgent = onlySpan(CALLER_AGENT);
    expectChildOf(calleeRoot, callerAgent);
    expect(
      isDescendantOf(callerAgent, onlySpan(`execute_tool ${CALLER}`)),
    ).toBe(true);
  });

  it('sends the trace context with the agent card request', async () => {
    const {baseUrl, requests} = await servePeer();

    await runCaller(
      new RemoteA2AAgent({name: CALLER, agentCard: `${baseUrl}/`}),
    );

    const cardRequest = requests.find((request) =>
      request.url?.endsWith('/.well-known/agent-card.json'),
    );
    const callerAgent = onlySpan(CALLER_AGENT);
    expect(cardRequest?.headers['traceparent']).toBe(
      `00-${callerAgent.spanContext().traceId}-${callerAgent.spanContext().spanId}-01`,
    );
    expectChildOf((await calleeRoots())[0], callerAgent);
  });

  it('sends no trace context from a client the caller supplies', async () => {
    const {card} = await servePeer();

    await runCaller(
      new RemoteA2AAgent({
        name: CALLER,
        agentCard: card,
        clientFactory: new ClientFactory(),
      }),
    );

    const [calleeRoot] = await calleeRoots();
    expect(calleeRoot.parentSpanContext).toBeUndefined();
    expect(calleeRoot.spanContext().traceId).not.toBe(
      onlySpan(CALLER_AGENT).spanContext().traceId,
    );
  });

  it('continues the trace of a non-blocking message/send', async () => {
    const {baseUrl} = await servePeer({agent: new PeerAgent(50)});

    await expectSuccess(
      await sendRaw(baseUrl, {
        blocking: false,
        headers: {traceparent: `00-${TRACE_A}-${SPAN_A}-01`},
      }),
    );

    const [calleeRoot] = await calleeRoots();
    expect(calleeRoot.spanContext().traceId).toBe(TRACE_A);
    expect(calleeRoot.parentSpanContext?.spanId).toBe(SPAN_A);
    expect(calleeRoot.parentSpanContext?.isRemote).toBe(true);
  });

  it('starts a new trace for a request without trace context', async () => {
    const {baseUrl} = await servePeer();

    await expectSuccess(await sendRaw(baseUrl));

    const [calleeRoot] = await calleeRoots();
    expect(calleeRoot.parentSpanContext).toBeUndefined();
    expect(calleeRoot.attributes).not.toHaveProperty('supportID');
  });

  it.each([
    {kind: 'free text', value: 'garbage'},
    {kind: 'an all-zero trace id', value: `00-${'0'.repeat(32)}-${SPAN_A}-01`},
    {kind: 'version ff', value: `ff-${TRACE_A}-${SPAN_A}-01`},
  ])(
    'serves a request whose traceparent has $kind in a new trace',
    async ({value}) => {
      const {baseUrl} = await servePeer();

      await expectSuccess(
        await sendRaw(baseUrl, {headers: {traceparent: value}}),
      );

      const [calleeRoot] = await calleeRoots();
      expect(calleeRoot.parentSpanContext).toBeUndefined();
      expect(calleeRoot.spanContext().traceId).not.toBe(TRACE_A);
    },
  );

  it('keeps concurrent requests in their own traces', async () => {
    const {baseUrl} = await servePeer({agent: new PeerAgent(20)});

    const responses = await Promise.all([
      sendRaw(baseUrl, {headers: {traceparent: `00-${TRACE_A}-${SPAN_A}-01`}}),
      sendRaw(baseUrl, {headers: {traceparent: `00-${TRACE_B}-${SPAN_B}-01`}}),
    ]);
    await Promise.all(responses.map(expectSuccess));

    const parents = new Map(
      (await calleeRoots(2)).map((span) => [
        span.spanContext().traceId,
        span.parentSpanContext?.spanId,
      ]),
    );
    expect(parents).toEqual(
      new Map([
        [TRACE_A, SPAN_A],
        [TRACE_B, SPAN_B],
      ]),
    );
  });

  it('keeps a remote parent set earlier by runWithAgentEngineContext', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      runWithAgentEngineContext(req.headers, next);
    });
    const {baseUrl} = await servePeer({app});

    await expectSuccess(
      await sendRaw(baseUrl, {
        headers: {
          'google-agent-engine-traceparent': `00-${TRACE_A}-${SPAN_A}-01`,
          'traceparent': `00-${TRACE_B}-${SPAN_B}-01`,
        },
      }),
    );

    const [calleeRoot] = await calleeRoots();
    expect(calleeRoot.spanContext().traceId).toBe(TRACE_A);
    expect(calleeRoot.parentSpanContext?.spanId).toBe(SPAN_A);
  });
});
