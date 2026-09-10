/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AGENT_CARD_PATH, AgentCard} from '@a2a-js/sdk';
import {InMemoryTaskStore} from '@a2a-js/sdk/server';
import type {UserBuilder} from '@a2a-js/sdk/server/express';
import type express from 'express';
import {StreamingMode} from '../agents/run_config.js';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {BaseMemoryService} from '../memory/base_memory_service.js';
import {Runner} from '../runner/runner.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';
import {RunnableRoot} from '../workflow/run_node_as_invocation.js';
import {getA2AAgentCard, resolveAgentCard} from './agent_card.js';
import {A2AAgentExecutor} from './agent_executor.js';
import {
  AdkDefaultRequestHandler,
  getA2aRequestMetadata,
} from './request_metadata.js';

export {AdkDefaultRequestHandler, getA2aRequestMetadata};

/**
 * Loads Express and the Express bindings of `@a2a-js/sdk`, which are only
 * needed by {@link toA2a}.
 *
 * `@a2a-js/sdk` itself already declares `express` as an optional peer, and ADK
 * follows suit: an agent that is never mounted as an HTTP service should not
 * have to download a web framework. Both modules are imported here rather
 * than at the top of the file, because `@a2a-js/sdk/server/express` imports
 * `express` eagerly and would otherwise make the whole ADK entry point
 * unloadable without it.
 */
async function loadExpressBindings(): Promise<{
  express: typeof express;
  a2aExpress: typeof import('@a2a-js/sdk/server/express');
}> {
  const expressModule = await loadOptionalPeer(
    {packageName: 'express', feature: 'toA2a'},
    () => import('express'),
  );
  // `@a2a-js/sdk` is itself a hard dependency, so with Express resolved above
  // this import can no longer fail for a missing package.
  const a2aExpress = await import('@a2a-js/sdk/server/express');
  return {express: expressModule.default, a2aExpress};
}

/**
 * A request authenticator for the A2A surface.
 *
 * This is the `UserBuilder` hook from `@a2a-js/sdk`: an async function that
 * receives the incoming Express request, validates its credentials (for
 * example a bearer token or an OIDC ID token) and resolves to the
 * authenticated `User`. Implementations should reject unauthenticated
 * requests by throwing (or by resolving to a user whose `isAuthenticated` is
 * `false`), which prevents the underlying agent and its tools from being
 * invoked by anonymous callers.
 */
export type A2aUserBuilder = UserBuilder;

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
  /**
   * Authenticator used to validate incoming A2A requests.
   *
   * A2A is the production-intended inter-agent surface: any network-reachable
   * caller that can reach it can invoke the agent and its tools with arbitrary
   * input and read the output. Provide a `UserBuilder` (from
   * `@a2a-js/sdk/server/express`) that validates the request's credentials —
   * for example a bearer token or an OIDC ID token — and it will be wired into
   * both the REST and JSON-RPC handlers.
   *
   * When omitted, `toA2a` fails closed and throws unless
   * {@link ToA2aOptions.allowUnauthenticated} is explicitly set to `true`.
   */
  authentication?: A2aUserBuilder;
  /**
   * Explicit escape hatch to mount the A2A surface WITHOUT authentication.
   *
   * This is intentionally insecure and must only be used for local, trusted
   * development where the surface is not network reachable. When set to
   * `true` (and no {@link ToA2aOptions.authentication} is provided), a loud
   * warning is logged and the handlers are mounted with no authentication.
   *
   * Defaults to `false`, which makes `toA2a` fail closed.
   */
  allowUnauthenticated?: boolean;
}

/**
 * Resolves the `UserBuilder` used to authenticate the A2A surface, failing
 * closed by default.
 *
 * - If an {@link ToA2aOptions.authentication} authenticator is provided, it is
 *   used for both the REST and JSON-RPC handlers.
 * - Otherwise, if {@link ToA2aOptions.allowUnauthenticated} is explicitly
 *   `true`, a loud warning is logged and the surface is mounted with no
 *   authentication.
 * - Otherwise, an error is thrown: the A2A surface must not be exposed without
 *   authentication.
 */
function resolveA2aUserBuilder(
  options: ToA2aOptions,
  a2aExpress: typeof import('@a2a-js/sdk/server/express'),
): UserBuilder {
  if (options.authentication) {
    return options.authentication;
  }

  if (options.allowUnauthenticated === true) {
    logger.warn(
      'SECURITY WARNING: Mounting the A2A server WITHOUT authentication ' +
        'because `allowUnauthenticated: true` was set. The agent and all of ' +
        'its tools are exposed to any network-reachable caller, which can ' +
        'invoke them with arbitrary input and read the output. Do NOT use ' +
        'this outside of local, trusted development.',
    );
    return a2aExpress.UserBuilder.noAuthentication;
  }

  throw new Error(
    'toA2a: refusing to mount the A2A server without authentication. The A2A ' +
      'surface lets any network-reachable caller invoke this agent and its ' +
      'tools with arbitrary input and read the output, so it must be ' +
      'authenticated. Provide `authentication` (a UserBuilder that validates ' +
      'the request, e.g. a bearer token or OIDC credential) or, only for ' +
      'local/trusted development, explicitly set `allowUnauthenticated: ' +
      'true`.',
  );
}

/**
 * Converts an ADK agent to an Express application with A2A handlers.
 *
 * @param agent The ADK agent to convert
 * @param options Configuration options
 * @returns An Express application
 */
export async function toA2a(
  agent: RunnableRoot,
  options: ToA2aOptions = {},
): Promise<express.Application> {
  const {express: expressFactory, a2aExpress} = await loadExpressBindings();

  // Fail closed before doing any work: the A2A surface must be authenticated
  // unless the caller explicitly opts out.
  const userBuilder = resolveA2aUserBuilder(options, a2aExpress);

  const host = options.host ?? 'localhost';
  const port = options.port ?? 8000;
  const protocol = options.protocol ?? 'http';
  const basePath = options.basePath || '';
  const rpcUrl = `${protocol}://${host}:${port}${basePath}`;
  const agentCard = options.agentCard
    ? await resolveAgentCard(options.agentCard)
    : await getA2AAgentCard(agent, [
        {
          url: `${rpcUrl}/jsonrpc`,
          transport: 'JSONRPC',
        },
        {
          url: `${rpcUrl}/rest`,
          transport: 'HTTP+JSON',
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

  const requestHandler = new AdkDefaultRequestHandler(
    agentCard,
    new InMemoryTaskStore(),
    agentExecutor,
  );

  const app = options.app ?? expressFactory();
  if (!options.app) {
    // Parse JSON bodies only. `application/x-www-form-urlencoded` is a
    // CORS-safelisted content type, so a browser sends it cross-origin as a
    // simple request with no preflight; parsing it would let any web page
    // drive these endpoints with a drive-by form POST. Requiring JSON forces
    // a preflight, which this app does not answer.
    app.use(expressFactory.json({limit: '50mb'}));
  }

  app.use(
    `${basePath}/${AGENT_CARD_PATH}`,
    a2aExpress.agentCardHandler({agentCardProvider: requestHandler}),
  );
  app.use(
    `${basePath}/rest`,
    a2aExpress.restHandler({
      requestHandler,
      userBuilder,
    }),
  );
  app.use(
    `${basePath}/jsonrpc`,
    a2aExpress.jsonRpcHandler({
      requestHandler,
      userBuilder,
    }),
  );

  return app;
}
