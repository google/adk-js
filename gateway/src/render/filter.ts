/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Choosing which events a client sees.
 *
 * A run emits far more than an answer — partial text, tool calls, tool results,
 * transfers between agents. A debug UI wants all of it; an application usually
 * wants the reply. Rather than a configuration object describing which kinds to
 * keep, this is three cases, the third being a function.
 */

import {requiresUserInput, type Event} from '@google/adk';

/**
 * What to pass through.
 *
 * - `'final'` — the answer, plus anything the client has to act on. The default.
 * - `'all'` — everything, as the debug server does.
 * - a function — transform an event, or return `undefined` to drop it. A
 *   transform rather than a predicate, so a caller can redact a tool argument
 *   without needing a second hook.
 */
export type EventFilter =
  | 'final'
  | 'all'
  | ((event: Event) => Event | undefined);

/**
 * Whether an event survives `'final'`.
 *
 * Note this is **not** "the last event". An interrupt must always get through:
 * a run that pauses for confirmation and never tells the client why leaves the
 * UI waiting forever on a question it was not shown. Errors are the same — a
 * client that filters them out reports success for a failed turn.
 */
export function isFinalEvent(event: Event): boolean {
  if (requiresUserInput(event)) {
    return true;
  }
  if (event.errorCode !== undefined) {
    return true;
  }
  // Partial events are prefixes of the text that follows; emitting both would
  // duplicate the answer.
  return !event.partial && hasVisibleText(event);
}

/** Applies a filter to one event. */
export function applyFilter(
  filter: EventFilter,
  event: Event,
): Event | undefined {
  if (typeof filter === 'function') {
    return filter(event);
  }
  if (filter === 'all') {
    return event;
  }
  return isFinalEvent(event) ? event : undefined;
}

/** Applies a filter across a stream. */
export async function* filterEvents(
  events: AsyncIterable<Event>,
  filter: EventFilter,
): AsyncGenerator<Event, void, void> {
  for await (const event of events) {
    const kept = applyFilter(filter, event);
    if (kept) {
      yield kept;
    }
  }
}

/** Whether an event carries text a person would read. */
function hasVisibleText(event: Event): boolean {
  return (event.content?.parts ?? []).some(
    (part) =>
      !part.functionCall &&
      !part.functionResponse &&
      typeof part.text === 'string' &&
      part.text.trim() !== '',
  );
}
