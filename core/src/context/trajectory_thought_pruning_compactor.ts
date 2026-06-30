/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {hasThoughts, pruneThoughts} from '../events/event.js';
import {BaseContextCompactor} from './base_context_compactor.js';

/**
 * Options for TrajectoryThoughtPruningCompactor.
 */
export interface TrajectoryThoughtPruningCompactorOptions {
  /**
   * The minimum number of raw events to keep at the end of the session.
   * Compaction will not affect these tail events.
   */
  eventRetentionSize: number;
}

/**
 * A context compactor that prunes thought parts from older events in the session history.
 * Preserves the causal history (actions and observations) while reducing token usage.
 */
export class TrajectoryThoughtPruningCompactor implements BaseContextCompactor {
  private readonly eventRetentionSize: number;

  constructor(options: TrajectoryThoughtPruningCompactorOptions) {
    if (options.eventRetentionSize < 0) {
      throw new Error('eventRetentionSize must be a non-negative integer.');
    }
    this.eventRetentionSize = options.eventRetentionSize;
  }

  shouldCompact(
    invocationContext: InvocationContext,
  ): boolean | Promise<boolean> {
    const events = invocationContext.session.events;
    if (events.length <= this.eventRetentionSize) {
      return false;
    }

    const olderEvents = events.slice(
      0,
      events.length - this.eventRetentionSize,
    );
    return olderEvents.some((event) => hasThoughts(event));
  }

  compact(invocationContext: InvocationContext): void | Promise<void> {
    const events = invocationContext.session.events;
    if (events.length <= this.eventRetentionSize) {
      return;
    }

    const pruneLimit = events.length - this.eventRetentionSize;
    for (let i = 0; i < pruneLimit; i++) {
      const event = events[i];
      if (hasThoughts(event)) {
        events[i] = pruneThoughts(event);
      }
    }
  }
}
