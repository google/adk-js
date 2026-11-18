/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentCard,
  Role,
  SendMessageRequest,
  Task,
  TaskState,
} from '@a2a-js/sdk';
import {Client} from '@a2a-js/sdk/client';
import {
  AgentEvent,
  AgentExecutor,
  ExecutionEventBus,
  InMemoryTaskStore,
  RequestContext,
  ServerCallContext,
} from '@a2a-js/sdk/server';
import {
  BaseAgent,
  BaseSessionService,
  Context,
  createEventActions,
  Event,
  InvocationContext,
  ReadonlyContext,
  RunConfig,
  Runner,
  Session,
} from '@google/adk';
import type {AddressInfo} from 'node:net';
import {beforeEach, describe, expect, it, Mocked, vi} from 'vitest';
import {createMessage, createTextPart} from '../../src/a2a/a2a_event.js';
import {A2AAgentExecutor} from '../../src/a2a/agent_executor.js';
import {
  AdkDefaultRequestHandler,
  getA2aRequestMetadata,
} from '../../src/a2a/request_metadata.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';

/** An A2A v1.0 agent card, as far as the request handler reads it. */
function createAgentCard(streaming = false): AgentCard {
  return {
    name: 'test-card',
    description: 'test-desc',
    supportedInterfaces: [
      {
        url: 'https://example.com/jsonrpc',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
        tenant: '',
      },
    ],
    provider: undefined,
    version: '1.0.0',
    capabilities: {streaming, extensions: []},
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
    signatures: [],
  };
}

/**
 * An executor that records the request metadata it receives, and completes the
 * task.
 */
function createRecordingExecutor() {
  const received: Array<Record<string, unknown> | undefined> = [];
  const executor: AgentExecutor = {
    execute: async (ctx: RequestContext, eventBus: ExecutionEventBus) => {
      received.push(getA2aRequestMetadata(ctx));
      const task: Task = {
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: {
          state: TaskState.TASK_STATE_SUBMITTED,
          message: undefined,
          timestamp: undefined,
        },
        artifacts: [],
        history: [],
        metadata: undefined,
      };
      eventBus.publish(AgentEvent.task(task));
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            message: undefined,
            timestamp: new Date().toISOString(),
          },
          metadata: undefined,
        }),
      );
    },
    cancelTask: async () => {},
  };
  return {executor, received};
}

function createRequest(
  overrides: Partial<SendMessageRequest> = {},
): SendMessageRequest {
  return {
    tenant: '',
    message: createMessage({
      role: Role.ROLE_USER,
      parts: [createTextPart('hello')],
    }),
    configuration: undefined,
    metadata: undefined,
    ...overrides,
  };
}

class MockAgent extends BaseAgent {
  constructor() {
    super({name: 'mock-agent'});
  }
  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield {
      author: this.name,
    } as Event;
  }
  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield {
      author: this.name,
    } as Event;
  }
}

describe('A2A Request Metadata Propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getA2aRequestMetadata', () => {
    it('returns undefined when the request has no metadata', () => {
      const ctx = {
        contextId: 'ctx-1',
        taskId: 'task-1',
        request: createRequest(),
      } as unknown as RequestContext;

      expect(getA2aRequestMetadata(ctx)).toBeUndefined();
    });

    it('returns undefined when the request metadata is null', () => {
      const ctx = {
        contextId: 'ctx-1',
        taskId: 'task-1',
        request: {...createRequest(), metadata: null},
      } as unknown as RequestContext;

      expect(getA2aRequestMetadata(ctx)).toBeUndefined();
    });

    it('returns undefined when the context has no request', () => {
      const ctx = {
        contextId: 'ctx-1',
        taskId: 'task-1',
      } as unknown as RequestContext;

      expect(getA2aRequestMetadata(ctx)).toBeUndefined();
    });

    it('extracts metadata from ctx.request.metadata', () => {
      const expectedMetadata = {
        'https://example.com/ext': {key: 'value'},
        traceId: 'trace-123',
      };
      const ctx = {
        contextId: 'ctx-1',
        taskId: 'task-1',
        request: createRequest({metadata: expectedMetadata}),
      } as unknown as RequestContext;

      expect(getA2aRequestMetadata(ctx)).toEqual(expectedMetadata);
    });
  });

  describe('AdkDefaultRequestHandler', () => {
    function keepBusAliveStatesOf(
      handler: AdkDefaultRequestHandler,
    ): TaskState[] {
      return [
        ...(handler as unknown as {keepBusAliveStates: Set<TaskState>})
          .keepBusAliveStates,
      ];
    }

    it('keeps no event bus alive by default', () => {
      const {executor} = createRecordingExecutor();

      const handler = new AdkDefaultRequestHandler(
        createAgentCard(),
        new InMemoryTaskStore(),
        executor,
      );

      expect(keepBusAliveStatesOf(handler)).toEqual([]);
    });

    it('keeps no event bus alive when the options leave keepBusAliveStates unset', () => {
      const {executor} = createRecordingExecutor();

      const handler = new AdkDefaultRequestHandler(
        createAgentCard(),
        new InMemoryTaskStore(),
        executor,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {},
      );

      expect(keepBusAliveStatesOf(handler)).toEqual([]);
    });

    it('keeps the keepBusAliveStates the caller provides', () => {
      const {executor} = createRecordingExecutor();

      const handler = new AdkDefaultRequestHandler(
        createAgentCard(),
        new InMemoryTaskStore(),
        executor,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {keepBusAliveStates: [TaskState.TASK_STATE_INPUT_REQUIRED]},
      );

      expect(keepBusAliveStatesOf(handler)).toEqual([
        TaskState.TASK_STATE_INPUT_REQUIRED,
      ]);
    });

    it('passes the request metadata to the executor in sendMessage', async () => {
      const {executor, received} = createRecordingExecutor();
      const handler = new AdkDefaultRequestHandler(
        createAgentCard(),
        new InMemoryTaskStore(),
        executor,
      );
      const expectedMetadata = {'https://test.extension': {auth: 'token-abc'}};

      const result = await handler.sendMessage(
        createRequest({metadata: expectedMetadata}),
        new ServerCallContext(),
      );

      expect(received).toEqual([expectedMetadata]);
      expect(result).toMatchObject({
        status: {state: TaskState.TASK_STATE_COMPLETED},
      });
    });

    it('passes the request metadata to the executor in sendMessageStream', async () => {
      const {executor, received} = createRecordingExecutor();
      const handler = new AdkDefaultRequestHandler(
        createAgentCard(true),
        new InMemoryTaskStore(),
        executor,
      );
      const expectedMetadata = {'https://stream.extension': {mode: 'realtime'}};

      const events = [];
      for await (const event of handler.sendMessageStream(
        createRequest({metadata: expectedMetadata}),
        new ServerCallContext(),
      )) {
        events.push(event);
      }

      expect(received).toEqual([expectedMetadata]);
      expect(events.map((event) => event.payload?.$case)).toEqual([
        'task',
        'statusUpdate',
      ]);
    });

    it('works normally when the request metadata is omitted', async () => {
      const {executor, received} = createRecordingExecutor();
      const handler = new AdkDefaultRequestHandler(
        createAgentCard(),
        new InMemoryTaskStore(),
        executor,
      );

      const result = await handler.sendMessage(
        createRequest(),
        new ServerCallContext(),
      );

      expect(received).toEqual([undefined]);
      expect(result).toBeDefined();
    });

    it('does not carry the metadata of one request over to the next', async () => {
      const {executor, received} = createRecordingExecutor();
      const handler = new AdkDefaultRequestHandler(
        createAgentCard(),
        new InMemoryTaskStore(),
        executor,
      );

      await handler.sendMessage(
        createRequest({metadata: {first: true}}),
        new ServerCallContext(),
      );
      await handler.sendMessage(createRequest(), new ServerCallContext());

      expect(received).toEqual([{first: true}, undefined]);
    });
  });

  describe('InvocationContext, ReadonlyContext, and Context integration', () => {
    it('stores and exposes a2aMetadata on InvocationContext', () => {
      const metadata = {'https://example.org/ext': {data: 123}};
      const session = {
        id: 's-1',
        userId: 'u-1',
        appName: 'app-1',
        state: {},
        events: [],
      } as unknown as Session;

      const invCtx = new InvocationContext({
        invocationId: 'inv-1',
        session,
        pluginManager: new PluginManager([]),
        a2aMetadata: metadata,
      });

      expect(invCtx.a2aMetadata).toEqual(metadata);
    });

    it('exposes a2aMetadata through ReadonlyContext and Context', () => {
      const metadata = {
        traceParent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      };
      const session = {
        id: 's-1',
        userId: 'u-1',
        appName: 'app-1',
        state: {},
        events: [],
      } as unknown as Session;

      const invCtx = new InvocationContext({
        invocationId: 'inv-1',
        session,
        pluginManager: new PluginManager([]),
        a2aMetadata: metadata,
      });

      const readonlyCtx = new ReadonlyContext(invCtx);
      expect(readonlyCtx.a2aMetadata).toEqual(metadata);

      const ctx = new Context({
        invocationContext: invCtx,
        eventActions: createEventActions(),
      });
      expect(ctx.a2aMetadata).toEqual(metadata);
    });

    it('preserves a2aMetadata across InvocationContext clone', () => {
      const metadata = {tenant: 'tenant-abc'};
      const session = {
        id: 's-1',
        userId: 'u-1',
        appName: 'app-1',
        state: {},
        events: [],
      } as unknown as Session;

      const invCtx = new InvocationContext({
        invocationId: 'inv-1',
        session,
        pluginManager: new PluginManager([]),
        a2aMetadata: metadata,
      });

      const clonedCtx = new InvocationContext({
        ...invCtx,
        branch: 'agent1.subagent2',
      });

      expect(clonedCtx.a2aMetadata).toEqual(metadata);
      expect(clonedCtx.branch).toBe('agent1.subagent2');
    });
  });

  describe('A2AAgentExecutor full pipeline propagation', () => {
    it('passes a2aMetadata to runConfig and beforeExecuteCallback', async () => {
      const mockSessionService = {
        getSession: vi.fn().mockResolvedValue({
          id: 'session-id',
          userId: 'test-user',
          appName: 'test-app',
          events: [],
          state: {},
        }),
      } as unknown as Mocked<BaseSessionService>;

      let passedRunConfig: RunConfig | undefined;
      const runner = new Runner({
        agent: new MockAgent(),
        appName: 'test-app',
        sessionService: mockSessionService,
      });

      vi.spyOn(runner, 'runAsync').mockImplementation(async function* (params: {
        runConfig?: RunConfig;
      }) {
        passedRunConfig = params.runConfig;
        yield {
          author: 'mock-agent',
        } as Event;
      });

      let callbackMetadata: Record<string, unknown> | undefined;
      const expectedMetadata = {
        'https://spec.a2a.dev/extensions/oauth': {token: 'oauth-xyz'},
      };

      const executor = new A2AAgentExecutor({
        runner,
        beforeExecuteCallback: async (_reqCtx, a2aMetadata) => {
          callbackMetadata = a2aMetadata;
        },
      });

      const ctx = {
        contextId: 'test-context',
        taskId: 'test-task',
        userMessage: createMessage({
          messageId: 'msg-piped',
          role: Role.ROLE_USER,
          parts: [createTextPart('run agent')],
        }),
        request: createRequest({metadata: expectedMetadata}),
      } as unknown as RequestContext;

      const mockEventBus = {
        publish: vi.fn(),
      } as unknown as ExecutionEventBus;

      await executor.execute(ctx, mockEventBus);

      expect(callbackMetadata).toEqual(expectedMetadata);
      expect(passedRunConfig?.a2aMetadata).toEqual(expectedMetadata);
    });
  });

  describe('Runner invocation context wiring', () => {
    it('initializes InvocationContext.a2aMetadata from runConfig.a2aMetadata in runAsync', async () => {
      const {InMemorySessionService} =
        await import('../../src/sessions/in_memory_session_service.js');
      const sessionService = new InMemorySessionService();
      await sessionService.createSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'session-id',
      });

      let capturedInvocationContext: InvocationContext | undefined;
      class ContextCapturingAgent extends BaseAgent {
        constructor() {
          super({name: 'capturing-agent'});
        }
        protected async *runAsyncImpl(
          context: InvocationContext,
        ): AsyncGenerator<Event, void, void> {
          capturedInvocationContext = context;
          yield {
            author: this.name,
          } as Event;
        }
        protected async *runLiveImpl(
          _context: InvocationContext,
        ): AsyncGenerator<Event, void, void> {
          yield {
            author: this.name,
          } as Event;
        }
      }

      const runner = new Runner({
        agent: new ContextCapturingAgent(),
        appName: 'test-app',
        sessionService,
      });

      const expectedMetadata = {
        'https://example.com/test': {feature: 'flag_on'},
      };

      for await (const _ of runner.runAsync({
        userId: 'test-user',
        sessionId: 'session-id',
        newMessage: {role: 'user', parts: [{text: 'hello'}]},
        runConfig: {
          a2aMetadata: expectedMetadata,
        },
      })) {
        // drain
      }

      expect(capturedInvocationContext).toBeDefined();
      expect(capturedInvocationContext?.a2aMetadata).toEqual(expectedMetadata);
    });
  });

  describe('RemoteA2AAgent metadata forwarding', () => {
    it('forwards context.a2aMetadata in messageSendParams when metadata config is omitted', async () => {
      const mockClient = {
        sendMessageStream: vi.fn(async function* () {
          yield {
            payload: {
              $case: 'message',
              value: createMessage({
                messageId: 'res-1',
                role: Role.ROLE_AGENT,
                parts: [createTextPart('response')],
              }),
            },
          };
        }),
      } as unknown as Client;

      const {RemoteA2AAgent} =
        await import('../../src/a2a/a2a_remote_agent.js');
      const remoteAgent = new RemoteA2AAgent({
        name: 'remote-test-agent',
        client: mockClient,
        agentCard: {
          ...createAgentCard(true),
          name: 'remote-card',
          description: 'remote-desc',
        },
      });

      const expectedMetadata = {
        'https://trace.dev/span': {id: '12345'},
      };

      const session = {
        id: 's-remote',
        userId: 'u-remote',
        appName: 'app-remote',
        state: {},
        events: [
          {
            author: 'user',
            content: {role: 'user', parts: [{text: 'invoke remote'}]},
          },
        ],
      } as unknown as Session;

      const invCtx = new InvocationContext({
        invocationId: 'inv-remote-1',
        session,
        pluginManager: new PluginManager([]),
        a2aMetadata: expectedMetadata,
        agent: remoteAgent,
      });

      for await (const _ of remoteAgent.runAsync(invCtx)) {
        // drain
      }

      expect(mockClient.sendMessageStream).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expectedMetadata,
        }),
      );
    });

    it('uses explicit metadata from RemoteA2AAgentConfig over context.a2aMetadata', async () => {
      const mockClient = {
        sendMessageStream: vi.fn(async function* () {
          yield {
            payload: {
              $case: 'message',
              value: createMessage({
                messageId: 'res-2',
                role: Role.ROLE_AGENT,
                parts: [createTextPart('response')],
              }),
            },
          };
        }),
      } as unknown as Client;

      const explicitMetadata = {'https://custom.dev': {override: true}};
      const {RemoteA2AAgent} =
        await import('../../src/a2a/a2a_remote_agent.js');
      const remoteAgent = new RemoteA2AAgent({
        name: 'remote-test-agent-2',
        client: mockClient,
        metadata: explicitMetadata,
        agentCard: {
          ...createAgentCard(true),
          name: 'remote-card-2',
          description: 'remote-desc-2',
        },
      });

      const contextMetadata = {'https://trace.dev/span': {id: '12345'}};
      const session = {
        id: 's-remote-2',
        userId: 'u-remote-2',
        appName: 'app-remote-2',
        state: {},
        events: [
          {
            author: 'user',
            content: {role: 'user', parts: [{text: 'invoke remote'}]},
          },
        ],
      } as unknown as Session;

      const invCtx = new InvocationContext({
        invocationId: 'inv-remote-2',
        session,
        pluginManager: new PluginManager([]),
        a2aMetadata: contextMetadata,
        agent: remoteAgent,
      });

      for await (const _ of remoteAgent.runAsync(invCtx)) {
        // drain
      }

      expect(mockClient.sendMessageStream).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: explicitMetadata,
        }),
      );
    });
  });

  describe('End-to-end toA2a HTTP metadata propagation', () => {
    class EchoAgent extends BaseAgent {
      capturedContext?: InvocationContext;

      constructor() {
        super({name: 'echo-agent'});
      }
      protected async *runAsyncImpl(
        context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        this.capturedContext = context;
        yield {
          author: this.name,
          content: {role: 'model', parts: [{text: 'Echo response'}]},
        } as unknown as Event;
      }
      protected async *runLiveImpl(
        _context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        yield {
          author: this.name,
        } as Event;
      }
    }

    it('propagates params.metadata to agent execution via JSON-RPC endpoint', async () => {
      const {toA2a} = await import('../../src/a2a/agent_to_a2a.js');
      const echoAgent = new EchoAgent();

      const app = await toA2a(echoAgent, {allowUnauthenticated: true});
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = (server.address() as AddressInfo).port;

      try {
        const payload = {
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: {
            message: {
              messageId: 'msg-rpc-meta-1',
              role: 'ROLE_USER',
              parts: [{text: 'Hello via JSON-RPC'}],
            },
            metadata: {
              'https://a2a.google.com/ext/tracing': {traceId: 'trace-xyz-789'},
              'https://custom.org/auth': {tenant: 'acme-corp'},
            },
          },
        };

        const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'a2a-version': '1.0',
          },
          body: JSON.stringify(payload),
        });

        expect(res.status).toBe(200);
        const data = (await res.json()) as {result?: unknown};
        expect(data.result).toBeDefined();

        expect(echoAgent.capturedContext).toBeDefined();
        expect(echoAgent.capturedContext?.a2aMetadata).toEqual({
          'https://a2a.google.com/ext/tracing': {traceId: 'trace-xyz-789'},
          'https://custom.org/auth': {tenant: 'acme-corp'},
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it('propagates params.metadata to agent execution via REST endpoint', async () => {
      const {toA2a} = await import('../../src/a2a/agent_to_a2a.js');
      const echoAgent = new EchoAgent();

      const app = await toA2a(echoAgent, {allowUnauthenticated: true});
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = (server.address() as AddressInfo).port;

      try {
        const payload = {
          message: {
            messageId: 'msg-rest-meta-1',
            role: 'ROLE_USER',
            parts: [{text: 'Hello via REST'}],
          },
          metadata: {
            'https://a2a.google.com/ext/routing': {
              targetRegion: 'us-central1',
            },
          },
        };

        const res = await fetch(`http://127.0.0.1:${port}/rest/message:send`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'a2a-version': '1.0',
          },
          body: JSON.stringify(payload),
        });

        expect(res.status).toBe(200);

        expect(echoAgent.capturedContext).toBeDefined();
        expect(echoAgent.capturedContext?.a2aMetadata).toEqual({
          'https://a2a.google.com/ext/routing': {targetRegion: 'us-central1'},
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });
  });
});
