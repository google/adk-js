/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers for answering a HITL interrupt the way a client does: with a function
 * response addressed to the id the framework generated for it, which is only
 * known once the previous turn has run.
 */

import {Event, getFunctionCalls} from '@google/adk';
import {Content} from '@google/genai';

/** The id of the last pending call to `name` across the turns run so far. */
export function pendingCallId(turns: Event[][], name: string): string {
  const ids = turns
    .flat()
    .flatMap((e) => getFunctionCalls(e))
    .filter((c) => c.name === name)
    .map((c) => c.id)
    .filter((id): id is string => !!id);
  if (ids.length === 0) {
    throw new Error(`No pending ${name} call to answer.`);
  }
  return ids[ids.length - 1];
}

/** Builds the function-response turn that answers a pending interrupt. */
export function answer(
  name: string,
  response: Record<string, unknown>,
): (turns: Event[][]) => Content {
  return (turns) => ({
    role: 'user',
    parts: [
      {functionResponse: {id: pendingCallId(turns, name), name, response}},
    ],
  });
}

/** Whether any event in the turn marks the invocation as paused. */
export function isPaused(events: Event[]): boolean {
  return events.some((e) => (e.longRunningToolIds?.length ?? 0) > 0);
}

/** All text parts of the given events, concatenated. */
export function joinedText(events: Event[]): string {
  return events
    .flatMap((e) => e.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join(' ');
}
