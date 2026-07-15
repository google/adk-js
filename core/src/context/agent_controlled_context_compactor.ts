/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {CompactedEvent, isCompactedEvent} from '../events/compacted_event.js';
import {createEvent, Event} from '../events/event.js';
import {ContextCompactionTrigger} from '../plugins/base_plugin.js';
import {BaseContextCompactor} from './base_context_compactor.js';
import {BaseSummarizer} from './summarizers/base_summarizer.js';

/**
 * A context compactor that triggers compaction when the agent explicitly
 * requests it via the `ConsolidateContextTool`.
 */
export class AgentControlledContextCompactor implements BaseContextCompactor {
  readonly trigger = ContextCompactionTrigger.AgentControlled;
  private readonly summarizer: BaseSummarizer;

  constructor(options: {summarizer: BaseSummarizer}) {
    this.summarizer = options.summarizer;
  }

  shouldCompact(invocationContext: InvocationContext): boolean {
    return invocationContext.session.state['temp:consolidate_context'] === true;
  }

  async compact(invocationContext: InvocationContext): Promise<void> {
    const events = invocationContext.session.events;
    const activeEvents = this.getActiveEvents(events);

    // Find the consolidate_context tool call.
    const consolidateToolCallIndex = activeEvents.reduce(
      (acc, e, idx) =>
        e.content?.parts?.some(
          (p) => p.functionCall?.name === 'consolidate_context',
        )
          ? idx
          : acc,
      -1,
    );

    if (consolidateToolCallIndex <= 0) {
      // If not found (index -1) or tool call is the first event (index 0),
      // there is nothing to compact before it. Clear flags and return.
      this.clearFlags(invocationContext);
      return;
    }

    // We compact everything BEFORE the consolidate_context tool call.
    const eventsToCompact = activeEvents.slice(0, consolidateToolCallIndex);

    const detail = invocationContext.session.state[
      'temp:consolidate_context_detail'
    ] as string | undefined;

    if (detail) {
      eventsToCompact.push(
        createEvent({
          author: 'system',
          timestamp: eventsToCompact[eventsToCompact.length - 1].timestamp,
          content: {
            role: 'user',
            parts: [
              {
                text: `CRITICAL INSTRUCTION FOR SUMMARY: Please summarize the history. Focus especially on: ${detail}`,
              },
            ],
          },
        }),
      );
    }

    try {
      const compactedEvent = await this.summarizer.summarize(eventsToCompact);
      invocationContext.session.events.push(compactedEvent);
    } catch (error) {
      // If the summarizer fails, log the error, clear the flags, and proceed without compaction.
      // (do not block the agent run)
      console.error('Compaction failed:', error);
    } finally {
      this.clearFlags(invocationContext);
    }
  }

  private clearFlags(invocationContext: InvocationContext) {
    delete invocationContext.session.state['temp:consolidate_context'];
    delete invocationContext.session.state['temp:consolidate_context_detail'];
  }

  private getActiveEvents(events: Event[]): Event[] {
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
}
