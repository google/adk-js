/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';
import {BaseAgent, BaseAgentConfig} from './base_agent.js';
import {InvocationContext} from './invocation_context.js';

import {experimental} from '../utils/experimental.js';
import {runWithRouting} from '../utils/failover_utils.js';

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all RoutedAgent instances.
 */
const ROUTED_AGENT_SIGNATURE_SYMBOL = Symbol.for('google.adk.routedAgent');

/**
 * Type guard to check if an object is an instance of RoutedAgent.
 * @param obj The object to check.
 * @returns True if the object is an instance of RoutedAgent, false otherwise.
 */
export function isRoutedAgent(obj: unknown): obj is RoutedAgent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    ROUTED_AGENT_SIGNATURE_SYMBOL in obj &&
    obj[ROUTED_AGENT_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Type definition for a function that selects an agent based on the invocation context.
 */
export type AgentRouter = (
  agents: Readonly<Record<string, BaseAgent>>,
  context: InvocationContext,
  errorContext?: {failedKeys: ReadonlySet<string>; lastError: unknown},
) => Promise<string | undefined> | string | undefined;

/**
 * Configuration for the RoutingAgent.
 */
export interface RoutedAgentConfig extends BaseAgentConfig {
  /**
   * The set of agents to route to. Can be an array of agents or a Record of keys to agents.
   * If an array is provided, the agent names will be used as keys.
   */
  agents: Readonly<Record<string, BaseAgent>> | BaseAgent[];

  /**
   * The function to select which agent to run.
   */
  router: AgentRouter;
}

/**
 * A BaseAgent implementation that delegates to one of multiple agents based on a router function.
 * Routing is strictly limited to the agents passed in the config.
 *
 * @remarks
 * Cloning is supported: {@link RoutedAgent.clone} deep-clones the routing
 * targets from `config.agents` and re-parents the fresh copies onto the clone,
 * so the clone is a detached root that routes identically to the original while
 * leaving the original agent tree untouched.
 */
@experimental
export class RoutedAgent extends BaseAgent<RoutedAgentConfig> {
  readonly [ROUTED_AGENT_SIGNATURE_SYMBOL] = true;

  private readonly agents: Readonly<Record<string, BaseAgent>>;
  private readonly router: AgentRouter;

  constructor(config: RoutedAgentConfig) {
    const agentsArray = Array.isArray(config.agents)
      ? config.agents
      : Object.values(config.agents);

    // We pass the agents to super as subAgents to maintain the tree structure (parent tracking),
    // but our routing logic strictly uses the internal map.
    super({
      ...config,
      subAgents: agentsArray,
    });

    if (Array.isArray(config.agents)) {
      this.agents = Object.fromEntries(config.agents.map((a) => [a.name, a]));
    } else {
      this.agents = config.agents;
    }
    this.router = config.router;
  }

  /**
   * Creates a detached copy of this routed agent.
   *
   * The inherited {@link BaseAgent.clone} only deep-clones `subAgents`, but a
   * `RoutedAgent` derives its routing targets from `config.agents`. Rebuilding
   * through the base clone alone would re-read the already-parented original
   * agents and throw "already has a parent agent". This override deep-clones the
   * routing targets (unless the caller overrides `agents`) so the rebuilt
   * constructor re-parents fresh, detached copies. The array-vs-record shape
   * and, for records, the keys are preserved so the router keeps selecting the
   * same targets.
   *
   * @param overrides Config fields to override on the clone. Overriding
   *     `parentAgent` is rejected by the base implementation.
   * @returns A new detached `RoutedAgent` of the same concrete class.
   */
  override clone(overrides?: Partial<RoutedAgentConfig>): this {
    const nextOverrides: Partial<RoutedAgentConfig> = {...overrides};
    if (!('agents' in nextOverrides)) {
      nextOverrides.agents = cloneRoutingTargets(this.config.agents);
    }
    return super.clone(nextOverrides);
  }

  /**
   * Runs the selected agent via text-based conversation.
   */
  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* runWithRouting(this.agents, context, this.router, (agent) =>
      agent.runAsync(context),
    );
  }

  /**
   * Runs the selected agent via video/audio-based conversation.
   */
  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* runWithRouting(this.agents, context, this.router, (agent) =>
      agent.runLive(context),
    );
  }
}

/**
 * Deep-clones a RoutedAgent's routing targets, preserving whether they were
 * supplied as an array or a keyed record so the rebuilt constructor derives the
 * same routing map. Each clone is detached (no parent), so the constructor can
 * re-parent it without conflict.
 */
function cloneRoutingTargets(
  agents: Readonly<Record<string, BaseAgent>> | BaseAgent[],
): Readonly<Record<string, BaseAgent>> | BaseAgent[] {
  if (Array.isArray(agents)) {
    return agents.map((agent) => agent.clone());
  }
  return Object.fromEntries(
    Object.entries(agents).map(([key, agent]) => [key, agent.clone()]),
  );
}
