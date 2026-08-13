/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `request_input` sample (two-node HITL): an agent drafts a reply,
 * `request_human_review` pauses, and its successor routes on the human's reply.
 * Scenarios mirror the Python goldens
 * `contributing/samples/workflows/request_input/tests/{phone_broke,phone_broke_reject}.json`.
 */

import {describe, expect, it} from 'vitest';
import {answer, isPaused, joinedText} from '../_harness/hitl.js';
import {authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: request_input (HITL)', () => {
  it('drafts, pauses for review, and sends on approval', async () => {
    const perTurn = await runSample({
      name: 'request_input',
      rootAgent,
      turns: ['phone broke', answer('adk_request_input', {result: 'approve'})],
    });
    const [turn1, turn2] = perTurn;

    expect(authors(turn1).has('draft_email')).toBe(true);
    expect(isPaused(turn1)).toBe(true);

    expect(turn2.map((e) => e.route).filter(Boolean)).toEqual(['approved']);
    expect(authors(turn2).has('send_email')).toBe(true);
    expect(joinedText(turn2)).toContain(
      'Draft approved and sent successfully.',
    );
    expect(isPaused(turn2)).toBe(false);
  }, 120000);

  it('rejects the draft', async () => {
    const perTurn = await runSample({
      name: 'request_input',
      rootAgent,
      turns: ['phone broke', answer('adk_request_input', {result: 'reject'})],
    });
    const [, turn2] = perTurn;

    expect(turn2.map((e) => e.route).filter(Boolean)).toEqual(['rejected']);
    expect(joinedText(turn2)).toContain('Draft rejected.');
    expect(isPaused(turn2)).toBe(false);
  }, 120000);

  it.skip('revises on feedback, then sends on approval', async () => {
    const perTurn = await runSample({
      name: 'request_input',
      rootAgent,
      turns: [
        'phone broke',
        answer('adk_request_input', {result: 'shorter'}),
        answer('adk_request_input', {result: 'approve'}),
      ],
    });
    const [, turn2, turn3] = perTurn;

    expect(turn2.map((e) => e.route).filter(Boolean)).toEqual(['revise']);
    expect(turn2.map((e) => e.actions?.stateDelta ?? {})).toContainEqual({
      feedback: 'shorter',
    });
    expect(authors(turn2).has('draft_email')).toBe(true);
    expect(isPaused(turn2)).toBe(true);

    expect(turn3.map((e) => e.route).filter(Boolean)).toEqual(['approved']);
    expect(joinedText(turn3)).toContain(
      'Draft approved and sent successfully.',
    );
  }, 120000);
});
