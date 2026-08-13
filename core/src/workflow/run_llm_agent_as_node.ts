/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {
  InvocationContext,
  WorkflowInstructionScope,
} from '../agents/invocation_context.js';
import {LlmAgent} from '../agents/llm_agent.js';
import {
  createEvent,
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../events/event.js';
import {
  FINISH_TASK_SUCCESS_RESULT,
  FINISH_TASK_TOOL_NAME,
} from '../tools/finish_task_tool.js';
import {isContent} from './base_node.js';
import {NodeContext} from './node_context.js';

/**
 * Runs an {@link LlmAgent} as a workflow node: the node input is appended as a
 * user turn, the agent runs, and its reply becomes the node output.
 *
 * `LlmAgent.runImpl` is the only caller. It is a free function rather than a
 * wrapper node because an agent is already a `BaseNode` — putting a second node
 * around it meant the graph held something that was not the agent the caller
 * passed in, and the agent's own node configuration (`timeout`, `rerunOnResume`,
 * …) was dropped on the floor. adk-python makes the same split: no wrapper
 * class, and `LlmAgent._run_impl` delegating to `run_llm_agent_as_node` in
 * `workflow/_llm_agent_wrapper.py`.
 *
 * Only `LlmAgent` needs this. Any other agent run as a node keeps
 * `BaseAgent.runImpl`, which is plain delegation to `runAsync` — an agent whose
 * input is its conversation has nothing to inject and no model text to promote.
 *
 * `single_turn` and `task` modes are ported; `chat` mode (task delegation via
 * `FinishTaskTool`, isolation scopes) is not yet supported.
 */
export async function* runLlmAgentAsNode(
  agent: LlmAgent,
  ctx: NodeContext,
  nodeInput: unknown,
): AsyncGenerator<Event, void, void> {
  await appendNodeInputAsUserTurn(ctx, nodeInput);

  const agentIc = withWorkflowInstructionScope(ctx.getInvocationContext(), {
    input: nodeInput,
    outputsByNode: collectPredecessorOutputs(ctx),
  });

  if (agent.mode === 'task') {
    yield* runTaskMode(ctx, agentIc, agent);
    return;
  }

  for await (const event of agent.runAsync(agentIc)) {
    maybeSetOutput(agent, event);
    yield event;
  }
}

/**
 * Appends the node input to the session as a user turn, so the agent responds
 * to it.
 */
async function appendNodeInputAsUserTurn(
  ctx: NodeContext,
  nodeInput: unknown,
): Promise<void> {
  if (nodeInput === undefined || nodeInput === null) {
    return;
  }
  const userEvent = createEvent({
    author: 'user',
    invocationId: ctx.invocationId,
    branch: ctx.branch,
    content: toUserContent(nodeInput),
  });
  if (ctx.isolationScope) {
    userEvent.isolationScope = ctx.isolationScope;
  }
  const sessionService = ctx.invocationContext.sessionService;
  if (sessionService) {
    await sessionService.appendEvent({session: ctx.session, event: userEvent});
  } else {
    ctx.session.events.push(userEvent);
  }
}

/**
 * Runs a `task`-mode agent: the agent loops (LLM ↔ tools) until it calls the
 * `finish_task` tool. We sniff the `finish_task` function call and, on its
 * successful function response, promote the call's arguments to the node output
 * (and to `outputKey` state, if set). Mirrors adk-python's
 * `run_llm_agent_as_node` task branch.
 */
async function* runTaskMode(
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
      pendingArgs = {...(finishCall.args ?? {})};
      yield event;
      continue;
    }

    if (pendingArgs !== undefined && isFinishTaskSuccessResponse(event)) {
      const output = finishTool.extractOutput(pendingArgs);
      event.output = output;
      event.nodeInfo = {...(event.nodeInfo ?? {}), messageAsOutput: true};
      if (agent.outputKey && output !== undefined) {
        ctx.state.set(agent.outputKey, output);
        event.actions.stateDelta[agent.outputKey] = output;
      }
      yield event;
      return;
    }

    yield event;
  }

  throw new Error(
    `Task-mode agent '${agent.name}' ended without calling finish_task; ` +
      'no output was produced.',
  );
}

/**
 * Promotes the final model text of an event to the node output (mirroring
 * adk-python `process_llm_agent_output`).
 */
function maybeSetOutput(agent: LlmAgent, event: Event): void {
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

  let output: unknown = text;
  if (agent.outputSchema && text.trim()) {
    try {
      output = JSON.parse(text);
    } catch {
      output = text;
    }
  }

  event.output = output;
  event.nodeInfo = {...(event.nodeInfo ?? {}), messageAsOutput: true};
}

/**
 * Creates a child InvocationContext carrying a workflow instruction scope,
 * preserving the shared session/services/cost manager (like `withBranch`).
 */
function withWorkflowInstructionScope(
  ic: InvocationContext,
  scope: WorkflowInstructionScope,
): InvocationContext {
  return ic.clone({workflowInstructionScope: scope});
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
