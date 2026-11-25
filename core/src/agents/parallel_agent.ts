/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

import {Aclosing} from '../utils/context_utils.js';
import {deprecated} from '../utils/deprecated.js';
import {BaseAgent} from './base_agent.js';
import {InvocationContext} from './invocation_context.js';

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all ParallelAgent instances.
 */
const PARALLEL_AGENT_SIGNATURE_SYMBOL = Symbol.for('google.adk.parallelAgent');

/**
 * Type guard to check if an object is an instance of ParallelAgent.
 * @param obj The object to check.
 * @returns True if the object is an instance of ParallelAgent, false otherwise.
 */
export function isParallelAgent(obj: unknown): obj is ParallelAgent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    PARALLEL_AGENT_SIGNATURE_SYMBOL in obj &&
    obj[PARALLEL_AGENT_SIGNATURE_SYMBOL] === true
  );
}

/**
 * A shell agent that run its sub-agents in parallel in isolated manner.
 *
 * This approach is beneficial for scenarios requiring multiple perspectives or
 * attempts on a single task, such as:
 *
 *  - Running different algorithms simultaneously.
 *  - Generating multiple responses for review by a subsequent evaluation agent.
 *
 * @deprecated Use `Workflow` instead, which expresses the same ordering as a
 * graph and adds routing, retries, HITL and resumability. This class will be
 * removed in a future version. Note that a `Workflow` cannot yet be an
 * `LlmAgent` sub-agent.
 */
@deprecated(
  'ParallelAgent is deprecated in favor of Workflow and will be removed in a' +
    ' future version. Workflow cannot yet be used as an LlmAgent sub-agent.',
)
export class ParallelAgent extends BaseAgent {
  /**
   * A unique symbol to identify ADK parallel agent class.
   */
  readonly [PARALLEL_AGENT_SIGNATURE_SYMBOL] = true;

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const branchAbort = createBranchAbort(context.abortSignal);
    try {
      const agentRuns = this.subAgents.map((subAgent) =>
        subAgent.runAsync(
          createBranchCtxForSubAgent({
            agent: this,
            subAgent,
            originalContext: context,
            abortSignal: branchAbort.controller.signal,
          }),
        ),
      );

      for await (const event of new Aclosing(
        mergeAgentRuns(agentRuns, branchAbort.controller),
      )) {
        if (context.abortSignal?.aborted) {
          return;
        }

        yield event;
      }
    } finally {
      branchAbort.dispose();
    }
  }

  // eslint-disable-next-line require-yield
  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    throw new Error('This is not supported yet for ParallelAgent.');
  }
}

interface BranchAbort {
  readonly controller: AbortController;
  readonly dispose: () => void;
}

/**
 * Creates a branch-scoped {@link AbortController} chained to `parentSignal` so
 * in-flight sibling branches abort cooperatively on early exit or sibling error
 * without leaking the parent listener.
 */
function createBranchAbort(parentSignal?: AbortSignal): BranchAbort {
  const controller = new AbortController();
  if (!parentSignal) {
    return {controller, dispose: () => {}};
  }
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return {controller, dispose: () => {}};
  }
  const onParentAbort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', onParentAbort, {once: true});
  return {
    controller,
    dispose: () => parentSignal.removeEventListener('abort', onParentAbort),
  };
}

interface CreateBranchContextParams {
  readonly agent: BaseAgent;
  readonly subAgent: BaseAgent;
  readonly originalContext: InvocationContext;
  readonly abortSignal: AbortSignal;
}

/**
 * Creates an isolated branch context for a sub-agent bound to `abortSignal`.
 */
function createBranchCtxForSubAgent({
  agent,
  subAgent,
  originalContext,
  abortSignal,
}: CreateBranchContextParams): InvocationContext {
  const branchSuffix = `${agent.name}.${subAgent.name}`;
  const branch = originalContext.branch
    ? `${originalContext.branch}.${branchSuffix}`
    : branchSuffix;

  return new InvocationContext({
    ...originalContext,
    branch,
    abortSignal,
  });
}

/**
 * Merges the agent run event generator.
 *
 * This implementation guarantees for each agent, it won't move on until the
 * generated event is processed by upstream runner.
 *
 * @param agentRuns A list of async generators that yield events from each
 *     agent.
 * @param branchAbortController Branch-scoped controller aborted when iteration
 *     terminates before all sub-agents finish normally.
 * @yield The next event from the merged generator.
 */
async function* mergeAgentRuns(
  agentRuns: AsyncGenerator<Event, void, void>[],
  branchAbortController: AbortController,
): AsyncGenerator<Event, void, void> {
  const closingRuns = agentRuns.map((run) => new Aclosing(run));
  const pendingPromises = new Map<
    number,
    Promise<{result: IteratorResult<Event>; index: number}>
  >();
  let completedNormally = false;

  try {
    for (const [index, run] of closingRuns.entries()) {
      const promise = run.next().then((result) => ({result, index}));
      pendingPromises.set(index, promise);
    }

    while (pendingPromises.size > 0) {
      const {result, index} = await Promise.race(pendingPromises.values());

      if (result.done) {
        pendingPromises.delete(index);
        await closingRuns[index].close();
        continue;
      }

      yield result.value;

      const nextPromise = closingRuns[index]
        .next()
        .then((result) => ({result, index}));
      pendingPromises.set(index, nextPromise);
    }

    completedNormally = true;
  } finally {
    for (const pending of pendingPromises.values()) {
      void pending.catch(() => {});
    }
    if (!completedNormally) {
      branchAbortController.abort();
    }
    await Promise.allSettled(closingRuns.map((run) => run.close()));
  }
}
