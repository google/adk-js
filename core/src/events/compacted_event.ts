/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event, createEvent} from './event.js';

/**
 * A specialized Event type that represents a synthesized summary of past events.
 * This is used to compress session history without losing critical context.
 */
export interface CompactedEvent extends Event {
  /**
   * Identifies this event as a compacted event.
   */
  readonly isCompacted: true;

  /**
   * The start time of the context that was compacted.
   */
  startTime: number;

  /**
   * The end time of the context that was compacted.
   */
  endTime: number;

  /**
   * The summarized content of the compacted events.
   */
  compactedContent: string;

  /**
   * Identifies this compacted event as the persistent context scratchpad.
   */
  isScratchpad?: boolean;
}

/**
 * Type guard to check if an event is a CompactedEvent.
 */
export function isCompactedEvent(event: Event): event is CompactedEvent {
  return 'isCompacted' in event && event.isCompacted === true;
}

/**
 * Type guard to check if an event is a scratchpad CompactedEvent.
 */
export function isScratchpadEvent(
  event: Event,
): event is CompactedEvent & {isScratchpad: true} {
  return (
    isCompactedEvent(event) && (event as CompactedEvent).isScratchpad === true
  );
}

export function createCompactedEvent(
  params: Partial<CompactedEvent> = {},
): CompactedEvent {
  return {
    ...createEvent(params),
    isCompacted: params.isCompacted || true,
    startTime: params.startTime!,
    endTime: params.endTime!,
    compactedContent: params.compactedContent!,
    isScratchpad: params.isScratchpad,
  };
}
