/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {CompactedEvent, isCompactedEvent} from '../events/compacted_event.js';
import {Event, stringifyContent} from '../events/event.js';
import {BaseContextCompactor} from './base_context_compactor.js';
import {BaseSummarizer} from './summarizers/base_summarizer.js';

export interface TokenBasedContextCompactorOptions {
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
 * A context compactor that uses token count to determine when to compact events.
 * Oldest events are summarized into a CompactedEvent when the session
 * history exceeds the token threshold.
 */
export class TokenBasedContextCompactor implements BaseContextCompactor {
  private readonly tokenThreshold: number;
  private readonly eventRetentionSize: number;
  private readonly summarizer: BaseSummarizer;

  constructor(options: TokenBasedContextCompactorOptions) {
    this.tokenThreshold = options.tokenThreshold;
    this.eventRetentionSize = options.eventRetentionSize;
    this.summarizer = options.summarizer;
  }

  private getActiveEvents(events: Event[]): Event[] {
    let latestCompactedEvent: CompactedEvent | undefined = undefined;

    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (isCompactedEvent(e)) {
        if (!latestCompactedEvent || e.endTime > latestCompactedEvent.endTime) {
          latestCompactedEvent = e as CompactedEvent;
        }
      }
    }

    if (!latestCompactedEvent) {
      return events;
    }

    const activeRawEvents = events.filter(
      (e) =>
        !isCompactedEvent(e) && e.timestamp > latestCompactedEvent!.endTime,
    );

    return [latestCompactedEvent, ...activeRawEvents];
  }

  shouldCompact(
    invocationContext: InvocationContext,
  ): boolean | Promise<boolean> {
    const events = invocationContext.session.events;
    const activeEvents = this.getActiveEvents(events);
    const rawEvents = activeEvents.filter((e) => !isCompactedEvent(e));

    if (rawEvents.length <= this.eventRetentionSize) {
      return false;
    }

    let totalTokens = 0;
    for (const event of activeEvents) {
      totalTokens += getEventTokens(event);
    }

    return totalTokens > this.tokenThreshold;
  }

  async compact(invocationContext: InvocationContext): Promise<void> {
    const events = invocationContext.session.events;
    const activeEvents = this.getActiveEvents(events);
    const rawEvents = activeEvents.filter((e) => !isCompactedEvent(e));

    if (rawEvents.length <= this.eventRetentionSize) {
      return;
    }

    // Determine the baseline index to retain from the active raw events.
    let retainStartIndex = Math.max(
      0,
      rawEvents.length - this.eventRetentionSize,
    );

    // Prevent splitting between a tool call and its response.
    while (retainStartIndex > 0) {
      const eventToRetain = rawEvents[retainStartIndex];
      const previousEvent = rawEvents[retainStartIndex - 1];

      if (
        hasFunctionResponse(eventToRetain) &&
        hasFunctionCall(previousEvent)
      ) {
        retainStartIndex--;
      } else {
        // No conflict, safe to split here.
        break;
      }
    }

    if (retainStartIndex === 0) {
      // Cannot compact if we have to retain everything
      return;
    }

    // Extract raw events to compact.
    const rawEventsToCompact = rawEvents.slice(0, retainStartIndex);
    const compactedEventPresent = activeEvents.find(isCompactedEvent);

    const eventsToCompact = compactedEventPresent
      ? [compactedEventPresent, ...rawEventsToCompact]
      : rawEventsToCompact;

    const compactedEvent = await this.summarizer.summarize(eventsToCompact);

    // Provide default actions and metadata if the summarizer omits it
    if (!compactedEvent.actions) {
      compactedEvent.actions = {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfigs: [],
        requestedToolConfirmations: {},
      };
    }

    // Append the new compacted event to the session history.
    invocationContext.session.events.push(compactedEvent);
  }
}

function getEventTokens(event: Event): number {
  if (event.usageMetadata?.promptTokenCount !== undefined) {
    return event.usageMetadata.promptTokenCount;
  }
  // Estimate: 4 chars per token.
  const contentStr = stringifyContent(event);
  return Math.ceil(contentStr.length / 4);
}

function hasFunctionCall(event: Event): boolean {
  return !!event.content?.parts?.some(
    (part) => part.functionCall !== undefined,
  );
}

function hasFunctionResponse(event: Event): boolean {
  return !!event.content?.parts?.some(
    (part) => part.functionResponse !== undefined,
  );
}
