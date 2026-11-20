/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {App, RunnableRoot} from '@google/adk';

const BASE_AGENT_LOADER_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.baseAgentLoader',
);

/**
 * Handle to a loadable agent, workflow, or {@link App} managed by a
 * {@link BaseAgentLoader}.
 */
export interface AgentFileHandle extends AsyncDisposable {
  /** Loads and returns the root agent, workflow, or {@link App}. */
  load(): Promise<RunnableRoot | App>;
  /**
   * Acquires a lease keeping any underlying bundle or resource alive until the
   * returned disposable is released.
   */
  retain(): AsyncDisposable;
  /**
   * Reads optional README documentation associated with the agent, or returns
   * `undefined` when none is available.
   */
  readReadme?(): Promise<string | undefined>;
}

/**
 * Type guard that checks whether `value` is a {@link BaseAgentLoader}.
 */
export function isBaseAgentLoader(value: unknown): value is BaseAgentLoader {
  return (
    typeof value === 'object' &&
    value !== null &&
    BASE_AGENT_LOADER_SIGNATURE_SYMBOL in value &&
    value[BASE_AGENT_LOADER_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Abstract base class for agent loaders consumed by `AdkApiServer`.
 */
export abstract class BaseAgentLoader {
  readonly [BASE_AGENT_LOADER_SIGNATURE_SYMBOL] = true;

  /**
   * Resolves the {@link AgentFileHandle} for `agentName`.
   */
  abstract getAgentFile(agentName: string): Promise<AgentFileHandle>;

  /**
   * Lists available agent names in alphabetical order.
   */
  abstract listAgents(): Promise<string[]>;

  /**
   * Releases any resources held by the loader. Defaults to a no-op for
   * in-memory loaders.
   */
  async disposeAll(): Promise<void> {}
}
