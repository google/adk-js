/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentCard,
  MessageSendParams,
  Task,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {ClientFactory} from '@a2a-js/sdk/client';
import {
  DefaultExecutionEventBus,
  ExecutionEventQueue,
  RequestContext,
} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  Event as AdkEvent,
  BaseAgent,
  createEvent,
  InMemorySessionService,
  InvocationContext,
  RemoteA2AAgent,
  Session,
} from '@google/adk';
import {randomUUID} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';

/**
 * LoopbackClient satisfy a2aclient.Client interface, routing streams inside A2AAgentExecutor
 */
function createLoopbackClient(executor: A2AAgentExecutor) {
  return {
    sendMessageStream: async function* (params: MessageSendParams) {
      const bus = new DefaultExecutionEventBus();
      const queue = new ExecutionEventQueue(bus);
      const ctx: RequestContext = {
        contextId: params.message.contextId || randomUUID(),
        taskId: params.message.taskId || randomUUID(),
        userMessage: params.message,
      } as unknown as RequestContext;

      const runPromise = executor
        .execute(ctx, bus)
        .then(() => bus.finished())
        .catch((e) => {
          console.error('Executor Failed:', e);
          bus.finished();
        });

      for await (const event of queue.events()) {
        yield event;
      }
      await runPromise;
    },
    sendMessage: async (params: MessageSendParams) => {
      // Direct execute and return final status update
      const bus = new DefaultExecutionEventBus();
      const queue = new ExecutionEventQueue(bus);
      const ctx: RequestContext = {
        contextId: params.message.contextId || randomUUID(),
        taskId: params.message.taskId || randomUUID(),
        userMessage: params.message,
      } as unknown as RequestContext;

      let finalTask: Task | undefined;
      let finalStatus: TaskStatusUpdateEvent | undefined;

      const runPromise = executor
        .execute(ctx, bus)
        .then(() => bus.finished())
        .catch(() => {
          bus.finished();
        });

      for await (const event of queue.events()) {
        if (event.kind === 'task') finalTask = event as Task;
        if (event.kind === 'status-update')
          finalStatus = event as TaskStatusUpdateEvent;
      }
      await runPromise;
      if (finalTask && finalStatus) {
        finalTask.status = finalStatus.status;
        return finalTask;
      }
      throw new Error('Failed to get task response');
    },
  };
}

/**
 * StatefulAgent allows replaying events based on invocation context session length
 */
class StatefulAgent extends BaseAgent {
  constructor(
    private readonly yieldFn: (
      ctx: InvocationContext,
    ) => AsyncGenerator<AdkEvent, void, void>,
    name = 'stateful-agent',
  ) {
    super({name});
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    for await (const e of this.yieldFn(context)) {
      yield e;
    }
  }

  protected runLiveImpl(): AsyncGenerator<AdkEvent, void, void> {
    throw new Error('Live mode is not supported.');
  }
}

describe('A2A E2E Tests (In-Memory Loopback)', () => {
  describe('InputRequired', () => {
    it('Long-running tool', async () => {
      const approvalToolName = 'request_approval';
      const toolCallId = 'call-123';
      const modelTextRequiresApproval = 'need to request approval first!';
      const modelTextTaskComplete = 'Task complete!';

      // Create the Server-side Agent execution chain
      const serverAgent = new StatefulAgent(async function* (ctx) {
        const userMsg = ctx.session.events[ctx.session.events.length - 1];
        const hasApproval = userMsg?.content?.parts?.some(
          (p) =>
            p.functionResponse?.name === approvalToolName &&
            p.functionResponse.response?.status === 'approved',
        );

        if (!hasApproval) {
          yield createEvent({
            author: 'server-agent',
            content: {
              role: 'model',
              parts: [
                {text: modelTextRequiresApproval},
                {
                  functionCall: {
                    name: approvalToolName,
                    args: {},
                    id: toolCallId,
                  },
                },
              ],
            },
            longRunningToolIds: [toolCallId],
            partial: false,
          });
        } else {
          yield createEvent({
            author: 'server-agent',
            content: {role: 'model', parts: [{text: modelTextTaskComplete}]},
            partial: false,
          });
        }
      });

      const executor = new A2AAgentExecutor({
        runner: {
          appName: 'target-agent',
          sessionService: new InMemorySessionService(),
          agent: serverAgent,
        },
      });

      const loopbackClient = createLoopbackClient(executor);
      const mockClientFactory = {
        createFromAgentCard: vi.fn().mockResolvedValue(loopbackClient),
      };
      const remoteAgent = new RemoteA2AAgent({
        name: 'target-agent',
        agentCard: {name: 'target-agent'} as AgentCard,
        clientFactory: mockClientFactory as unknown as ClientFactory,
      });

      const clientCtx = {
        session: {
          appName: 'caller',
          userId: 'caller-user',
          id: 'context-1',
          events: [
            createEvent({
              author: 'user',
              content: {role: 'user', parts: [{text: 'Do something'}]},
            }),
          ],
        } as unknown as Session,
        invocationId: 'invoke-1',
      } as unknown as InvocationContext;

      const events: AdkEvent[] = [];
      for await (const ev of remoteAgent.runAsync(clientCtx)) {
        events.push(ev);
      }

      expect(events.length).toBeGreaterThanOrEqual(1);
      const inputReqEvent = events[events.length - 1];

      expect(inputReqEvent.longRunningToolIds).toContain(toolCallId);

      const hasToolCall = inputReqEvent.content?.parts?.some(
        (p) => p.functionCall?.name === approvalToolName,
      );
      expect(hasToolCall).toBe(true);

      clientCtx.session.events.push(
        createEvent({
          author: 'user',
          content: {
            role: 'user',
            parts: [
              {text: 'Approved'},
              {
                functionResponse: {
                  name: approvalToolName,
                  response: {status: 'approved'},
                  id: toolCallId,
                },
              },
            ],
          },
        }),
      );

      const events2: AdkEvent[] = [];
      for await (const ev of remoteAgent.runAsync(clientCtx)) {
        events2.push(ev);
      }

      expect(events2.length).toBeGreaterThanOrEqual(1);
      const finalEvent = events2[events2.length - 1];
      const hasCompleteText = finalEvent.content?.parts?.some(
        (p) => p.text === modelTextTaskComplete,
      );
      expect(hasCompleteText).toBe(true);
    });

    it('Tool confirmation', async () => {
      const originalToolName = 'create_ticket';
      const confirmationCallName = 'adk_request_confirmation';
      const toolCallId = 'call-abc';
      const confirmationCallId = 'confirm-xyz';

      const modelTextInitial = 'creating ticket...';
      const modelTextTaskComplete = 'Ticket created!';

      const serverAgent = new StatefulAgent(async function* (ctx) {
        const userMsg = ctx.session.events[ctx.session.events.length - 1];
        const hasConfirmation = userMsg?.content?.parts?.some(
          (p) =>
            p.functionResponse?.name === confirmationCallName &&
            p.functionResponse.response?.confirmed === true,
        );

        if (!hasConfirmation) {
          yield createEvent({
            author: 'server-agent',
            content: {
              role: 'model',
              parts: [
                {text: modelTextInitial},
                {
                  functionCall: {
                    name: confirmationCallName,
                    args: {
                      originalFunctionCall: {
                        name: originalToolName,
                        args: {title: 'Bug'},
                        id: toolCallId,
                      },
                      toolConfirmation: {hint: 'Confirm creation?'},
                    },
                    id: confirmationCallId,
                  },
                },
              ],
            },
            longRunningToolIds: [confirmationCallId],
            partial: false,
          });
        } else {
          yield createEvent({
            author: 'server-agent',
            content: {role: 'model', parts: [{text: modelTextTaskComplete}]},
            partial: false,
          });
        }
      });

      const service = new InMemorySessionService();
      const executor = new A2AAgentExecutor({
        runner: {
          appName: 'target-agent',
          sessionService: service,
          agent: serverAgent,
        },
      });

      const loopbackClient = createLoopbackClient(executor);
      const mockClientFactory = {
        createFromAgentCard: vi.fn().mockResolvedValue(loopbackClient),
      };
      const remoteAgent = new RemoteA2AAgent({
        name: 'target-agent',
        agentCard: {name: 'target-agent'} as AgentCard,
        clientFactory: mockClientFactory as unknown as ClientFactory,
      });

      const clientCtx = {
        session: {
          appName: 'caller',
          userId: 'caller-user',
          id: 'context-2',
          events: [
            createEvent({
              author: 'user',
              content: {role: 'user', parts: [{text: 'Create a ticket'}]},
            }),
          ],
        } as unknown as Session,
        invocationId: 'invoke-2',
      } as unknown as InvocationContext;

      const events: AdkEvent[] = [];
      for await (const ev of remoteAgent.runAsync(clientCtx)) {
        events.push(ev);
      }

      expect(events.length).toBeGreaterThanOrEqual(1);
      const inputReqEvent = events[events.length - 1];
      expect(inputReqEvent.longRunningToolIds).toContain(confirmationCallId);

      // Followup with confirmation
      clientCtx.session.events.push(
        createEvent({
          author: 'user',
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: confirmationCallName,
                  response: {confirmed: true},
                  id: confirmationCallId,
                },
              },
            ],
          },
        }),
      );

      const events2: AdkEvent[] = [];
      for await (const ev of remoteAgent.runAsync(clientCtx)) {
        events2.push(ev);
      }

      expect(events2.length).toBeGreaterThanOrEqual(1);
      const finalEvent = events2[events2.length - 1];
      const hasCompleteText = finalEvent.content?.parts?.some(
        (p) => p.text === modelTextTaskComplete,
      );
      expect(hasCompleteText).toBe(true);
    });

    it('MultiHop', async () => {
      const approvalToolName = 'request_approval_B';
      const toolCallId = 'call-hop-b';
      const modelTextInitial = 'agent B working...';
      const modelTextTaskComplete = 'Hop B complete!';

      // --- Node B Setup (Inner Remote Agent) ---
      const serverAgentB = new StatefulAgent(async function* (ctx) {
        const userMsg = ctx.session.events[ctx.session.events.length - 1];
        const hasApproval = userMsg?.content?.parts?.some(
          (p) =>
            p.functionResponse?.name === approvalToolName &&
            p.functionResponse.response?.status === 'approved',
        );

        if (!hasApproval) {
          yield createEvent({
            author: 'server-agent-B',
            content: {
              role: 'model',
              parts: [
                {text: modelTextInitial},
                {
                  functionCall: {
                    name: approvalToolName,
                    args: {},
                    id: toolCallId,
                  },
                },
              ],
            },
            longRunningToolIds: [toolCallId],
            partial: false,
          });
        } else {
          yield createEvent({
            author: 'server-agent-B',
            content: {role: 'model', parts: [{text: modelTextTaskComplete}]},
            partial: false,
          });
        }
      });

      const serviceB = new InMemorySessionService();
      const executorB = new A2AAgentExecutor({
        runner: {
          appName: 'agent-B',
          sessionService: serviceB,
          agent: serverAgentB,
        },
      });

      const loopbackClientB = createLoopbackClient(executorB);
      const mockClientFactoryB = {
        createFromAgentCard: vi.fn().mockResolvedValue(loopbackClientB),
      };

      const remoteAgentB = new RemoteA2AAgent({
        name: 'agent-B',
        agentCard: {name: 'agent-B'} as AgentCard,
        clientFactory: mockClientFactoryB as unknown as ClientFactory,
      });

      // --- Node A Setup (Root Agent) ---
      class RootAgent extends BaseAgent {
        constructor() {
          super({name: 'root-agent'});
        }
        protected async *runAsyncImpl(
          context: InvocationContext,
        ): AsyncGenerator<AdkEvent, void, void> {
          // Simply delegate to remoteAgentB
          for await (const ev of remoteAgentB.runAsync(context)) {
            yield ev;
          }
        }
        protected runLiveImpl(): AsyncGenerator<AdkEvent, void, void> {
          throw new Error('Not supported');
        }
      }

      const rootAgent = new RootAgent();
      const serviceA = new InMemorySessionService();
      const executorA = new A2AAgentExecutor({
        runner: {
          appName: 'root-agent',
          sessionService: serviceA,
          agent: rootAgent,
        },
      });

      const loopbackClientA = createLoopbackClient(executorA);
      const mockClientFactoryA = {
        createFromAgentCard: vi.fn().mockResolvedValue(loopbackClientA),
      };

      const remoteAgentA = new RemoteA2AAgent({
        name: 'root-agent',
        agentCard: {name: 'root-agent'} as AgentCard,
        clientFactory: mockClientFactoryA as unknown as ClientFactory,
      });

      // --- Client Execution ---
      const clientCtx = {
        session: {
          appName: 'caller',
          userId: 'caller-user',
          id: 'context-3',
          events: [
            createEvent({
              author: 'user',
              content: {role: 'user', parts: [{text: 'Do root task'}]},
            }),
          ],
        } as unknown as Session,
        invocationId: 'invoke-3',
      } as unknown as InvocationContext;

      const events: AdkEvent[] = [];
      for await (const ev of remoteAgentA.runAsync(clientCtx)) {
        events.push(ev);
      }

      expect(events.length).toBeGreaterThanOrEqual(1);
      const inputReqEvent = events[events.length - 1];
      expect(inputReqEvent.longRunningToolIds).toContain(toolCallId);

      // Followup delivering approval
      clientCtx.session.events.push(
        createEvent({
          author: 'user',
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: approvalToolName,
                  response: {status: 'approved'},
                  id: toolCallId,
                },
              },
            ],
          },
        }),
      );

      const events2: AdkEvent[] = [];
      for await (const ev of remoteAgentA.runAsync(clientCtx)) {
        events2.push(ev);
      }

      expect(events2.length).toBeGreaterThanOrEqual(1);
      const finalEvent = events2[events2.length - 1];
      expect(
        finalEvent.content?.parts?.some(
          (p) => p.text === modelTextTaskComplete,
        ),
      ).toBe(true);
    });
  });

  describe('RemoteAgent Streaming', () => {
    it('Gemini Success', async () => {
      const modelTextChunk1 = 'Hello, ';
      const modelTextChunk2 = 'I am ';
      const modelTextChunk3 = 'a streaming agent!';
      const combinedText = modelTextChunk1 + modelTextChunk2 + modelTextChunk3;

      const serverAgent = new StatefulAgent(async function* () {
        yield createEvent({
          author: 'server-agent',
          content: {role: 'model', parts: [{text: modelTextChunk1}]},
          partial: true,
        });
        yield createEvent({
          author: 'server-agent',
          content: {role: 'model', parts: [{text: modelTextChunk2}]},
          partial: true,
        });
        yield createEvent({
          author: 'server-agent',
          content: {role: 'model', parts: [{text: modelTextChunk3}]},
          partial: false,
        });
      });

      const service = new InMemorySessionService();
      const executor = new A2AAgentExecutor({
        runner: {
          appName: 'target-agent',
          sessionService: service,
          agent: serverAgent,
        },
      });

      const loopbackClient = createLoopbackClient(executor);
      const mockClientFactory = {
        createFromAgentCard: vi.fn().mockResolvedValue(loopbackClient),
      };
      const remoteAgent = new RemoteA2AAgent({
        name: 'target-agent',
        agentCard: {name: 'target-agent'} as AgentCard,
        clientFactory: mockClientFactory as unknown as ClientFactory,
      });

      const clientCtx = {
        session: {
          appName: 'caller',
          userId: 'caller-user',
          id: 'context-4',
          events: [
            createEvent({
              author: 'user',
              content: {role: 'user', parts: [{text: 'Speak'}]},
            }),
          ],
        } as unknown as Session,
        invocationId: 'invoke-4',
      } as unknown as InvocationContext;

      const events: AdkEvent[] = [];
      for await (const ev of remoteAgent.runAsync(clientCtx)) {
        events.push(ev);
      }

      expect(events.length).toBeGreaterThanOrEqual(1);
      const joinedText = events
        .map((ev) => ev.content?.parts?.[0]?.text || '')
        .join('');
      expect(joinedText).toBe(combinedText);
    });

    it('Gemini Error', async () => {
      const modelTextChunk1 = 'Hello, ';
      const errorMessage = 'Mid-stream connection failure!';

      const serverAgent = new StatefulAgent(async function* () {
        yield createEvent({
          author: 'server-agent',
          content: {role: 'model', parts: [{text: modelTextChunk1}]},
          partial: true,
        });
        // Simulate crash
        throw new Error(errorMessage);
      });

      const service = new InMemorySessionService();
      const executor = new A2AAgentExecutor({
        runner: {
          appName: 'target-agent',
          sessionService: service,
          agent: serverAgent,
        },
      });

      const loopbackClient = createLoopbackClient(executor);
      const mockClientFactory = {
        createFromAgentCard: vi.fn().mockResolvedValue(loopbackClient),
      };
      const remoteAgent = new RemoteA2AAgent({
        name: 'target-agent',
        agentCard: {name: 'target-agent'} as AgentCard,
        clientFactory: mockClientFactory as unknown as ClientFactory,
      });

      const clientCtx = {
        session: {
          appName: 'caller',
          userId: 'caller-user',
          id: 'context-5',
          events: [
            createEvent({
              author: 'user',
              content: {role: 'user', parts: [{text: 'Speak'}]},
            }),
          ],
        } as unknown as Session,
        invocationId: 'invoke-5',
      } as unknown as InvocationContext;

      const events: AdkEvent[] = [];
      for await (const ev of remoteAgent.runAsync(clientCtx)) {
        events.push(ev);
      }

      expect(events.length).toBeGreaterThanOrEqual(1);
      const finalEvent = events[events.length - 1];
      expect(finalEvent.errorMessage).toContain(
        'Agent run failed: ' + errorMessage,
      );
    });
  });
});
