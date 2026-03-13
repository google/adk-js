/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';

import {CompactedEvent} from '../../events/compacted_event.js';

/**
 * Interface for summarizing a list of events into a single CompactedEvent.
 */
export interface BaseSummarizer {
  /**
   * Summarizes the given events into a CompactedEvent.
   *
   * @param events The events to summarize.
   * @returns A promise resolving to the CompactedEvent representation of the events.
   */
  summarize(events: Event[]): Promise<CompactedEvent>;
}
