/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../events/event.js';

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
