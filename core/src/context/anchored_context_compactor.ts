/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {CompactedEvent, isScratchpadEvent} from '../events/compacted_event.js';
import {Event, getEventTokens} from '../events/event.js';
import {BaseContextCompactor} from './base_context_compactor.js';
import {calculateRetainStartIndex} from './compaction_utils.js';
import {BaseSummarizer} from './summarizers/base_summarizer.js';

export interface AnchoredContextCompactorOptions {
  /** The maximum number of tokens to retain in the session history before compaction. */
  tokenThreshold: number;
  /**
   * The minimum number of raw events to keep at the end of the session.
   * Compaction will not affect these tail events (unless needed for tool splits).
   */
  eventRetentionSize: number;
  /** The summarizer used to create the compacted event content. */
  summarizer: BaseSummarizer;
}

/**
 * A context compactor that maintains a single persistent 'Scratchpad' or
 * 'State Tracker' event at the top of the context history.
 *
 * When compaction is triggered, it merges new raw events into the existing
 * Scratchpad event and discards them from the active history view.
 */
export class AnchoredContextCompactor implements BaseContextCompactor {
  private readonly tokenThreshold: number;
  private readonly eventRetentionSize: number;
  private readonly summarizer: BaseSummarizer;

  constructor(options: AnchoredContextCompactorOptions) {
    this.tokenThreshold = options.tokenThreshold;
    this.eventRetentionSize = options.eventRetentionSize;
    this.summarizer = options.summarizer;
  }

  private getActiveEvents(events: Event[]): Event[] {
    let latestScratchpad: CompactedEvent | undefined = undefined;

    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (isScratchpadEvent(e)) {
        latestScratchpad = e;
        break;
      }
    }

    if (!latestScratchpad) {
      return events;
    }

    const activeRawEvents = events.filter(
      (e) => e.timestamp > latestScratchpad!.endTime && !isScratchpadEvent(e),
    );

    return [latestScratchpad, ...activeRawEvents];
  }

  shouldCompact(
    invocationContext: InvocationContext,
  ): boolean | Promise<boolean> {
    const events = invocationContext.session.events;
    const activeEvents = this.getActiveEvents(events);
    const hasScratchpad =
      activeEvents.length > 0 && isScratchpadEvent(activeEvents[0]);
    const rawEvents = hasScratchpad ? activeEvents.slice(1) : activeEvents;

    if (rawEvents.length <= this.eventRetentionSize) {
      return false;
    }

    const retainStartIndex = calculateRetainStartIndex(
      rawEvents,
      this.eventRetentionSize,
    );
    if (retainStartIndex === 0) {
      return false;
    }

    const totalTokens = activeEvents.reduce(
      (sum, event) => sum + getEventTokens(event),
      0,
    );

    return totalTokens > this.tokenThreshold;
  }

  async compact(invocationContext: InvocationContext): Promise<void> {
    const events = invocationContext.session.events;
    const activeEvents = this.getActiveEvents(events);
    const hasScratchpad =
      activeEvents.length > 0 && isScratchpadEvent(activeEvents[0]);
    const rawEvents = hasScratchpad ? activeEvents.slice(1) : activeEvents;

    if (rawEvents.length <= this.eventRetentionSize) {
      return;
    }

    const retainStartIndex = calculateRetainStartIndex(
      rawEvents,
      this.eventRetentionSize,
    );

    if (retainStartIndex === 0) {
      // Cannot compact if we have to retain everything
      return;
    }

    // Extract raw events to compact.
    const rawEventsToCompact = rawEvents.slice(0, retainStartIndex);

    let scratchpadEvent: CompactedEvent;

    if (hasScratchpad) {
      const existingScratchpad = activeEvents[0] as CompactedEvent;
      scratchpadEvent = await this.summarizer.summarize([
        existingScratchpad,
        ...rawEventsToCompact,
      ]);
    } else {
      scratchpadEvent = await this.summarizer.summarize(rawEventsToCompact);
    }

    // Ensure the event is marked as scratchpad and has system author.
    const updatedScratchpad = {
      ...scratchpadEvent,
      isScratchpad: true,
      author: 'system',
    } as CompactedEvent;

    // Reconstruct the events list: inactive events + new scratchpad + active retained events
    const inactiveEvents = events.slice(0, events.indexOf(activeEvents[0]));
    const retainedRawEvents = rawEvents.slice(retainStartIndex);

    const newEventsList = [
      ...inactiveEvents,
      updatedScratchpad,
      ...retainedRawEvents,
    ];

    // Mutate the original session events array.
    events.length = 0;
    events.push(...newEventsList);
  }
}
