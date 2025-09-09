/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

import {BaseAgent} from './base_agent.js';
import {InvocationContext} from './invocation_context.js';

/**
 * A shell agent that run its sub-agents in parallel in isolated manner.
 *
 * This approach is beneficial for scenarios requiring multiple perspectives or
 * attempts on a single task, such as:
 *
 *  - Running different algorithms simultaneously.
 *  - Generating multiple responses for review by a subsequent evaluation agent.
 */
export class ParallelAgent extends BaseAgent {
  protected async *
      runImpl(
          context: InvocationContext,
          ): AsyncGenerator<Event, void, void> {
    const agentRuns = this.subAgents.map(
        subAgent =>
            subAgent.run(createBranchCtxForSubAgent(this, subAgent, context)));

    for await (const event of mergeAgentRuns(agentRuns)) {
      yield event;
    }
  }

  protected async *
      runLiveImpl(
          context: InvocationContext,
          ): AsyncGenerator<Event, void, void> {
    throw new Error('This is not supported yet for ParallelAgent.');
  }
}

/**
 * Create isolated branch for every sub-agent.
 */
function createBranchCtxForSubAgent(
    agent: BaseAgent,
    subAgent: BaseAgent,
    originalContext: InvocationContext,
    ): InvocationContext {
  const invocationContext = new InvocationContext(originalContext);
  const branchSuffix = `${agent.name}.${subAgent.name}`;
  invocationContext.branch = invocationContext.branch ?
      `${invocationContext.branch}.${branchSuffix}` :
      branchSuffix;

  return invocationContext;
}

/**
 * Merges the agent run event generator.
 *
 * This implementation guarantees for each agent, it won't move on until the
 * generated event is processed by upstream runner.
 *
 * @param agentRuns A list of async generators that yield events from each
 *     agent.
 *
 * @returns A list of async generators that yield events from each agent.
 *
 * @yield The next event from the merged generator.
 */
async function*
    mergeAgentRuns(agentRuns: AsyncGenerator<Event, void, void>[]):
        AsyncGenerator<Event, void, void> {
  const pendingPromises = new Map<
      number, Promise<{result: IteratorResult<Event>; index: number}>>();

  for (const [index, generator] of agentRuns.entries()) {
    const promise = generator.next().then(result => ({result, index}));
    pendingPromises.set(index, promise);
  }

  while (pendingPromises.size > 0) {
    const {result, index} = await Promise.race(pendingPromises.values());

    if (result.done) {
      pendingPromises.delete(index);
      continue;
    }

    yield result.value;

    const nextPromise =
        agentRuns[index].next().then(result => ({result, index}));
    pendingPromises.set(index, nextPromise);
  }
}
