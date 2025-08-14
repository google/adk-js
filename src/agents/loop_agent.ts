/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

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
 * A shell agent that run its sub-agents in a loop.
 *
 * When sub-agent generates an event with escalate or max_iterations are
 * reached, the loop agent will stop.
 */
export class LoopAgent extends BaseAgent {
  private readonly maxIterations: number;

  constructor(config: LoopAgentConfig) {
    super(config);
    this.maxIterations = config.maxIterations ?? Number.MAX_SAFE_INTEGER;
  }

  protected async *
      runAsyncImpl(
          context: InvocationContext,
          ): AsyncGenerator<Event, void, void> {
    let iteration = 0;

    while (iteration < this.maxIterations) {
      for (const subAgent of this.subAgents) {
        let shouldExit = false;
        for await (const event of subAgent.runAsync(context)) {
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

  protected async *
      runLiveImpl(
          context: InvocationContext,
          ): AsyncGenerator<Event, void, void> {
    throw new Error('This is not supported yet for LoopAgent.');
  }
}