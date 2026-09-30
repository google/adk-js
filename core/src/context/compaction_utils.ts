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
 * @param rawEvents The active raw events to consider for compaction.
 * @param eventRetentionSize The minimum number of raw events to keep at the end of the session.
 * @returns The index in `rawEvents` at which to split. Events before this index will be compacted.
 */
export function calculateRetainStartIndex(
  rawEvents: Event[],
  eventRetentionSize: number,
): number {
  let retainStartIndex = Math.max(0, rawEvents.length - eventRetentionSize);

  // Prevent splitting between a tool call and its response.
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

  return retainStartIndex;
}
