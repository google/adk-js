/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

import {deprecated} from '../utils/deprecated.js';
import {BaseAgent, BaseAgentConfig} from './base_agent.js';
import {InvocationContext} from './invocation_context.js';

/**
 * The configuration options for creating a loop agent.
 */
export interface LoopAgentConfig extends BaseAgentConfig {
  /**
   * The maximum number of iterations the loop agent will run.
   *
   * If not provided, the loop agent will run indefinitely.
   */
  maxIterations?: number;
}

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all LoopAgent instances.
 */
const LOOP_AGENT_SIGNATURE_SYMBOL = Symbol.for('google.adk.loopAgent');

/**
 * Type guard to check if an object is an instance of LoopAgent.
 * @param obj The object to check.
 * @returns True if the object is an instance of LoopAgent, false otherwise.
 */
export function isLoopAgent(obj: unknown): obj is LoopAgent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    LOOP_AGENT_SIGNATURE_SYMBOL in obj &&
    obj[LOOP_AGENT_SIGNATURE_SYMBOL] === true
  );
}

/**
 * A shell agent that run its sub-agents in a loop.
 *
 * When sub-agent generates an event with escalate or max_iterations are
 * reached, the loop agent will stop.
 *
 * @deprecated Use `Workflow` instead, which expresses the same ordering as a
 * graph and adds routing, retries, HITL and resumability. This class will be
 * removed in a future version. Note that a `Workflow` cannot yet be an
 * `LlmAgent` sub-agent — wrap it in a `WorkflowAgent` for that.
 */
@deprecated(
  'LoopAgent is deprecated in favor of Workflow and will be removed in a' +
    ' future version. Workflow cannot yet be used as an LlmAgent sub-agent.',
)
export class LoopAgent extends BaseAgent<LoopAgentConfig> {
  /**
   * A unique symbol to identify ADK loop agent class.
   */
  readonly [LOOP_AGENT_SIGNATURE_SYMBOL] = true;

  readonly maxIterations: number;

  constructor(config: LoopAgentConfig) {
    super(config);
    this.maxIterations = config.maxIterations ?? Number.MAX_SAFE_INTEGER;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    let iteration = 0;

    while (iteration < this.maxIterations) {
      for (const subAgent of this.subAgents) {
        let shouldExit = false;
        for await (const event of subAgent.runAsync(context)) {
          if (context.abortSignal?.aborted) {
            return;
          }

          yield event;

          if (event.actions.escalate) {
            shouldExit = true;
          }
        }

        if (shouldExit) {
          return;
        }
      }

      iteration++;
    }

    return;
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      for (const subAgent of this.subAgents) {
        for await (const event of subAgent.runLive(context)) {
          if (context.abortSignal?.aborted) {
            return;
          }

          yield event;

          if (event.actions?.escalate) {
            return;
          }
        }
      }
    }
  }
}
