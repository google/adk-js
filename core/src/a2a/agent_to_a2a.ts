/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AGENT_CARD_PATH, AgentCard} from '@a2a-js/sdk';
import {DefaultRequestHandler, InMemoryTaskStore} from '@a2a-js/sdk/server';
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from '@a2a-js/sdk/server/express';
import express from 'express';
import {BaseAgent} from '../agents/base_agent.js';
import {StreamingMode} from '../agents/run_config.js';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {BaseMemoryService} from '../memory/base_memory_service.js';
import {Runner} from '../runner/runner.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {getA2AAgentCard, resolveAgentCard} from './agent_card.js';
import {A2AAgentExecutor} from './agent_executor.js';

/**
 * Options for the `toA2a` function.
 */
export interface ToA2aOptions {
  /** The host for the A2A RPC URL (default: "localhost") */
  host?: string;
  /** The port for the A2A RPC URL (default: 8000) */
  port?: number;
  /** The protocol for the A2A RPC URL (default: "http") */
  protocol?: string;
  /** The base path for the A2A RPC URL (default: "a2a") */
  basePath?: string;
  /** Optional pre-built AgentCard object or path to agent card JSON */
  agentCard?: AgentCard | string;
  /** Optional pre-built Runner object */
  runner?: Runner;
  /** Optional session service */
  sessionService?: BaseSessionService;
  /** Optional memory service */
  memoryService?: BaseMemoryService;
  /** Optional artifact service */
  artifactService?: BaseArtifactService;
  /** Optional existing express application */
  app?: express.Application;
}

/**
 * Converts an ADK agent to an Express application with A2A handlers.
 *
 * @param agent The ADK agent to convert
 * @param options Configuration options
 * @returns An Express application
 */
export async function toA2a(
  agent: BaseAgent,
  options: ToA2aOptions = {},
): Promise<express.Application> {
  const host = options.host ?? 'localhost';
  const port = options.port ?? 8000;
  const protocol = options.protocol ?? 'http';
  const basePath = options.basePath || '';
  const rpcUrl = `${protocol}://${host}:${port}${basePath}`;
  const agentCard = options.agentCard
    ? await resolveAgentCard(options.agentCard)
    : await getA2AAgentCard(agent, [
        {
          url: `${rpcUrl}/rest`,
          transport: 'rest',
        },
        {
          url: `${rpcUrl}/jsonrpc`,
          transport: 'jsonrpc',
        },
      ]);

  const agentExecutor = new A2AAgentExecutor({
    runner: options.runner || {
      agent,
      appName: agent.name,
      sessionService: options.sessionService || new InMemorySessionService(),
      memoryService: options.memoryService,
      artifactService: options.artifactService,
    },
    runConfig: {
      streamingMode: StreamingMode.SSE,
    },
  });

  const requestHandler = new DefaultRequestHandler(
    agentCard,
    new InMemoryTaskStore(),
    agentExecutor,
  );

  const app = options.app ?? express();
  if (!options.app) {
    app.use(express.urlencoded({limit: '50mb', extended: true}));
    app.use(express.json({limit: '50mb'}));
  }

  app.use(
    `${basePath}/${AGENT_CARD_PATH}`,
    agentCardHandler({agentCardProvider: requestHandler}),
  );
  app.use(
    `${basePath}/rest`,
    restHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  app.use(
    `${basePath}/jsonrpc`,
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );

  return app;
}
