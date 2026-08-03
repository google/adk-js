/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {BaseAgent} from '../../agents/base_agent.js';
import {
  InvocationContext,
  InvocationContextParams,
  WorkflowInstructionScope,
} from '../../agents/invocation_context.js';
import {isLlmAgent, LlmAgent} from '../../agents/llm_agent.js';
import {
  createEvent,
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../../events/event.js';
import {
  FINISH_TASK_SUCCESS_RESULT,
  FINISH_TASK_TOOL_NAME,
} from '../../tools/finish_task_tool.js';
import {BaseNode, BaseNodeConfig, isContent} from '../base_node.js';
import {NodeContext} from '../node_context.js';

/** Safety cap on chained `transfer_to_agent` hand-offs. */
const MAX_TRANSFER_DEPTH = 10;

/** Options for an {@link LLMAgentWrapper}. */
export interface LLMAgentWrapperConfig extends Partial<
  Omit<BaseNodeConfig, 'name'>
> {
  name?: string;
}

/**
 * Runs a {@link BaseAgent} (typically an `LlmAgent`) as a workflow node in
 * `single_turn` mode: the node input is appended as a user turn, the agent runs
 * once, and its final model text becomes the node output.
 *
 * Ported (single_turn subset) from `google/adk-python`
 * `workflow/_llm_agent_wrapper.py`. The `task` and `chat` modes (FinishTaskTool,
 * task delegation, transfer, isolation scopes) are a Phase 7b continuation.
 */
export class LLMAgentWrapper extends BaseNode {
  readonly agent: BaseAgent;

  constructor(agent: BaseAgent, config: LLMAgentWrapperConfig = {}) {
    super({
      name: config.name ?? agent.name,
      description: agent.description,
      ...config,
    });
    this.agent = agent;
  }

  protected async *runImpl(
    ctx: NodeContext,
    input: unknown,
  ): AsyncGenerator<Event, void, void> {
    // Append the node input as a user turn so the agent responds to it.
    if (input !== undefined && input !== null) {
      const userEvent = createEvent({
        author: 'user',
        invocationId: ctx.invocationId,
        branch: ctx.branch,
        content: toUserContent(input),
      });
      if (ctx.isolationScope) {
        userEvent.isolationScope = ctx.isolationScope;
      }
      // Persist the injected user turn (not just push it in-memory) so it
      // survives on DB/Vertex session backends and is present on resume.
      // appendEvent also adds it to `session.events` (deduped by id), which the
      // agent reads synchronously to build its request. Falls back to a direct
      // push when no session service is wired (e.g. in unit tests).
      const sessionService = ctx.invocationContext.sessionService;
      if (sessionService) {
        await sessionService.appendEvent({
          session: ctx.session,
          event: userEvent,
        });
      } else {
        ctx.session.events.push(userEvent);
      }
    }

    // Expose the node input and predecessor outputs to `{Class.field}` and
    // `<Class.field from source_node>` instruction placeholders (Python's
    // data-selection syntax). Carried on a child context so it never leaks to
    // sibling/ordinary agent runs.
    const agentIc = withWorkflowInstructionScope(ctx.invocationContext, {
      input,
      outputsByNode: collectPredecessorOutputs(ctx),
    });

    // Task mode: run a multi-round loop until the agent calls `finish_task`,
    // whose arguments become the node output.
    if (isLlmAgent(this.agent) && this.agent.mode === 'task') {
      yield* this.runTaskMode(ctx, agentIc, this.agent);
      return;
    }

    // Run the agent, following any transfer_to_agent hand-offs to peers.
    yield* this.runWithTransfers(ctx, agentIc, this.agent, 0);
  }

  /**
   * Runs a `task`-mode agent: the agent loops (LLM ↔ tools) until it calls the
   * `finish_task` tool. The wrapper sniffs the `finish_task` function call and,
   * on its successful function response, promotes the call's arguments to the
   * node output (and to `outputKey` state, if set). Mirrors Python's
   * `run_llm_agent_as_node` task branch.
   */
  private async *runTaskMode(
    ctx: NodeContext,
    agentIc: InvocationContext,
    agent: LlmAgent,
  ): AsyncGenerator<Event, void, void> {
    const finishTool = agent.finishTaskTool;
    let pendingArgs: Record<string, unknown> | undefined;

    for await (const event of agent.runAsync(agentIc)) {
      const finishCall = getFunctionCalls(event).find(
        (fc) => fc.name === FINISH_TASK_TOOL_NAME,
      );
      if (finishCall) {
        // Remember the latest finish_task args; wait for the success function
        // response before terminating (a validation error lets the LLM retry).
        pendingArgs = {...(finishCall.args ?? {})};
        yield event;
        continue;
      }

      if (pendingArgs !== undefined && isFinishTaskSuccessResponse(event)) {
        const output = finishTool.extractOutput(pendingArgs);
        event.output = output;
        event.nodeInfo = {...(event.nodeInfo ?? {}), messageAsOutput: true};
        if (agent.outputKey && output !== undefined) {
          ctx.actions.stateDelta[agent.outputKey] = output;
        }
        yield event;
        return;
      }

      yield event;
    }
  }

  /**
   * Runs `agent`; if it emits a `transfer_to_agent` action, resolves the target
   * in the agent tree and continues with it (multi-agent hand-off). This is the
   * portable slice of Python's chat mode; autonomous task delegation
   * (FinishTaskTool / task tools / isolation scopes) is not yet supported.
   */
  private async *runWithTransfers(
    ctx: NodeContext,
    agentIc: InvocationContext,
    agent: BaseAgent,
    depth: number,
  ): AsyncGenerator<Event, void, void> {
    if (depth > MAX_TRANSFER_DEPTH) {
      throw new Error(
        `LLMAgentWrapper: transfer_to_agent depth exceeded ${MAX_TRANSFER_DEPTH} ` +
          `(possible transfer loop starting at '${this.agent.name}').`,
      );
    }

    let transferTarget: string | undefined;
    for await (const event of agent.runAsync(agentIc)) {
      this.maybeSetOutput(event);
      yield event;
      if (event.actions?.transferToAgent) {
        transferTarget = event.actions.transferToAgent;
        break;
      }
    }

    if (transferTarget) {
      const target = agent.rootAgent.findAgent(transferTarget);
      if (!target) {
        throw new Error(
          `LLMAgentWrapper: transfer target agent '${transferTarget}' not found.`,
        );
      }
      yield* this.runWithTransfers(ctx, agentIc, target, depth + 1);
    }
  }

  /**
   * Promotes the final model text of an event to the node output (mirroring
   * Python `process_llm_agent_output`).
   */
  private maybeSetOutput(event: Event): void {
    if (event.partial) {
      return;
    }
    if (hasFunctionCalls(event)) {
      return;
    }
    const content = event.content;
    if (!content || content.role !== 'model' || !content.parts) {
      return;
    }
    const text = content.parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('');

    // If the agent declares an output schema, its text is structured JSON;
    // surface the parsed object as the node output (matching Python).
    let output: unknown = text;
    const hasOutputSchema = !!(this.agent as {outputSchema?: unknown})
      .outputSchema;
    if (hasOutputSchema && text.trim()) {
      try {
        output = JSON.parse(text);
      } catch {
        output = text;
      }
    }

    event.output = output;
    event.nodeInfo = {...(event.nodeInfo ?? {}), messageAsOutput: true};
  }
}

/**
 * Creates a child InvocationContext carrying a workflow instruction scope,
 * preserving the shared session/services/cost manager (like `withBranch`).
 */
function withWorkflowInstructionScope(
  ic: InvocationContext,
  scope: WorkflowInstructionScope,
): InvocationContext {
  return new InvocationContext({
    ...(ic as unknown as InvocationContextParams),
    workflowInstructionScope: scope,
  });
}

/**
 * Collects predecessor node outputs (keyed by node name) for the current
 * invocation from the session events, for `<Class.field from source_node>`
 * resolution. Node names are the leaf of each event's `nodeInfo.path` (with any
 * `@runId` suffix stripped).
 */
function collectPredecessorOutputs(ctx: NodeContext): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const event of ctx.session.events) {
    if (event.invocationId !== ctx.invocationId || event.output === undefined) {
      continue;
    }
    const path = event.nodeInfo?.path;
    if (!path) {
      continue;
    }
    const leaf = path.slice(path.lastIndexOf('.') + 1);
    const name = leaf.includes('@') ? leaf.slice(0, leaf.indexOf('@')) : leaf;
    outputs[name] = event.output;
  }
  return outputs;
}

function hasFunctionCalls(event: Event): boolean {
  return (event.content?.parts ?? []).some((p) => p.functionCall);
}

/**
 * Whether an event carries the success function response from `finish_task`.
 * A non-success response (e.g. a validation error) returns false so the caller
 * keeps iterating and the LLM gets a chance to retry.
 */
function isFinishTaskSuccessResponse(event: Event): boolean {
  return getFunctionResponses(event).some((fr) => {
    if (fr.name !== FINISH_TASK_TOOL_NAME) {
      return false;
    }
    const response = (fr.response ?? {}) as {result?: unknown};
    return response.result === FINISH_TASK_SUCCESS_RESULT;
  });
}

/** Converts an arbitrary node input into a user-role `Content`. */
function toUserContent(input: unknown): Content {
  if (isContent(input)) {
    return {...input, role: 'user'};
  }
  if (typeof input === 'string') {
    return {role: 'user', parts: [{text: input}]};
  }
  return {role: 'user', parts: [{text: JSON.stringify(input)}]};
}

/** Heuristic: an agent-like value exposes a `runAsync` method. */
export function isAgentLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'runAsync' in value &&
    typeof (value as {runAsync?: unknown}).runAsync === 'function'
  );
}

// The builder that wraps a BaseAgent in an LLMAgentWrapper is wired into the
// static NODE_BUILDERS list in ../node_builders.ts.
