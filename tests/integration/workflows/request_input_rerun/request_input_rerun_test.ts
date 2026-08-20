/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `request_input_rerun` sample (single-node HITL): one
 * `human_review` node both raises the interrupt and, because it is
 * `rerunOnResume`, re-runs to consume the reply. Scenarios mirror the Python
 * golden
 * `contributing/samples/workflows/request_input_rerun/tests/phone_broke.json`.
 */

import {describe, expect, it} from 'vitest';
import {answer, isPaused, joinedText} from '../_harness/hitl.js';
import {authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: request_input_rerun (HITL)', () => {
  it('re-runs the review node on resume and sends on approval', async () => {
    const perTurn = await runSample({
      name: 'request_input_rerun',
      rootAgent,
      turns: ['phone broke', answer('adk_request_input', {result: 'approve'})],
    });
    const [turn1, turn2] = perTurn;

    expect(authors(turn1).has('draft_email')).toBe(true);
    expect(isPaused(turn1)).toBe(true);

    expect(authors(turn2).has('human_review')).toBe(true);
    expect(turn2.map((e) => e.route).filter(Boolean)).toEqual(['approved']);
    expect(joinedText(turn2)).toContain(
      'Draft approved and sent successfully.',
    );
    expect(isPaused(turn2)).toBe(false);
  }, 120000);

  it('rejects the draft', async () => {
    const perTurn = await runSample({
      name: 'request_input_rerun',
      rootAgent,
      turns: ['phone broke', answer('adk_request_input', {result: 'reject'})],
    });
    const [, turn2] = perTurn;

    expect(turn2.map((e) => e.route).filter(Boolean)).toEqual(['rejected']);
    expect(joinedText(turn2)).toContain('Draft rejected.');
  }, 120000);

  it('re-runs the review node to revise, then approves', async () => {
    const perTurn = await runSample({
      name: 'request_input_rerun',
      rootAgent,
      turns: [
        'phone broke',
        answer('adk_request_input', {result: 'shorter'}),
        answer('adk_request_input', {result: 'approve'}),
      ],
    });
    const [, turn2, turn3] = perTurn;

    expect(turn2.map((e) => e.route).filter(Boolean)).toEqual(['revise']);
    expect(isPaused(turn2)).toBe(true);
    expect(turn3.map((e) => e.route).filter(Boolean)).toEqual(['approved']);
  }, 120000);
});
