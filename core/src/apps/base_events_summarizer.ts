import { Event } from '../events/event.js';

/**
 * Base interface for compacting events.
 */
export abstract class BaseEventsSummarizer {
  /**
   * Compact a list of events into a single event
   * If compaction failed, return None. Otherwise, compact into a content and
  return it.

  This method will summarize the events and return a new summray event
  indicating the range of events it summarized.

  Args:
    events: Events to compact.

  Returns:
    The new compacted event, or None if no compaction happended.
   */
  abstract maybeSummarizeEvents(events: Event[]): Promise<Event | undefined>;
}
