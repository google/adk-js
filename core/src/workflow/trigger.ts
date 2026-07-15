/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';

/**
 * A predicate function evaluated against the event or output yielded by an upstream node.
 * @param ctx The current invocation context.
 * @param eventOrOutput The event or output payload produced by the source node.
 * @returns True if the transition condition is satisfied, false otherwise.
 */
export type TriggerPredicate = (
  ctx: InvocationContext,
  eventOrOutput: Event | unknown,
) => boolean | Promise<boolean>;

/**
 * Represents a conditional trigger attached to a workflow graph edge.
 * Determines whether a specific transition route should be taken upon upstream node completion.
 */
export class Trigger {
  private readonly routeKey?: string;
  private readonly predicate?: TriggerPredicate;

  private constructor(options: {
    routeKey?: string;
    predicate?: TriggerPredicate;
  }) {
    this.routeKey = options.routeKey;
    this.predicate = options.predicate;
  }

  /**
   * Creates a route matching trigger.
   * The trigger evaluates to true if the emitted `Event.actions.route` (or event payload route) matches `routeKey`.
   * @param routeKey The exact string route key to match.
   */
  static fromRoute(routeKey: string): Trigger {
    if (!routeKey || typeof routeKey !== 'string') {
      throw new Error(
        'Trigger.fromRoute requires a non-empty string routeKey.',
      );
    }
    return new Trigger({routeKey});
  }

  /**
   * Creates a predicate-based trigger.
   * The trigger evaluates to true if the provided predicate function returns true.
   * @param predicate A boolean function evaluated against the context and node output/event.
   */
  static fromPredicate(predicate: TriggerPredicate): Trigger {
    if (typeof predicate !== 'function') {
      throw new Error('Trigger.fromPredicate requires a function predicate.');
    }
    return new Trigger({predicate});
  }

  /**
   * Evaluates whether this trigger is satisfied by the given event or output payload.
   * @param ctx The current invocation context.
   * @param eventOrOutput The event or output payload produced by the source node.
   * @returns Promise resolving to true if the transition should occur, false otherwise.
   */
  async evaluate(
    ctx: InvocationContext,
    eventOrOutput: Event | unknown,
  ): Promise<boolean> {
    if (this.routeKey) {
      if (eventOrOutput && typeof eventOrOutput === 'object') {
        const obj = eventOrOutput as Record<string, unknown>;
        if (
          'actions' in obj &&
          obj.actions &&
          typeof obj.actions === 'object' &&
          'route' in (obj.actions as Record<string, unknown>) &&
          (obj.actions as Record<string, unknown>).route === this.routeKey
        ) {
          return true;
        }
        if ('route' in obj && obj.route === this.routeKey) {
          return true;
        }
      }
      if (eventOrOutput === this.routeKey) {
        return true;
      }
      return false;
    }

    if (this.predicate) {
      return await this.predicate(ctx, eventOrOutput);
    }

    return true;
  }
}
