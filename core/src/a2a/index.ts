/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `@google/adk/a2a` subpath: the A2A surface only, without the full ADK barrel.
 * Also re-exported from `@google/adk`.
 */

export {AGENT_CARD_PATH, RemoteA2AAgent} from './a2a_remote_agent.js';
export type {
  A2AStreamEventData,
  AfterA2ARequestCallback,
  BeforeA2ARequestCallback,
  RemoteA2AAgentConfig,
} from './a2a_remote_agent.js';
export {getA2AAgentCard} from './agent_card.js';
export {A2AAgentExecutor} from './agent_executor.js';
export type {
  AfterEventCallback,
  AfterExecuteCallback,
  AgentExecutorConfig,
  BeforeExecuteCallback,
  RunnerOrRunnerConfig,
} from './agent_executor.js';
export {
  AdkDefaultRequestHandler,
  getA2aRequestMetadata,
  toA2a,
} from './agent_to_a2a.js';
export type {A2aUserBuilder, ToA2aOptions} from './agent_to_a2a.js';
export {bearerTokenUserBuilder} from './auth.js';
export type {ExecutorContext} from './executor_context.js';
