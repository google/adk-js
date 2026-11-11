/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers for sealing an aborted invocation in session history.
 *
 * When an invocation is cancelled mid-flight, the function calls it issued
 * without a matching response are answered with synthetic error responses
 * built here, and a plain abort event is recorded when there is nothing to
 * answer. Request building would drop such orphaned calls anyway; sealing them
 * instead lets the model see that the call was aborted, and gives agent
 * routing and compaction a consistent history.
 *
 * The sealing events are persisted and visible to callers: they carry
 * `errorCode: 'INVOCATION_ABORTED'`, and every one is authored by an agent,
 * either the agent that issued the sealed call or, when nothing is dangling,
 * the root agent. Readers of session history (agent routing) use
 * {@link isAbortEvent} to recognize them rather than their author.
 *
 * Mirrors adk-python's `google.adk.events._abort_events`.
 */

import {FunctionCall} from '@google/genai';

import {
  createEvent,
  Event,
  getFunctionCalls,
  getFunctionResponses,
  isFinalResponse,
} from './event.js';

export const INVOCATION_ABORTED = 'INVOCATION_ABORTED';
export const ABORT_MESSAGE = 'Invocation was aborted by client.';

/**
 * Returns whether `event` was synthesized to seal an aborted invocation.
 */
export function isAbortEvent(event: Event): boolean {
  return event.errorCode === INVOCATION_ABORTED;
}

/**
 * Whether a task agent already paused on this event to wait for the user.
 */
function isPausedTaskReply(event: Event): boolean {
  return (
    Boolean(event.isolationScope) &&
    event.author !== 'user' &&
    isFinalResponse(event)
  );
}

/** Parameters for {@link buildAbortEvents}. */
export interface BuildAbortEventsParams {
  /** The session history, in chronological order. */
  events: Event[];
  /** The aborted invocation; only its events are considered. */
  invocationId: string;
  /** Author of the abort event returned when nothing is dangling. */
  rootAgentName: string;
  /**
   * Branch for calls whose event has no branch, and for the abort event
   * returned when nothing is dangling.
   */
  branch?: string;
}

/**
 * Returns the events that seal an aborted invocation.
 *
 * Each dangling function call gets a synthetic error response carrying the
 * author, branch and isolation scope of the event that issued it, so the
 * response pairs with its call in the issuing agent's own view. Calls sharing
 * those three values are grouped into one event. If nothing is dangling, a
 * single content-less abort event authored by the root agent is returned
 * instead.
 *
 * Long-running calls (including confirmation and credential requests) are
 * sealed too: the invocation that issued them is gone, so they are not left
 * pending for a later turn.
 *
 * @returns The synthetic events, in the order they should be appended.
 */
export function buildAbortEvents({
  events,
  invocationId,
  rootAgentName,
  branch,
}: BuildAbortEventsParams): Event[] {
  const invocationEvents = events.filter(
    (e) => e.invocationId === invocationId,
  );
  if (
    invocationEvents.length > 0 &&
    isPausedTaskReply(invocationEvents[invocationEvents.length - 1])
  ) {
    return [];
  }

  const answeredCallIds = new Set<string>();
  for (const event of invocationEvents) {
    for (const fr of getFunctionResponses(event)) {
      if (fr.id) {
        answeredCallIds.add(fr.id);
      }
    }
  }

  // Keyed by author, branch and isolation scope; a Map keeps insertion order.
  const groupedCalls = new Map<
    string,
    {
      author?: string;
      branch?: string;
      isolationScope?: string;
      calls: FunctionCall[];
    }
  >();
  for (const event of invocationEvents) {
    for (const fc of getFunctionCalls(event)) {
      if (!fc.id || answeredCallIds.has(fc.id)) {
        continue;
      }
      const callBranch = event.branch || branch;
      const key = JSON.stringify([
        event.author ?? null,
        callBranch ?? null,
        event.isolationScope ?? null,
      ]);
      let group = groupedCalls.get(key);
      if (!group) {
        group = {
          author: event.author,
          branch: callBranch,
          isolationScope: event.isolationScope,
          calls: [],
        };
        groupedCalls.set(key, group);
      }
      group.calls.push(fc);
    }
  }

  if (groupedCalls.size === 0) {
    return [
      createEvent({
        invocationId,
        author: rootAgentName,
        branch,
        errorCode: INVOCATION_ABORTED,
        errorMessage: ABORT_MESSAGE,
      }),
    ];
  }

  return [...groupedCalls.values()].map((group) =>
    createEvent({
      invocationId,
      author: group.author,
      branch: group.branch,
      isolationScope: group.isolationScope,
      content: {
        role: 'user',
        parts: group.calls.map((fc) => ({
          functionResponse: {
            id: fc.id,
            name: fc.name,
            response: {error: ABORT_MESSAGE},
          },
        })),
      },
      errorCode: INVOCATION_ABORTED,
      errorMessage: ABORT_MESSAGE,
    }),
  );
}
