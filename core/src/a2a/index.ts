/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Entry point for `@google/adk/a2a`.
 *
 * Everything here is also re-exported from `@google/adk`, so importing it from
 * the root keeps working. This subpath exists so that an application serving
 * or calling A2A can pull in the A2A surface — and only the A2A surface —
 * without evaluating the whole ADK barrel, and so that the `express` optional
 * peer dependency needed by {@link toA2a} has an obvious, documented home.
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
export {toA2a} from './agent_to_a2a.js';
export type {A2aUserBuilder, ToA2aOptions} from './agent_to_a2a.js';
export {bearerTokenUserBuilder} from './auth.js';
export type {ExecutorContext} from './executor_context.js';
