/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {BaseContextCompactor} from './base_context_compactor.js';

export interface TruncatingContextCompactorOptions {
  /** The maximum number of events to retain in the session history. */
  threshold: number;
  /** Keep the first X events in the history, which often act as the initial grounding prompt. */
  preserveLeadingEvents?: number;
}

/**
 * A simple context compactor that truncates the oldest events to get under
 * the given threshold limit.
 */
export class TruncatingContextCompactor implements BaseContextCompactor {
  private readonly threshold: number;
  private readonly preserveLeadingEvents: number;

  constructor(options: TruncatingContextCompactorOptions) {
    this.threshold = options.threshold;
    this.preserveLeadingEvents = options.preserveLeadingEvents ?? 0;
  }

  shouldCompact(invocationContext: InvocationContext): boolean {
    const eventsLength = invocationContext.session.events.length;
    return (
      eventsLength > this.threshold + Math.max(0, this.preserveLeadingEvents)
    );
  }

  compact(invocationContext: InvocationContext): void {
    const events = invocationContext.session.events;

    // We only compact if we exceed the threshold considering the preserved events prefix.
    const excess =
      events.length - this.threshold - Math.max(0, this.preserveLeadingEvents);
    if (excess <= 0) {
      return;
    }

    const startIndexToRemove = Math.max(0, this.preserveLeadingEvents);

    events.splice(startIndexToRemove, excess);
  }
}
