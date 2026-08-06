/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `request_input_advanced` sample: an LlmAgent extracts a
 * structured time-off request; short requests auto-approve, longer ones pause
 * for manager approval (structured RequestInput), resumed here by plain text.
 */

import {Event} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

const isPaused = (events: Event[]): boolean =>
  events.some((e) => (e.longRunningToolIds?.length ?? 0) > 0);

const joinedText = (events: Event[]): string =>
  events
    .flatMap((e) => e.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join(' ');

describe('workflow sample: request_input_advanced (HITL)', () => {
  it('extracts the request, pauses for approval, and resumes on "yes"', async () => {
    const perTurn = await runSample({
      name: 'request_input_advanced',
      rootAgent,
      turns: ['I need 3 days off next week for a family trip.', 'yes'],
    });
    const [turn1, turn2] = perTurn;

    // The extractor agent ran, and a >1-day request paused for approval.
    expect(authors(turn1).has('process_request')).toBe(true);
    expect(isPaused(turn1)).toBe(true);

    // The plain-text "yes" approved the request.
    expect(joinedText(turn2)).toContain('Approved');
  });
});
