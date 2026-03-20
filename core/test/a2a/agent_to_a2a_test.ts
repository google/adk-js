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
import {toA2a} from '../../src/a2a/agent_to_a2a.js';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {BaseSessionService} from '../../src/sessions/base_session_service.js';

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

  it('should create an express app with default handlers', async () => {
    const app = await toA2a(agent);

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
      {url: 'http://localhost:8000/rest', transport: 'rest'},
      {url: 'http://localhost:8000/jsonrpc', transport: 'jsonrpc'},
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
    });

    expect(express).not.toHaveBeenCalled();
    expect(getA2AAgentCard).toHaveBeenCalledWith(agent, [
      {url: 'https://custom-host:9000api/v1/rest', transport: 'rest'},
      {url: 'https://custom-host:9000api/v1/jsonrpc', transport: 'jsonrpc'},
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
    });

    expect(resolveAgentCard).toHaveBeenCalledWith('path/to/card.json');
    expect(getA2AAgentCard).not.toHaveBeenCalled();
  });

  it('should resolve agentCard when provided as object', async () => {
    const card = {name: 'provided_card'} as unknown as AgentCard;
    await toA2a(agent, {
      agentCard: card,
    });

    expect(resolveAgentCard).toHaveBeenCalledWith(card);
    expect(getA2AAgentCard).not.toHaveBeenCalled();
  });
});
