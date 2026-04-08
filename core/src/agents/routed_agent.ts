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
 */
@experimental
export class RoutedAgent extends BaseAgent {
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
