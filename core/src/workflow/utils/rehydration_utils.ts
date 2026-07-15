/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../../agents/invocation_context.js';
import {Session} from '../../sessions/session.js';
import {getOrInitAgentStates} from '../node_runner.js';
import {NodeStatus, isNodeState} from '../node_state.js';

/**
 * Scans historical session events and state metadata to reconstruct `InvocationContext.agentStates`
 * and `InvocationContext.endOfAgents` when resuming a durable session from storage (such as database or GCS).
 *
 * @param session The session loaded from storage containing historical events and state.
 * @param ctx The invocation context to populate with rehydrated checkpoints.
 */
export function rehydrateAgentStates(
  session: Session,
  ctx: InvocationContext,
): void {
  const agentStates = getOrInitAgentStates(ctx);

  if (session.state && typeof session.state === 'object') {
    const sessionState = session.state as Record<string, unknown>;
    if (
      'agentStates' in sessionState &&
      sessionState.agentStates &&
      typeof sessionState.agentStates === 'object'
    ) {
      for (const [key, val] of Object.entries(
        sessionState.agentStates as Record<string, unknown>,
      )) {
        if (!agentStates[key] && isNodeState(val)) {
          agentStates[key] = val;
        }
      }
    }
    if (
      'endOfAgents' in sessionState &&
      sessionState.endOfAgents &&
      typeof sessionState.endOfAgents === 'object'
    ) {
      for (const [key, val] of Object.entries(
        sessionState.endOfAgents as Record<string, unknown>,
      )) {
        if (typeof val === 'boolean') {
          ctx.endOfAgents[key] = val;
        }
      }
    }
  }

  if (Array.isArray(session.events)) {
    for (const event of session.events) {
      if (!event || typeof event !== 'object') continue;

      const eventRecord = event as unknown as Record<string, unknown>;
      const actions = eventRecord.actions as
        | Record<string, unknown>
        | undefined;
      if (actions && typeof actions === 'object') {
        if (
          'nodeExecution' in actions &&
          actions.nodeExecution &&
          typeof actions.nodeExecution === 'object'
        ) {
          const {executionId, nodeName, status, outputPayload} =
            actions.nodeExecution as Record<string, unknown>;
          if (
            executionId &&
            typeof executionId === 'string' &&
            !agentStates[executionId]
          ) {
            agentStates[executionId] = {
              executionId,
              nodeName:
                typeof nodeName === 'string' ? nodeName : 'unknown_node',
              status:
                status === 'PAUSED_HITL'
                  ? NodeStatus.PAUSED_HITL
                  : NodeStatus.COMPLETED,
              outputPayload,
              timestamp:
                typeof eventRecord.timestamp === 'number'
                  ? eventRecord.timestamp
                  : Date.now(),
            };
          }
        }
      }
    }
  }
}

/**
 * Persists current `InvocationContext.agentStates` and `InvocationContext.endOfAgents` snapshots
 * onto the session's state dictionary so they can be securely serialized by session services.
 *
 * @param ctx The invocation context whose states should be saved.
 * @param session The session object to update.
 */
export function persistAgentStatesToSession(
  ctx: InvocationContext,
  session: Session,
): void {
  if (!session.state || typeof session.state !== 'object') {
    session.state = {};
  }
  const sessionState = session.state as Record<string, unknown>;
  sessionState.agentStates = {...getOrInitAgentStates(ctx)};
  sessionState.endOfAgents = {...ctx.endOfAgents};
}
