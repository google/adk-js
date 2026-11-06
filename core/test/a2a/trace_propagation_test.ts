/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {context, ROOT_CONTEXT, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {createServer, type Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from '@a2a-js/sdk/client';
import {
  Event as AdkEvent,
  BaseAgent,
  createEvent,
  createSession,
  FunctionTool,
  InvocationContext,
  PluginManager,
  RemoteA2AAgent,
} from '@google/adk';
import {getA2AAgentCard} from '../../src/a2a/agent_card.js';
import {toA2a} from '../../src/a2a/agent_to_a2a.js';
import {
  recordToolExecution,
  wrapFetchWithTraceContext,
} from '../../src/telemetry/api/instrumentation.js';

class EchoCalleeAgent extends BaseAgent {
  capturedContext?: InvocationContext;

  constructor(name = 'callee-agent') {
    super({name});
  }

  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    this.capturedContext = ctx;
    yield createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      content: {role: 'model', parts: [{text: 'Echo response from callee'}]},
      turnComplete: true,
    });
  }

  protected async *runLiveImpl(
    _ctx: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    yield createEvent({author: this.name});
  }
}

const spanExporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});

describe('A2A trace context propagation', () => {
  let activeServers: Server[] = [];

  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(tracerProvider);
  });

  afterAll(() => {
    contextManager.disable();
  });

  beforeEach(() => {
    spanExporter.reset();
  });

  afterEach(async () => {
    for (const server of activeServers) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    activeServers = [];
  });

  async function startServer(
    agent: BaseAgent,
    preferredTransport: 'JSONRPC' | 'HTTP+JSON' = 'JSONRPC',
  ): Promise<{
    server: Server;
    port: number;
    cardUrl: string;
  }> {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const rpcUrl = `http://127.0.0.1:${port}`;
    const transports =
      preferredTransport === 'HTTP+JSON'
        ? [
            {url: `${rpcUrl}/rest`, transport: 'HTTP+JSON'},
            {url: `${rpcUrl}/jsonrpc`, transport: 'JSONRPC'},
          ]
        : [
            {url: `${rpcUrl}/jsonrpc`, transport: 'JSONRPC'},
            {url: `${rpcUrl}/rest`, transport: 'HTTP+JSON'},
          ];
    const card = await getA2AAgentCard(agent, transports);
    const app = await toA2a(agent, {
      allowUnauthenticated: true,
      port,
      host: '127.0.0.1',
      agentCard: card,
    });
    server.on('request', app);
    activeServers.push(server);
    const cardUrl = `http://127.0.0.1:${port}`;
    return {server, port, cardUrl};
  }

  function createCallerContext(agent: BaseAgent): InvocationContext {
    const session = createSession({
      appName: 'caller-app',
      userId: 'caller-user',
      id: 'caller-session',
    });
    session.events.push(
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'Hello from caller'}]},
      }),
    );
    return new InvocationContext({
      session,
      invocationId: 'caller-inv-1',
      agent,
      pluginManager: new PluginManager([]),
    });
  }

  it('produces one connected trace where the callee root span is a child of the caller agent span', async () => {
    const callee = new EchoCalleeAgent('echo-callee');
    const {cardUrl} = await startServer(callee);

    const callerAgent = new RemoteA2AAgent({
      name: 'remote-caller',
      agentCard: cardUrl,
    });

    const tracer = trace.getTracer('test-caller');
    const callerSpan = tracer.startSpan('caller-agent-span');
    const callerContext = trace.setSpan(context.active(), callerSpan);

    const invocationContext = createCallerContext(callerAgent);

    await context.with(callerContext, async () => {
      const events: AdkEvent[] = [];
      for await (const event of callerAgent.runAsync(invocationContext)) {
        events.push(event);
      }
      expect(events.length).toBeGreaterThan(0);
      callerSpan.end();
    });

    const finishedSpans = spanExporter.getFinishedSpans();
    const finishedCallerSpan = finishedSpans.find(
      (s: ReadableSpan) => s.name === 'caller-agent-span',
    );
    expect(finishedCallerSpan).toBeDefined();

    const callerAgentSpan = finishedSpans.find(
      (s: ReadableSpan) => s.name === 'invoke_agent remote-caller',
    );
    expect(callerAgentSpan).toBeDefined();

    const calleeWorkflowSpan = finishedSpans.find(
      (s: ReadableSpan) => s.name === 'invoke_workflow echo-callee',
    );
    expect(calleeWorkflowSpan).toBeDefined();

    expect(callee.capturedContext).toBeDefined();
    expect(callee.capturedContext?.runConfig?.remoteParent).toBe(
      `00-${callerAgentSpan?.spanContext().traceId}-${callerAgentSpan?.spanContext().spanId}-01`,
    );

    // Verify both spans share the same trace ID and the callee is parented to the caller agent span
    expect(calleeWorkflowSpan?.spanContext().traceId).toBe(
      finishedCallerSpan?.spanContext().traceId,
    );
    expect(calleeWorkflowSpan?.parentSpanContext?.spanId).toBe(
      callerAgentSpan?.spanContext().spanId,
    );
  });

  it('connects distributed trace over REST transport round trip', async () => {
    const callee = new EchoCalleeAgent('rest-callee');
    const {cardUrl} = await startServer(callee, 'HTTP+JSON');

    const callerAgent = new RemoteA2AAgent({
      name: 'rest-caller',
      agentCard: cardUrl,
    });

    const tracer = trace.getTracer('test-caller');
    const callerSpan = tracer.startSpan('rest-caller-span');
    const callerContext = trace.setSpan(context.active(), callerSpan);

    const invocationContext = createCallerContext(callerAgent);

    await context.with(callerContext, async () => {
      const events: AdkEvent[] = [];
      for await (const event of callerAgent.runAsync(invocationContext)) {
        events.push(event);
      }
      expect(events.length).toBeGreaterThan(0);
      callerSpan.end();
    });

    const finishedSpans = spanExporter.getFinishedSpans();
    const finishedCallerSpan = finishedSpans.find(
      (s: ReadableSpan) => s.name === 'rest-caller-span',
    );
    expect(finishedCallerSpan).toBeDefined();

    const callerAgentSpan = finishedSpans.find(
      (s: ReadableSpan) => s.name === 'invoke_agent rest-caller',
    );
    expect(callerAgentSpan).toBeDefined();

    const calleeWorkflowSpan = finishedSpans.find(
      (s: ReadableSpan) => s.name === 'invoke_workflow rest-callee',
    );
    expect(calleeWorkflowSpan).toBeDefined();

    expect(calleeWorkflowSpan?.spanContext().traceId).toBe(
      finishedCallerSpan?.spanContext().traceId,
    );
    expect(calleeWorkflowSpan?.parentSpanContext?.spanId).toBe(
      callerAgentSpan?.spanContext().spanId,
    );
  });

  it('preserves trace connection during streaming round trips', async () => {
    const callee = new EchoCalleeAgent('streaming-callee');
    const {cardUrl} = await startServer(callee);

    const callerAgent = new RemoteA2AAgent({
      name: 'streaming-caller',
      agentCard: cardUrl,
    });

    const tracer = trace.getTracer('test-caller');
    const callerSpan = tracer.startSpan('streaming-caller-span');
    const callerContext = trace.setSpan(context.active(), callerSpan);

    const invocationContext = createCallerContext(callerAgent);

    await context.with(callerContext, async () => {
      const events: AdkEvent[] = [];
      for await (const event of callerAgent.runAsync(invocationContext)) {
        events.push(event);
      }
      expect(events.length).toBeGreaterThan(0);
      callerSpan.end();
    });

    const finishedSpans = spanExporter.getFinishedSpans();
    const finishedCallerSpan = finishedSpans.find(
      (s: ReadableSpan) => s.name === 'streaming-caller-span',
    );
    expect(finishedCallerSpan).toBeDefined();

    const callerAgentSpan = finishedSpans.find(
      (s: ReadableSpan) => s.name === 'invoke_agent streaming-caller',
    );
    expect(callerAgentSpan).toBeDefined();

    const calleeWorkflowSpan = finishedSpans.find(
      (s: ReadableSpan) => s.name === 'invoke_workflow streaming-callee',
    );
    expect(calleeWorkflowSpan).toBeDefined();

    expect(calleeWorkflowSpan?.spanContext().traceId).toBe(
      finishedCallerSpan?.spanContext().traceId,
    );
    expect(calleeWorkflowSpan?.parentSpanContext?.spanId).toBe(
      callerAgentSpan?.spanContext().spanId,
    );
  });

  it('parents the callee root span to the caller tool span when executed from a tool', async () => {
    const callee = new EchoCalleeAgent('tool-callee');
    const {cardUrl} = await startServer(callee);

    const callerAgent = new RemoteA2AAgent({
      name: 'tool-caller',
      agentCard: cardUrl,
    });

    const invocationContext = createCallerContext(callerAgent);

    const tool = new FunctionTool({
      name: 'a2a_agent_tool',
      description: 'A tool that delegates to an A2A agent',
      execute: async () => 'result',
    });

    await recordToolExecution(
      {
        tool,
        args: {query: 'test'},
        invocationContext,
      },
      async () => {
        const events: AdkEvent[] = [];
        for await (const event of callerAgent.runAsync(invocationContext)) {
          events.push(event);
        }
        expect(events.length).toBeGreaterThan(0);
      },
    );

    const finishedSpans = spanExporter.getFinishedSpans();
    const toolSpan = finishedSpans.find(
      (s: ReadableSpan) => s.name === 'execute_tool a2a_agent_tool',
    );
    expect(toolSpan).toBeDefined();

    const callerAgentSpan = finishedSpans.find(
      (s: ReadableSpan) => s.name === 'invoke_agent tool-caller',
    );
    expect(callerAgentSpan).toBeDefined();

    const calleeWorkflowSpan = finishedSpans.find(
      (s: ReadableSpan) => s.name === 'invoke_workflow tool-callee',
    );
    expect(calleeWorkflowSpan).toBeDefined();

    expect(calleeWorkflowSpan?.spanContext().traceId).toBe(
      toolSpan?.spanContext().traceId,
    );
    expect(callerAgentSpan?.parentSpanContext?.spanId).toBe(
      toolSpan?.spanContext().spanId,
    );
    expect(calleeWorkflowSpan?.parentSpanContext?.spanId).toBe(
      callerAgentSpan?.spanContext().spanId,
    );
  });

  it('succeeds with an independent callee trace when no active trace exists', async () => {
    const callee = new EchoCalleeAgent('notrace-callee');
    const {port} = await startServer(callee);

    const factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [
          new JsonRpcTransportFactory({
            fetchImpl: wrapFetchWithTraceContext(),
          }),
          new RestTransportFactory({
            fetchImpl: wrapFetchWithTraceContext(),
          }),
        ],
      }),
    );
    const cardResolver = new DefaultAgentCardResolver();
    const card = await cardResolver.resolve(`http://127.0.0.1:${port}`);
    const client = await factory.createFromAgentCard(card);

    await context.with(ROOT_CONTEXT, async () => {
      const res = await client.sendMessage({
        message: {
          kind: 'message',
          messageId: 'msg-notrace-1',
          role: 'user',
          parts: [{kind: 'text', text: 'Hello without trace'}],
        },
      });
      expect(res).toBeDefined();
    });

    const finishedSpans = spanExporter.getFinishedSpans();
    const calleeWorkflowSpan = finishedSpans.find(
      (s: ReadableSpan) => s.name === 'invoke_workflow notrace-callee',
    );
    expect(calleeWorkflowSpan).toBeDefined();
    // With no active caller trace, callee root span has no parent span context
    expect(calleeWorkflowSpan?.parentSpanContext).toBeUndefined();
  });

  it('ignores malformed inbound traceparent headers and starts a fresh trace', async () => {
    const callee = new EchoCalleeAgent('malformed-callee');
    const {port} = await startServer(callee);

    const res = await fetch(`http://127.0.0.1:${port}/rest/v1/message:send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        traceparent: 'malformed-traceparent-invalid-header',
      },
      body: JSON.stringify({
        message: {
          messageId: 'msg-malformed-1',
          role: 'ROLE_USER',
          content: [{text: 'Hello with malformed header'}],
        },
      }),
    });

    expect(res.status).toBe(201);
    const finishedSpans = spanExporter.getFinishedSpans();
    const calleeWorkflowSpan = finishedSpans.find(
      (s: ReadableSpan) => s.name === 'invoke_workflow malformed-callee',
    );
    expect(calleeWorkflowSpan).toBeDefined();
    expect(calleeWorkflowSpan?.parentSpanContext).toBeUndefined();
  });
});
