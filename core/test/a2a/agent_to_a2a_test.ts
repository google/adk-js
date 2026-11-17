/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard} from '@a2a-js/sdk';
import {DefaultRequestHandler} from '@a2a-js/sdk/server';
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
} from '@a2a-js/sdk/server/express';
import express from 'express';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {getA2AAgentCard, resolveAgentCard} from '../../src/a2a/agent_card.js';
import {A2AAgentExecutor} from '../../src/a2a/agent_executor.js';
import {A2aUserBuilder, toA2a} from '../../src/a2a/agent_to_a2a.js';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {BaseSessionService} from '../../src/sessions/base_session_service.js';
import {logger} from '../../src/utils/logger.js';

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

/** An interface of a mocked card, for the given A2A protocol version. */
function mockInterface(protocolVersion: string) {
  return {
    url: 'http://localhost:8000/jsonrpc',
    protocolBinding: 'JSONRPC',
    protocolVersion,
    tenant: '',
  };
}

vi.mock('../../src/a2a/agent_card.js', () => ({
  getA2AAgentCard: vi.fn().mockResolvedValue({
    name: 'mocked_card',
    supportedInterfaces: [mockInterface('1.0'), mockInterface('0.3')],
  }),
  resolveAgentCard: vi.fn().mockResolvedValue({
    name: 'resolved_card',
    supportedInterfaces: [mockInterface('1.0'), mockInterface('0.3')],
  }),
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

    // A2A v1.0 first, then v0.3 on the same URLs so the compatibility layer
    // answers v0.3 clients.
    expect(getA2AAgentCard).toHaveBeenCalledWith(agent, [
      {
        url: 'http://localhost:8000/jsonrpc',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
        tenant: '',
      },
      {
        url: 'http://localhost:8000/rest',
        protocolBinding: 'HTTP+JSON',
        protocolVersion: '1.0',
        tenant: '',
      },
      {
        url: 'http://localhost:8000/jsonrpc',
        protocolBinding: 'JSONRPC',
        protocolVersion: '0.3',
        tenant: '',
      },
      {
        url: 'http://localhost:8000/rest',
        protocolBinding: 'HTTP+JSON',
        protocolVersion: '0.3',
        tenant: '',
      },
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

    expect(agentCardHandler).toHaveBeenCalledWith({
      agentCardProvider: expect.any(Object),
      legacyCompat: {enabled: true},
    });
    expect(restHandler).toHaveBeenCalledWith({
      requestHandler: expect.any(Object),
      userBuilder: 'noAuthentication',
      legacyCompat: {enabled: true},
    });
    expect(jsonRpcHandler).toHaveBeenCalledWith({
      requestHandler: expect.any(Object),
      userBuilder: 'noAuthentication',
      legacyCompat: {enabled: true},
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
      {
        url: 'https://custom-host:9000api/v1/jsonrpc',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
        tenant: '',
      },
      {
        url: 'https://custom-host:9000api/v1/rest',
        protocolBinding: 'HTTP+JSON',
        protocolVersion: '1.0',
        tenant: '',
      },
      {
        url: 'https://custom-host:9000api/v1/jsonrpc',
        protocolBinding: 'JSONRPC',
        protocolVersion: '0.3',
        tenant: '',
      },
      {
        url: 'https://custom-host:9000api/v1/rest',
        protocolBinding: 'HTTP+JSON',
        protocolVersion: '0.3',
        tenant: '',
      },
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

  it('turns the v0.3 compatibility layer off for a card that declares only v1.0', async () => {
    vi.mocked(resolveAgentCard).mockResolvedValueOnce({
      name: 'v1_only_card',
      supportedInterfaces: [mockInterface('1.0')],
    } as unknown as AgentCard);

    await toA2a(agent, {
      agentCard: 'path/to/card.json',
      allowUnauthenticated: true,
    });

    // With it on, the card endpoint would answer a request without an
    // A2A-Version header with an error: the card has no v0.3 interface to
    // build a v0.3 card from.
    const legacyCompat = {enabled: false};
    expect(agentCardHandler).toHaveBeenCalledWith(
      expect.objectContaining({legacyCompat}),
    );
    expect(restHandler).toHaveBeenCalledWith(
      expect.objectContaining({legacyCompat}),
    );
    expect(jsonRpcHandler).toHaveBeenCalledWith(
      expect.objectContaining({legacyCompat}),
    );
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
        legacyCompat: {enabled: true},
      });
      expect(jsonRpcHandler).toHaveBeenCalledWith({
        requestHandler: expect.any(Object),
        userBuilder: 'noAuthentication',
        legacyCompat: {enabled: true},
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
        legacyCompat: {enabled: true},
      });
      expect(jsonRpcHandler).toHaveBeenCalledWith({
        requestHandler: expect.any(Object),
        userBuilder: authenticator,
        legacyCompat: {enabled: true},
      });
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});
