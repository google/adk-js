/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `request_input_rerun` sample: a single node raises the
 * RequestInput and, because it is `rerunOnResume: true`, re-runs on resume to
 * consume the reply and route.
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

describe('workflow sample: request_input_rerun (HITL)', () => {
  it('drafts, pauses, and re-runs the node on approval', async () => {
    const perTurn = await runSample({
      name: 'request_input_rerun',
      rootAgent,
      turns: ['My order never arrived and support is ignoring me.', 'approve'],
    });
    const [turn1, turn2] = perTurn;

    expect(authors(turn1).has('draft_email')).toBe(true);
    expect(isPaused(turn1)).toBe(true);

    expect(joinedText(turn2).toLowerCase()).toContain('approved');
    expect(isPaused(turn2)).toBe(false);
  });
});
