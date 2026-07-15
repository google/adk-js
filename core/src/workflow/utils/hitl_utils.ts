/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../../agents/invocation_context.js';
import {createEvent, Event} from '../../events/event.js';
import {isNodeState, NodeStatus} from '../node_state.js';

import {getOrInitAgentStates} from '../node_runner.js';

/**
 * Options when creating a HITL input request.
 */
export interface RequestInputOptions {
  /**
   * Optional custom prompt or question to display to the user.
   */
  prompt?: string;

  /**
   * Optional structured schema or options describing what input is required.
   */
  schema?: Record<string, unknown>;
}

/**
 * Creates an Event that signals a Human-in-the-Loop (`RequestInput`) pause condition to the workflow engine.
 *
 * @param ctx The current invocation context.
 * @param nodeName Name of the node requesting input.
 * @param options Optional prompt and schema describing the required input.
 */
export function createRequestInputEvent(
  ctx: InvocationContext,
  nodeName: string,
  options?: RequestInputOptions,
): Event {
  return createEvent({
    invocationId: ctx.invocationId,
    author: nodeName,
    branch: ctx.branch,
    content: options?.prompt
      ? {role: 'model', parts: [{text: options.prompt}]}
      : undefined,
    actions: {
      requestInput: {
        nodeName,
        prompt: options?.prompt,
        schema: options?.schema,
      },
    },
  });
}

/**
 * Locates any node inside `InvocationContext.agentStates` whose status is `PAUSED_HITL`,
 * and injects the resumption input payload so that subsequent workflow execution can proceed from that node.
 *
 * @param ctx The invocation context being resumed.
 * @param resumptionInput The user's input payload provided upon resumption.
 * @returns The name and execution ID of the resumed node, or undefined if no paused node was found.
 */
export function injectHitlResumptionInput(
  ctx: InvocationContext,
  resumptionInput: unknown,
): {nodeName: string; executionId: string} | undefined {
  const agentStates = getOrInitAgentStates(ctx);

  for (const [execId, state] of Object.entries(agentStates)) {
    if (
      isNodeState(state) &&
      state.status === NodeStatus.COMPLETED &&
      state.wasPausedHitl
    ) {
      continue;
    }
    if (isNodeState(state) && state.status === NodeStatus.PAUSED_HITL) {
      state.status = NodeStatus.RUNNING;
      state.inputPayload = resumptionInput;
      state.wasPausedHitl = true;
      state.timestamp = Date.now();
      return {nodeName: state.nodeName, executionId: execId};
    }
  }

  return undefined;
}
