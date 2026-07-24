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
  DefaultRequestHandler: vi.fn().mockImplementation(() => ({})),
  InMemoryTaskStore: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/a2a/agent_executor.js', () => ({
  A2AAgentExecutor: vi.fn().mockImplementation(() => ({})),
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

  it('should create an express app with handlers when unauthenticated access is explicitly allowed', async () => {
    const app = await toA2a(agent, {allowUnauthenticated: true});

    expect(express).toHaveBeenCalled();
    const expressMock = express as unknown as MockExpress;
    expect(expressMock.urlencoded).toHaveBeenCalledWith({
      limit: '50mb',
      extended: true,
    });
    expect(expressMock.json).toHaveBeenCalledWith({limit: '50mb'});

    expect(app.use).toHaveBeenCalledWith('urlencoded_middleware');
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
    expect(app.use).toHaveBeenCalledWith('/rest', 'restHandler');
    expect(app.use).toHaveBeenCalledWith('/jsonrpc', 'jsonRpcHandler');
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
    expect(customApp.use).toHaveBeenCalledWith('api/v1/rest', 'restHandler');
    expect(customApp.use).toHaveBeenCalledWith(
      'api/v1/jsonrpc',
      'jsonRpcHandler',
    );
  });

  it('should resolve agentCard when provided as string', async () => {
    await toA2a(agent, {
      agentCard: 'path/to/card.json',
      allowUnauthenticated: true,
    });

    expect(resolveAgentCard).toHaveBeenCalledWith('path/to/card.json');
    expect(getA2AAgentCard).not.toHaveBeenCalled();
  });

  it('should resolve agentCard when provided as object', async () => {
    const card = {name: 'provided_card'} as unknown as AgentCard;
    await toA2a(agent, {
      agentCard: card,
      allowUnauthenticated: true,
    });

    expect(resolveAgentCard).toHaveBeenCalledWith(card);
    expect(getA2AAgentCard).not.toHaveBeenCalled();
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
});
