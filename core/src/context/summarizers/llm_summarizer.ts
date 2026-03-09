/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {BaseSummarizer} from './base_summarizer.js';

/**
 * A summarizer that uses an LLM to generate a compacted representation
 * of existing events.
 */
export class LlmSummarizer implements BaseSummarizer {
  // TODO: Add LLM related configuration properties and initializations here.

  async summarize(events: Event[]): Promise<string> {
    // Basic placeholder implementation.
    // Here we will eventually call an LLM with the events to get a summary.
    return `Summarized ${events.length} events.`;
  }
}
