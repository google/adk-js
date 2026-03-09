/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';

/**
 * Interface for summarizing a list of events into a single string representation.
 */
export interface BaseSummarizer {
  /**
   * Summarizes the given events into a compact string.
   *
   * @param events The events to summarize.
   * @returns A promise resolving to the summarized string representation of the events.
   */
  summarize(events: Event[]): Promise<string>;
}
