/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isCompactedEvent} from '../events/compacted_event.js';
import {
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../events/event.js';

/**
 * Filters the events to return only the active events since the latest compaction.
 * If no compaction has occurred, returns all events.
 *
 * @param events The full history of events.
 * @param currentIsolationScope The scope of the caller. Events tagged with a
 *   different scope are withheld.
 * @returns The active events, starting with the latest CompactedEvent if present.
 */
export function getActiveEvents(
  events: Event[],
  currentIsolationScope?: string,
): Event[] {
  const visibleEvents = events.filter((event) =>
    isEventVisibleInIsolationScope(event, currentIsolationScope),
  );
  const latest = visibleEvents.filter(isCompactedEvent).pop();
  return latest
    ? [
        latest,
        ...visibleEvents.filter(
          (e) => !isCompactedEvent(e) && e.timestamp > latest.endTime,
        ),
      ]
    : visibleEvents;
}

/**
 * Whether an event is visible to a caller's isolation scope.
 * Untagged events are shared history; tagged events are visible only to their
 * own scope. An unscoped caller therefore sees only shared history.
 */
export function isEventVisibleInIsolationScope(
  event: Event,
  currentIsolationScope?: string,
): boolean {
  return (
    event.isolationScope === undefined ||
    event.isolationScope === currentIsolationScope
  );
}

/**
 * Determines the baseline index to retain from active raw events,
 * ensuring we don't split between a function call and its response.
 *
 * Two checks protect a pair, mirroring the two places that can otherwise
 * observe half of it:
 * - Adjacent pairs: while the event before the split contains a function call
 *   and the event at the split contains a function response, move the split
 *   earlier.
 * - Non-adjacent pairs: extend the retained tail back to the nearest preceding
 *   call for every retained response ID, following any dependencies that
 *   extension exposes. This matches the content builder, which pairs calls and
 *   responses by ID alone after filtering by scope and branch, so a call on a
 *   sub-agent branch answered by an unbranched user response is still kept.
 *
 * @param rawEvents The active raw events to consider for compaction. They are
 *   already filtered to the caller's isolation scope.
 * @param eventRetentionSize The minimum number of raw events to keep at the end of the session.
 * @returns The index in `rawEvents` at which to split. Events before this index will be compacted.
 */
export function calculateRetainStartIndex(
  rawEvents: Event[],
  eventRetentionSize: number,
): number {
  let retainStartIndex = Math.max(0, rawEvents.length - eventRetentionSize);

  // Prevent splitting between an adjacent tool call and its response.
  while (retainStartIndex > 0) {
    const eventToRetain = rawEvents[retainStartIndex];
    const previousEvent = rawEvents[retainStartIndex - 1];

    if (
      getFunctionResponses(eventToRetain).length > 0 &&
      getFunctionCalls(previousEvent).length > 0
    ) {
      retainStartIndex--;
    } else {
      // No conflict, safe to split here.
      break;
    }
  }

  // State-only events can separate a call from its response. Pair by response
  // ID alone, exactly like `rearrangeEventsForLatestFunctionResponse`, and
  // record each response's nearest preceding call. Branch and scope tags are
  // not part of the key: `rawEvents` is scope-filtered, the branch is filtered
  // by the content builder, and a user response to a sub-agent call carries no
  // branch at all.
  const latestCalls = new Map<string, number>();
  const callDependencies = rawEvents.map((event, index) => {
    let earliestCall = index;
    for (const response of getFunctionResponses(event)) {
      if (response.id === undefined) continue;
      const callIndex = latestCalls.get(response.id);
      if (callIndex !== undefined) {
        earliestCall = Math.min(earliestCall, callIndex);
      }
    }
    // Register calls after responses so a later reuse of an ID cannot match
    // a response that came before it.
    for (const call of getFunctionCalls(event)) {
      if (call.id === undefined) continue;
      latestCalls.set(call.id, index);
    }
    return earliestCall;
  });

  // Extending the retained tail may expose more responses whose calls also
  // need to be retained, including when the original split was a state event.
  // The loop bound shrinks as `retainStartIndex` moves backwards; that is
  // intentional, and is what follows chained dependencies exposed by the
  // extension (a newly retained call may itself answer an earlier response).
  for (let index = rawEvents.length - 1; index >= retainStartIndex; index--) {
    retainStartIndex = Math.min(retainStartIndex, callDependencies[index]);
  }

  return retainStartIndex;
}
