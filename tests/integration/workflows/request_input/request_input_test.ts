/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `samples/workflows/request_input` agent with recorded model
 * responses across two turns: it drafts an email (live model), pauses for human
 * review (HITL interrupt), then resumes from a plain-text "approve" reply.
 */

import {Event} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

function isPaused(events: Event[]): boolean {
  return events.some((e) => (e.longRunningToolIds?.length ?? 0) > 0);
}

function joinedText(events: Event[]): string {
  return events
    .flatMap((e) => e.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join(' ');
}

describe('workflow sample: request_input (HITL)', () => {
  it('drafts, pauses for review, and resumes on a plain-text approval', async () => {
    const perTurn = await runSample({
      name: 'request_input',
      rootAgent,
      turns: ['The product I bought broke after a day.', 'approve'],
    });
    const [turn1, turn2] = perTurn;

    // Turn 1: the draft agent ran and the workflow paused for human review.
    expect(authors(turn1).has('draft_email')).toBe(true);
    expect(isPaused(turn1)).toBe(true);

    // Turn 2: the plain-text "approve" resumed the workflow to the send branch.
    expect(joinedText(turn2).toLowerCase()).toContain('approved');
    expect(isPaused(turn2)).toBe(false);
  });
});
