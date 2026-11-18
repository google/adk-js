/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard, SecurityScheme} from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  PushNotificationStore,
  TaskStore,
} from '@a2a-js/sdk/server';
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
} from '@a2a-js/sdk/server/express';
import express from 'express';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  getA2AAgentCard,
  resolveAgentCard,
  SkillSecurity,
} from '../../src/a2a/agent_card.js';
import {A2AAgentExecutor} from '../../src/a2a/agent_executor.js';
import {A2aUserBuilder, toA2a} from '../../src/a2a/agent_to_a2a.js';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {InMemoryArtifactService} from '../../src/artifacts/in_memory_artifact_service.js';
import {InMemoryCredentialService} from '../../src/auth/credential_service/in_memory_credential_service.js';
import {Event} from '../../src/events/event.js';
import {InMemoryMemoryService} from '../../src/memory/in_memory_memory_service.js';
import {Runner} from '../../src/runner/runner.js';
import {BaseSessionService} from '../../src/sessions/base_session_service.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {logger} from '../../src/utils/logger.js';
import {START} from '../../src/workflow/base_node.js';
import {node} from '../../src/workflow/node.js';
import {Workflow} from '../../src/workflow/workflow.js';

class TestAgent extends BaseAgent {
  constructor() {
    super({name: 'test-agent'});
  }
  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

const mockApp = {
  use: vi.fn(),
};

interface MockExpress {
  (): typeof mockApp;
  urlencoded: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

vi.mock('express', () => {
  const expressMock = vi.fn(() => mockApp) as unknown as MockExpress;
  expressMock.urlencoded = vi.fn(() => 'urlencoded_middleware');
  expressMock.json = vi.fn(() => 'json_middleware');
  return {
    default: expressMock,
    urlencoded: expressMock.urlencoded,
    json: expressMock.json,
  };
});

vi.mock('@a2a-js/sdk/server/express', () => ({
  agentCardHandler: vi.fn(() => 'agentCardHandler'),
  restHandler: vi.fn(() => 'restHandler'),
  jsonRpcHandler: vi.fn(() => 'jsonRpcHandler'),
  UserBuilder: {noAuthentication: 'noAuthentication'},
}));

vi.mock('@a2a-js/sdk/server', () => ({
  DefaultRequestHandler: vi.fn().mockImplementation(function () {
    return {};
  }),
  InMemoryTaskStore: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock('../../src/a2a/agent_executor.js', () => ({
  A2AAgentExecutor: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock('../../src/a2a/agent_card.js', () => ({
  getA2AAgentCard: vi.fn().mockResolvedValue({name: 'mocked_card'}),
  resolveAgentCard: vi.fn().mockResolvedValue({name: 'resolved_card'}),
}));

describe('toA2a', () => {
  let agent: TestAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new TestAgent();
  });

  it('creates an express app with JSON-only body parsing and handlers', async () => {
    const app = await toA2a(agent, {allowUnauthenticated: true});

    expect(express).toHaveBeenCalled();
    const expressMock = express as unknown as MockExpress;
    // `application/x-www-form-urlencoded` is CORS-safelisted, so parsing it
    // would make these endpoints reachable by a cross-origin form POST that
    // never triggers a preflight.
    expect(expressMock.urlencoded).not.toHaveBeenCalled();

    expect(expressMock.json).toHaveBeenCalledWith({limit: '50mb'});
    expect(app.use).toHaveBeenCalledWith('json_middleware');

    expect(getA2AAgentCard).toHaveBeenCalledWith(agent, [
      {url: 'http://localhost:8000/jsonrpc', transport: 'JSONRPC'},
      {url: 'http://localhost:8000/rest', transport: 'HTTP+JSON'},
    ]);

    expect(A2AAgentExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        runner: expect.objectContaining({
          agent,
          appName: 'test-agent',
        }),
      }),
    );

    expect(DefaultRequestHandler).toHaveBeenCalled();

    expect(agentCardHandler).toHaveBeenCalled();
    expect(restHandler).toHaveBeenCalled();
    expect(jsonRpcHandler).toHaveBeenCalledWith({
      requestHandler: expect.any(Object),
      userBuilder: 'noAuthentication',
    });

    expect(app.use).toHaveBeenCalledWith(
      expect.stringContaining('agent-card.json'),
      'agentCardHandler',
    );
    expect(app.use).toHaveBeenCalledWith(
      '/rest',
      expect.any(Function),
      'restHandler',
    );
    expect(app.use).toHaveBeenCalledWith(
      '/jsonrpc',
      expect.any(Function),
      'jsonRpcHandler',
    );
  });

  it('should use custom options when provided', async () => {
    const customApp = {use: vi.fn()};
    const customRunner = {agent} as unknown as Runner;
    const customSessionService = {} as unknown as BaseSessionService;

    await toA2a(agent, {
      host: 'custom-host',
      port: 9000,
      protocol: 'https',
      basePath: 'api/v1',
      app: customApp as unknown as express.Application,
      runner: customRunner,
      sessionService: customSessionService,
      allowUnauthenticated: true,
    });

    expect(express).not.toHaveBeenCalled();
    expect(getA2AAgentCard).toHaveBeenCalledWith(agent, [
      {url: 'https://custom-host:9000api/v1/jsonrpc', transport: 'JSONRPC'},
      {url: 'https://custom-host:9000api/v1/rest', transport: 'HTTP+JSON'},
    ]);

    expect(A2AAgentExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        runner: customRunner,
      }),
    );

    expect(customApp.use).toHaveBeenCalledWith(
      'api/v1/.well-known/agent-card.json',
      'agentCardHandler',
    );
    expect(customApp.use).toHaveBeenCalledWith(
      'api/v1/rest',
      expect.any(Function),
      'restHandler',
    );
    expect(customApp.use).toHaveBeenCalledWith(
      'api/v1/jsonrpc',
      expect.any(Function),
      'jsonRpcHandler',
    );
  });

  it('should resolve agentCard when provided as string', async () => {
    await toA2a(agent, {
      agentCard: 'path/to/card.json',
      allowUnauthenticated: true,
    });

    // Second argument is resolveAgentCardOptions, forwarded from
    // ToA2aOptions and undefined here since this call doesn't set it.
    expect(resolveAgentCard).toHaveBeenCalledWith(
      'path/to/card.json',
      undefined,
    );
    expect(getA2AAgentCard).not.toHaveBeenCalled();
  });

  it('should resolve agentCard when provided as object', async () => {
    const card = {name: 'provided_card'} as unknown as AgentCard;
    await toA2a(agent, {
      agentCard: card,
      allowUnauthenticated: true,
    });

    expect(resolveAgentCard).toHaveBeenCalledWith(card, undefined);
    expect(getA2AAgentCard).not.toHaveBeenCalled();
  });

  it('forwards resolveAgentCardOptions to resolveAgentCard when provided', async () => {
    await toA2a(agent, {
      agentCard: 'path/to/card.json',
      allowUnauthenticated: true,
      resolveAgentCardOptions: {allowCrossOriginRpc: true},
    });

    expect(resolveAgentCard).toHaveBeenCalledWith('path/to/card.json', {
      allowCrossOriginRpc: true,
    });
  });

  describe('authentication', () => {
    it('fails closed when no authentication is provided and access is not explicitly opened', async () => {
      await expect(toA2a(agent)).rejects.toThrow(/authenticat/i);

      // Nothing should be mounted when refusing to start.
      expect(restHandler).not.toHaveBeenCalled();
      expect(jsonRpcHandler).not.toHaveBeenCalled();
    });

    it('rejects allowUnauthenticated set to any non-true value', async () => {
      await expect(
        toA2a(agent, {
          allowUnauthenticated: false,
        }),
      ).rejects.toThrow(
        /refusing to mount the A2A server without authentication/i,
      );
    });

    it('warns and mounts with noAuthentication when allowUnauthenticated is true', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      await toA2a(agent, {allowUnauthenticated: true});

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/SECURITY WARNING/);
      expect(restHandler).toHaveBeenCalledWith({
        requestHandler: expect.any(Object),
        userBuilder: 'noAuthentication',
      });
      expect(jsonRpcHandler).toHaveBeenCalledWith({
        requestHandler: expect.any(Object),
        userBuilder: 'noAuthentication',
      });

      warnSpy.mockRestore();
    });

    it('wires the provided authenticator into both REST and JSON-RPC handlers', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const authenticator: A2aUserBuilder = vi.fn(async () => ({
        isAuthenticated: true,
        userName: 'alice',
      }));

      await toA2a(agent, {authentication: authenticator});

      // A provided authenticator is used verbatim and must not fall back to
      // noAuthentication, nor emit the insecure-mode warning.
      expect(restHandler).toHaveBeenCalledWith({
        requestHandler: expect.any(Object),
        userBuilder: authenticator,
      });
      expect(jsonRpcHandler).toHaveBeenCalledWith({
        requestHandler: expect.any(Object),
        userBuilder: authenticator,
      });
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe('agent validation and workflow support', () => {
    it.each([undefined, null])(
      'throws when agent is %s',
      async (invalidAgent: unknown) => {
        await expect(
          toA2a(invalidAgent as BaseAgent, {allowUnauthenticated: true}),
        ).rejects.toThrow('Agent cannot be null or undefined.');
      },
    );

    it('throws TypeError when agent is not a BaseAgent or Workflow', async () => {
      await expect(
        toA2a('not an agent' as unknown as BaseAgent, {
          allowUnauthenticated: true,
        }),
      ).rejects.toThrow(/requires a BaseAgent or Workflow, got string/);
    });

    it('throws TypeError when agent is a bare FunctionNode', async () => {
      const fnNode = node(async (input: unknown) => `echo: ${String(input)}`, {
        name: 'echo_fn',
      });

      await expect(
        toA2a(fnNode as unknown as BaseAgent, {allowUnauthenticated: true}),
      ).rejects.toThrow(/requires a BaseAgent or Workflow, got FunctionNode/);
    });

    it('accepts a Workflow root', async () => {
      const workflow = new Workflow({
        name: 'pipe',
        edges: [[START, agent]],
      });

      const app = await toA2a(workflow, {allowUnauthenticated: true});

      expect(app).toBe(mockApp);
      expect(getA2AAgentCard).toHaveBeenCalledWith(workflow, [
        {url: 'http://localhost:8000/jsonrpc', transport: 'JSONRPC'},
        {url: 'http://localhost:8000/rest', transport: 'HTTP+JSON'},
      ]);
    });
  });

  describe('rpcPath normalization, host/port edge cases, and runner services', () => {
    it.each(['analysis-agent', '/analysis-agent', '/analysis-agent/'])(
      'normalizes rpcPath %j to /analysis-agent',
      async (rpcPath) => {
        const customApp = {use: vi.fn()};

        await toA2a(agent, {
          rpcPath,
          app: customApp as unknown as express.Application,
          allowUnauthenticated: true,
        });

        expect(getA2AAgentCard).toHaveBeenCalledWith(agent, [
          {
            url: 'http://localhost:8000/analysis-agent/jsonrpc',
            transport: 'JSONRPC',
          },
          {
            url: 'http://localhost:8000/analysis-agent/rest',
            transport: 'HTTP+JSON',
          },
        ]);
        expect(customApp.use).toHaveBeenCalledWith(
          '/analysis-agent/.well-known/agent-card.json',
          'agentCardHandler',
        );
        expect(customApp.use).toHaveBeenCalledWith(
          '/analysis-agent/rest',
          expect.any(Function),
          'restHandler',
        );
        expect(customApp.use).toHaveBeenCalledWith(
          '/analysis-agent/jsonrpc',
          expect.any(Function),
          'jsonRpcHandler',
        );
      },
    );

    it.each(['/', '//', '///'])(
      'collapses all-slash rpcPath %j to root mount',
      async (rpcPath) => {
        const customApp = {use: vi.fn()};

        await toA2a(agent, {
          rpcPath,
          app: customApp as unknown as express.Application,
          allowUnauthenticated: true,
        });

        expect(getA2AAgentCard).toHaveBeenCalledWith(agent, [
          {url: 'http://localhost:8000/jsonrpc', transport: 'JSONRPC'},
          {url: 'http://localhost:8000/rest', transport: 'HTTP+JSON'},
        ]);
        expect(customApp.use).toHaveBeenCalledWith(
          '/.well-known/agent-card.json',
          'agentCardHandler',
        );
      },
    );

    it('preserves multi-segment rpcPath in the RPC URL and routes', async () => {
      const customApp = {use: vi.fn()};

      await toA2a(agent, {
        rpcPath: '/team/agent',
        app: customApp as unknown as express.Application,
        allowUnauthenticated: true,
      });

      expect(getA2AAgentCard).toHaveBeenCalledWith(agent, [
        {
          url: 'http://localhost:8000/team/agent/jsonrpc',
          transport: 'JSONRPC',
        },
        {url: 'http://localhost:8000/team/agent/rest', transport: 'HTTP+JSON'},
      ]);
      expect(customApp.use).toHaveBeenCalledWith(
        '/team/agent/.well-known/agent-card.json',
        'agentCardHandler',
      );
    });

    it.each([
      {
        label: 'port 0',
        options: {port: 0},
        expectedBase: 'http://localhost:0',
      },
      {
        label: 'negative port',
        options: {port: -1},
        expectedBase: 'http://localhost:-1',
      },
      {
        label: 'port 65535',
        options: {port: 65535},
        expectedBase: 'http://localhost:65535',
      },
      {
        label: 'empty string host',
        options: {host: ''},
        expectedBase: 'http://:8000',
      },
      {
        label: 'hyphenated and dotted host',
        options: {host: 'test-host.example.com'},
        expectedBase: 'http://test-host.example.com:8000',
      },
      {
        label: 'IP address host',
        options: {host: '192.168.1.1'},
        expectedBase: 'http://192.168.1.1:8000',
      },
    ])('builds RPC URLs for $label', async ({options, expectedBase}) => {
      await toA2a(agent, {...options, allowUnauthenticated: true});

      expect(getA2AAgentCard).toHaveBeenCalledWith(agent, [
        {url: `${expectedBase}/jsonrpc`, transport: 'JSONRPC'},
        {url: `${expectedBase}/rest`, transport: 'HTTP+JSON'},
      ]);
    });

    it('populates default InMemory services and falls back to adk_agent when agent name is empty', async () => {
      Object.assign(agent, {name: ''});

      await toA2a(agent, {allowUnauthenticated: true});

      const executorConfig = vi.mocked(A2AAgentExecutor).mock.calls[0]?.[0];
      const runnerConfig = executorConfig?.runner as {
        appName?: string;
        sessionService?: unknown;
        memoryService?: unknown;
        artifactService?: unknown;
        credentialService?: unknown;
      };
      expect(runnerConfig?.appName).toBe('adk_agent');
      expect(runnerConfig?.sessionService).toBeInstanceOf(
        InMemorySessionService,
      );
      expect(runnerConfig?.memoryService).toBeInstanceOf(InMemoryMemoryService);
      expect(runnerConfig?.artifactService).toBeInstanceOf(
        InMemoryArtifactService,
      );
      expect(runnerConfig?.credentialService).toBeInstanceOf(
        InMemoryCredentialService,
      );
    });

    it('uses a custom taskStore without instantiating InMemoryTaskStore', async () => {
      const customTaskStore = {
        load: vi.fn(),
        save: vi.fn(),
      } as unknown as TaskStore;

      await toA2a(agent, {
        taskStore: customTaskStore,
        allowUnauthenticated: true,
      });

      expect(InMemoryTaskStore).not.toHaveBeenCalled();
      expect(DefaultRequestHandler).toHaveBeenCalledWith(
        expect.anything(),
        customTaskStore,
        expect.anything(),
      );
    });

    it('uses agentExecutorFactory and pushConfigStore when provided', async () => {
      const customExecutor = {} as unknown as A2AAgentExecutor;
      const agentExecutorFactory = vi.fn(() => customExecutor);
      const customPushStore = {
        save: vi.fn(),
        load: vi.fn(),
        delete: vi.fn(),
      } as unknown as PushNotificationStore;

      await toA2a(agent, {
        agentExecutorFactory,
        pushConfigStore: customPushStore,
        allowUnauthenticated: true,
      });

      expect(agentExecutorFactory).toHaveBeenCalledTimes(1);
      expect(A2AAgentExecutor).not.toHaveBeenCalled();
      expect(DefaultRequestHandler).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        customExecutor,
        undefined,
        customPushStore,
        undefined,
      );
    });

    it('forwards securitySchemes and defaultSkillSecurity to getA2AAgentCard', async () => {
      const securitySchemes: Record<string, SecurityScheme> = {
        api: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
      };
      const defaultSkillSecurity: SkillSecurity = [{api: []}];

      await toA2a(agent, {
        securitySchemes,
        defaultSkillSecurity,
        allowUnauthenticated: true,
      });

      expect(getA2AAgentCard).toHaveBeenCalledWith(
        agent,
        [
          {url: 'http://localhost:8000/jsonrpc', transport: 'JSONRPC'},
          {url: 'http://localhost:8000/rest', transport: 'HTTP+JSON'},
        ],
        {
          securitySchemes,
          defaultSkillSecurity,
        },
      );
    });

    it('logs a warning when both agentCard and a non-empty rpcPath are provided', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        await toA2a(agent, {
          rpcPath: '/analysis-agent',
          agentCard: {name: 'provided_card'} as unknown as AgentCard,
          authentication: async () => ({
            isAuthenticated: true,
            userName: 'alice',
          }),
        });

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Both agentCard and rpcPath were provided'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it.each([
      {
        label: 'securitySchemes',
        securityOptions: {
          securitySchemes: {
            api: {
              type: 'apiKey',
              in: 'header',
              name: 'X-Api-Key',
            } as SecurityScheme,
          },
        },
      },
      {
        label: 'defaultSkillSecurity',
        securityOptions: {
          defaultSkillSecurity: [{api: []}],
        },
      },
      {
        label: 'invalid defaultSkillSecurity',
        securityOptions: {
          defaultSkillSecurity: {invalid: 'shape'} as unknown as SkillSecurity,
        },
      },
    ])(
      'logs a warning and ignores $label when agentCard is provided',
      async ({securityOptions}) => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        try {
          await toA2a(agent, {
            agentCard: {name: 'provided_card'} as unknown as AgentCard,
            ...securityOptions,
            authentication: async () => ({
              isAuthenticated: true,
              userName: 'alice',
            }),
          });

          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(
              'Both agentCard and securitySchemes/defaultSkillSecurity were provided',
            ),
          );
          expect(getA2AAgentCard).not.toHaveBeenCalled();
        } finally {
          warnSpy.mockRestore();
        }
      },
    );

    it('propagates errors when resolving or building the agent card fails', async () => {
      vi.mocked(getA2AAgentCard).mockRejectedValueOnce(
        new Error('Build failed'),
      );

      await expect(toA2a(agent, {allowUnauthenticated: true})).rejects.toThrow(
        'Build failed',
      );
    });
  });
});
