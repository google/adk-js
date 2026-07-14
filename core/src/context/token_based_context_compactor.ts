/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {getContents} from '../agents/processors/content_processor_utils.js';
import {CompactedEvent, isCompactedEvent} from '../events/compacted_event.js';
import {Event} from '../events/event.js';
import {BaseContextCompactor} from './base_context_compactor.js';
import {BaseSummarizer} from './summarizers/base_summarizer.js';

/** Rough estimate used when no usage metadata is available. */
const CHARS_PER_TOKEN = 4;

export interface TokenBasedContextCompactorOptions {
  /**
   * Prompt-size threshold (in tokens) that triggers compaction. Compared
   * against the most recently observed LLM request size
   * (`usageMetadata.promptTokenCount`), falling back to a character-based
   * estimate of the effective contents when no usage metadata is available.
   */
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

    const promptTokenCount = latestPromptTokenCount(
      activeEvents,
      invocationContext,
    );
    if (promptTokenCount === undefined) {
      return false;
    }

    return promptTokenCount > this.tokenThreshold;
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
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      };
    }

    // Append the new compacted event to the session history.
    invocationContext.session.events.push(compactedEvent);
  }
}

/**
 * Returns the most recently observed prompt token count, if available.
 *
 * Mirrors the Python ADK (`apps/compaction.py::_latest_prompt_token_count`):
 * each model response's `usageMetadata.promptTokenCount` is the measured size
 * of the entire request that produced it (system instruction + tools + full
 * history), so the latest one is used directly. These values must not be
 * summed across events: each already includes all prior history, so a sum
 * grows with call count rather than context size.
 */
function latestPromptTokenCount(
  activeEvents: Event[],
  invocationContext: InvocationContext,
): number | undefined {
  for (let i = activeEvents.length - 1; i >= 0; i--) {
    const count = activeEvents[i].usageMetadata?.promptTokenCount;
    if (count !== undefined) {
      return count;
    }
  }
  return estimatePromptTokenCount(activeEvents, invocationContext);
}

/**
 * Returns an approximate prompt token count from the active events.
 *
 * Mirrors the effective content-building path used by the content request
 * processor, so the estimate aligns with what would actually be sent to the
 * LLM (it cannot account for the system instruction or tool schemas, which
 * are not derivable from session events).
 */
function estimatePromptTokenCount(
  activeEvents: Event[],
  invocationContext: InvocationContext,
): number | undefined {
  const contents = getContents(
    activeEvents,
    invocationContext.agent.name,
    invocationContext.branch,
  );

  let totalChars = 0;
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (part.text) {
        totalChars += part.text.length;
      }
      if (part.functionCall) {
        totalChars += JSON.stringify(part.functionCall).length;
      }
      if (part.functionResponse) {
        totalChars += JSON.stringify(part.functionResponse).length;
      }
    }
  }

  if (totalChars <= 0) {
    return undefined;
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
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
