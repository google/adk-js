/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentCard,
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {Client} from '@a2a-js/sdk/client';
import {
  ExecutionEventBus,
  RequestContext,
  ServerCallContext,
  TaskStore,
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
import {MessageRole} from '../../src/a2a/a2a_event.js';
import {A2AAgentExecutor} from '../../src/a2a/agent_executor.js';
import {
  AdkDefaultRequestHandler,
  getA2aRequestMetadata,
} from '../../src/a2a/request_metadata.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';

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
    it('returns undefined when no metadata is present on RequestContext', () => {
      const ctx = {
        contextId: 'ctx-1',
        taskId: 'task-1',
        userMessage: {
          messageId: 'msg-1',
          role: MessageRole.USER,
          parts: [{kind: 'text', text: 'hi'}],
        },
      } as unknown as RequestContext;

      expect(getA2aRequestMetadata(ctx)).toBeUndefined();
    });

    it('extracts metadata from ctx.request.metadata (SDK >= 1.0.0 style)', () => {
      const expectedMetadata = {
        'https://example.com/ext': {key: 'value'},
        traceId: 'trace-123',
      };
      const ctx = {
        contextId: 'ctx-1',
        taskId: 'task-1',
        userMessage: {
          messageId: 'msg-1',
          role: MessageRole.USER,
          parts: [{kind: 'text', text: 'hi'}],
        },
        request: {
          metadata: expectedMetadata,
        },
      } as unknown as RequestContext;

      expect(getA2aRequestMetadata(ctx)).toEqual(expectedMetadata);
    });
  });

  describe('AdkDefaultRequestHandler', () => {
    it('tracks metadata in requestMetadataStore during sendMessage and cleans up after settlement', async () => {
      const agentCard = {
        name: 'test-card',
        description: 'test-desc',
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        capabilities: {},
      } as unknown as AgentCard;
      const taskStore = {
        load: vi.fn().mockResolvedValue(undefined),
        save: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      } as unknown as TaskStore;

      let capturedMetadataDuringExecution: Record<string, unknown> | undefined;
      const agentExecutor = {
        execute: vi.fn(
          async (ctx: RequestContext, eventBus: ExecutionEventBus) => {
            capturedMetadataDuringExecution = getA2aRequestMetadata(ctx);
            eventBus.publish({
              kind: 'message',
              messageId: 'res-msg-1',
              role: MessageRole.AGENT,
              parts: [{kind: 'text', text: 'done'}],
            });
          },
        ),
        cancelTask: vi.fn(),
      };

      const handler = new AdkDefaultRequestHandler(
        agentCard,
        taskStore,
        agentExecutor,
      );

      const expectedMetadata = {'https://test.extension': {auth: 'token-abc'}};
      const message: Message = {
        kind: 'message',
        messageId: 'msg-unique-1',
        role: MessageRole.USER,
        parts: [{kind: 'text', text: 'hello'}],
      };
      const params: MessageSendParams = {
        message,
        metadata: expectedMetadata,
      };

      const result = await handler.sendMessage(
        params,
        undefined as unknown as ServerCallContext,
      );

      // Verify executor received the metadata during execution
      expect(capturedMetadataDuringExecution).toEqual(expectedMetadata);
      // Verify metadata is cleaned up after settlement
      expect(
        getA2aRequestMetadata({
          userMessage: message,
        } as unknown as RequestContext),
      ).toBeUndefined();
      expect(result).toBeDefined();
    });

    it('tracks metadata in requestMetadataStore during sendMessageStream and cleans up', async () => {
      const agentCard = {
        name: 'test-card',
        description: 'test-desc',
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        capabilities: {streaming: true},
      } as unknown as AgentCard;
      const taskStore = {
        load: vi.fn().mockResolvedValue(undefined),
        save: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      } as unknown as TaskStore;

      let capturedMetadataDuringExecution: Record<string, unknown> | undefined;
      const agentExecutor = {
        execute: vi.fn(
          async (ctx: RequestContext, eventBus: ExecutionEventBus) => {
            capturedMetadataDuringExecution = getA2aRequestMetadata(ctx);
            eventBus.publish({
              kind: 'message',
              messageId: 'res-1',
              role: MessageRole.AGENT,
              parts: [{kind: 'text', text: 'streamed response'}],
            });
          },
        ),
        cancelTask: vi.fn(),
      };

      const handler = new AdkDefaultRequestHandler(
        agentCard,
        taskStore,
        agentExecutor,
      );

      const expectedMetadata = {'https://stream.extension': {mode: 'realtime'}};
      const message: Message = {
        kind: 'message',
        messageId: 'msg-stream-1',
        role: MessageRole.USER,
        parts: [{kind: 'text', text: 'hello stream'}],
      };
      const params: MessageSendParams = {
        message,
        metadata: expectedMetadata,
      };

      const events: (
        | Message
        | Task
        | TaskStatusUpdateEvent
        | TaskArtifactUpdateEvent
      )[] = [];
      for await (const event of handler.sendMessageStream(
        params,
        undefined as unknown as ServerCallContext,
      )) {
        events.push(event);
      }

      expect(capturedMetadataDuringExecution).toEqual(expectedMetadata);
      expect(
        getA2aRequestMetadata({
          userMessage: message,
        } as unknown as RequestContext),
      ).toBeUndefined();
      expect(events.length).toBeGreaterThan(0);
    });

    it('works normally when params.metadata is omitted', async () => {
      const agentCard = {
        name: 'test-card',
        description: 'test-desc',
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        capabilities: {},
      } as unknown as AgentCard;
      const taskStore = {
        load: vi.fn().mockResolvedValue(undefined),
        save: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      } as unknown as TaskStore;

      let capturedMetadataDuringExecution: Record<string, unknown> | undefined =
        {initial: true};
      const agentExecutor = {
        execute: vi.fn(
          async (ctx: RequestContext, eventBus: ExecutionEventBus) => {
            capturedMetadataDuringExecution = getA2aRequestMetadata(ctx);
            eventBus.publish({
              kind: 'message',
              messageId: 'res-msg-2',
              role: MessageRole.AGENT,
              parts: [{kind: 'text', text: 'done'}],
            });
          },
        ),
        cancelTask: vi.fn(),
      };

      const handler = new AdkDefaultRequestHandler(
        agentCard,
        taskStore,
        agentExecutor,
      );

      const message: Message = {
        kind: 'message',
        messageId: 'msg-no-meta',
        role: MessageRole.USER,
        parts: [{kind: 'text', text: 'hello'}],
      };
      const params: MessageSendParams = {
        message,
      };

      await handler.sendMessage(
        params,
        undefined as unknown as ServerCallContext,
      );

      expect(capturedMetadataDuringExecution).toBeUndefined();
      expect(
        getA2aRequestMetadata({
          userMessage: message,
        } as unknown as RequestContext),
      ).toBeUndefined();
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
        userMessage: {
          messageId: 'msg-piped',
          role: MessageRole.USER,
          parts: [{kind: 'text', text: 'run agent'}],
        },
        request: {
          metadata: expectedMetadata,
        },
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
            kind: 'message',
            messageId: 'res-1',
            role: MessageRole.AGENT,
            parts: [{kind: 'text', text: 'response'}],
          };
        }),
      } as unknown as Client;

      const {RemoteA2AAgent} =
        await import('../../src/a2a/a2a_remote_agent.js');
      const remoteAgent = new RemoteA2AAgent({
        name: 'remote-test-agent',
        client: mockClient,
        agentCard: {
          name: 'remote-card',
          description: 'remote-desc',
          defaultInputModes: ['text'],
          defaultOutputModes: ['text'],
          capabilities: {streaming: true},
        } as unknown as AgentCard,
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
            kind: 'message',
            messageId: 'res-2',
            role: MessageRole.AGENT,
            parts: [{kind: 'text', text: 'response'}],
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
          name: 'remote-card-2',
          description: 'remote-desc-2',
          defaultInputModes: ['text'],
          defaultOutputModes: ['text'],
          capabilities: {streaming: true},
        } as unknown as AgentCard,
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
          method: 'message/send',
          params: {
            message: {
              messageId: 'msg-rpc-meta-1',
              role: 'user',
              parts: [{kind: 'text', text: 'Hello via JSON-RPC'}],
            },
            metadata: {
              'https://a2a.google.com/ext/tracing': {traceId: 'trace-xyz-789'},
              'https://custom.org/auth': {tenant: 'acme-corp'},
            },
          },
        };

        const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
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
            content: [{text: 'Hello via REST'}],
          },
          metadata: {
            'https://a2a.google.com/ext/routing': {
              targetRegion: 'us-central1',
            },
          },
        };

        const res = await fetch(
          `http://127.0.0.1:${port}/rest/v1/message:send`,
          {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify(payload),
          },
        );

        expect(res.status).toBe(201);

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
