/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A2A: AgentCard generation, A2AAgentExecutor, and RemoteA2AAgent
 * ../../docs/guides/a2a/index.md
 *
 * A deterministic `BaseAgent` that exercises the A2A surface end to end in
 * memory without calling a live model or opening a network socket:
 * - `getA2AAgentCard` builds the `AgentCard` for a worker agent.
 * - `A2AAgentExecutor` runs the worker agent through `InMemoryRunner` and
 *   converts its tool-call, tool-response, and text `Event` objects into A2A
 *   `Task`, `TaskArtifactUpdateEvent`, and `TaskStatusUpdateEvent` payloads.
 * - `RemoteA2AAgent` consumes that A2A stream via an in-memory `Client` and
 *   reconstructs ADK `Event` objects on the caller side.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/a2a/agent.ts
 */

import type {MessageSendParams} from '@a2a-js/sdk';
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
  getFunctionCalls,
  getFunctionResponses,
  InMemoryRunner,
  InvocationContext,
  RemoteA2AAgent,
  stringifyContent,
} from '@google/adk';

class OrderStatusWorkerAgent extends BaseAgent {
  constructor() {
    super({
      name: 'order_status_worker',
      description: 'Looks up shipping status for an order.',
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
        parts: [
          {
            functionCall: {
              id: 'call-order-42',
              name: 'fetchOrderStatus',
              args: {orderId: 'ORD-42'},
            },
          },
        ],
      },
    });

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-order-42',
              name: 'fetchOrderStatus',
              response: {orderId: 'ORD-42', status: 'SHIPPED'},
            },
          },
        ],
      },
    });

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'model',
        parts: [{text: 'Order ORD-42 has status SHIPPED.'}],
      },
    });
  }

  protected override async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(ctx);
  }
}

/**
 * Creates an in-memory A2A `Client` backed directly by `executor.execute(...)`
 * so `RemoteA2AAgent` can stream A2A events without binding a network port.
 */
function createInMemoryA2AClient(
  executor: A2AAgentExecutor,
  recordedA2AEvents: A2AStreamEventData[],
): Client {
  const streamAdapter = {
    async *sendMessageStream(
      params: MessageSendParams,
    ): AsyncGenerator<A2AStreamEventData, void, undefined> {
      const busEvents: A2AStreamEventData[] = [];
      const eventBus: ExecutionEventBus = {
        publish(event) {
          busEvents.push(event);
          recordedA2AEvents.push(event);
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
      const requestContext = new RequestContext(
        params.message,
        params.message.taskId ?? 'task-ord-42',
        params.message.contextId ?? 'ctx-ord-42',
      );

      await executor.execute(requestContext, eventBus);
      for (const item of busEvents) {
        yield item;
      }
    },
  };
  return streamAdapter as unknown as Client;
}

class A2AShowcaseAgent extends BaseAgent {
  constructor() {
    super({
      name: 'a2a_showcase_agent',
      description:
        'Demonstrates AgentCard generation, A2AAgentExecutor event conversion, and RemoteA2AAgent streaming in memory.',
    });
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const worker = new OrderStatusWorkerAgent();
    const card = await getA2AAgentCard(worker, [
      {url: 'http://localhost:8000/jsonrpc', transport: 'JSONRPC'},
    ]);

    const workerRunner = new InMemoryRunner({
      agent: worker,
      appName: worker.name,
    });
    const executor = new A2AAgentExecutor({runner: workerRunner});
    const a2aEvents: A2AStreamEventData[] = [];
    const client = createInMemoryA2AClient(executor, a2aEvents);

    const remoteAgent = new RemoteA2AAgent({
      name: 'remote_order_agent',
      agentCard: card,
      client,
    });

    const callerRunner = new InMemoryRunner({
      agent: remoteAgent,
      appName: 'a2a_caller_app',
    });
    const callerSession = await callerRunner.sessionService.createSession({
      appName: 'a2a_caller_app',
      userId: 'caller-user',
    });

    const reconstructedEvents: Event[] = [];
    for await (const event of callerRunner.runAsync({
      userId: callerSession.userId,
      sessionId: callerSession.id,
      newMessage: {
        role: 'user',
        parts: [{text: 'Check order ORD-42'}],
      },
    })) {
      reconstructedEvents.push(event);
    }

    const callNames = reconstructedEvents.flatMap((event) =>
      getFunctionCalls(event).map((call) => call.name),
    );
    const responseNames = reconstructedEvents.flatMap((event) =>
      getFunctionResponses(event).map((resp) => resp.name),
    );
    const finalText = reconstructedEvents
      .map((event) => stringifyContent(event))
      .filter((text) => text.length > 0)
      .join(' ');

    const lines = [
      `Agent card path constant: ${AGENT_CARD_PATH}`,
      `Agent card: ${card.name} (${card.preferredTransport}, skills: ${card.skills.map((s) => s.id).join(', ')})`,
      `A2A stream events published: ${a2aEvents.map((e) => e.kind).join(', ')}`,
      `Reconstructed ADK events: ${reconstructedEvents.length} (calls: ${callNames.join(', ')}; responses: ${responseNames.join(', ')})`,
      `Remote reply: ${finalText}`,
    ];

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'model',
        parts: [{text: lines.join('\n')}],
      },
    });
  }

  protected override async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(ctx);
  }
}

export const rootAgent = new A2AShowcaseAgent();
