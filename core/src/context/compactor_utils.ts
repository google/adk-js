/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CompactedEvent, isCompactedEvent} from '../events/compacted_event.js';
import {Event} from '../events/event.js';

/**
 * Filters the events to return only the active events since the latest compaction.
 * If no compaction has occurred, returns all events.
 *
 * @param events The full history of events.
 * @returns The active events, starting with the latest CompactedEvent if present.
 */
export function getActiveEvents(events: Event[]): Event[] {
  const latest = events.filter(isCompactedEvent).pop() as
    | CompactedEvent
    | undefined;
  return latest
    ? [
        latest,
        ...events.filter(
          (e) => !isCompactedEvent(e) && e.timestamp > latest.endTime,
        ),
      ]
    : events;
}


