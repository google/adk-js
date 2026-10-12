/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives the `human_input/rerun_on_resume` sample with plain-text turns, the
 * way the CLI does.
 *
 * The generic `docs_samples_test` only asserts that an offline sample pauses,
 * resumes and produces an output. The claims this sample teaches are about
 * WHICH branch runs, so they need their own assertions: the three routes off
 * `human_review`, and the entry node keeping the original complaint when a
 * plain-text reply re-triggers it.
 */

import {Event} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {rootAgent} from '../../../samples/workflows/human_input/rerun_on_resume/agent.js';
import {isPaused} from '../workflows/_harness/hitl.js';
import {finalOutput, runSample} from '../workflows/_harness/sample_harness.js';

const COMPLAINT = 'the delivery was a week late';

function routes(events: Event[]) {
  return events.map((e) => e.route).filter((route) => route !== undefined);
}

function drafts(events: Event[]): string[] {
  return events
    .filter((e) => e.author === 'draft_reply')
    .map((e) => String(e.output));
}

function run(turns: string[]): Promise<Event[][]> {
  return runSample({
    name: 'human_input/rerun_on_resume',
    rootAgent,
    turns: [COMPLAINT, ...turns],
    offline: true,
  });
}

describe('docs sample: human_input/rerun_on_resume', () => {
  it('pauses on the first turn with the draft to review', async () => {
    const [turn1] = await run([]);

    expect(drafts(turn1)).toEqual([
      `Dear customer, we are sorry about "${COMPLAINT}".`,
    ]);
    expect(isPaused(turn1)).toBe(true);
    expect(routes(turn1)).toEqual([]);
  });

  it('re-runs the review node to revise, then approves', async () => {
    const [, turn2, turn3] = await run(['make it shorter', 'approve']);

    // The reply routes `revise`, and the redraft pauses for a fresh reply
    // rather than reusing the one just consumed.
    expect(routes(turn2)).toEqual(['revise']);
    expect(isPaused(turn2)).toBe(true);
    // The redraft still answers the original complaint: the reply text does
    // not overwrite it, even though it also re-triggers the entry node.
    expect(drafts(turn2)).toEqual([
      `Dear customer, we are sorry about "${COMPLAINT}". (revised for: make it shorter)`,
    ]);

    expect(routes(turn3)).toEqual(['approved']);
    expect(isPaused(turn3)).toBe(false);
    expect(finalOutput(turn3)).toBe('Draft approved and sent successfully.');
  });

  it('rejects the draft', async () => {
    const [, turn2] = await run(['reject']);

    expect(routes(turn2)).toEqual(['rejected']);
    expect(isPaused(turn2)).toBe(false);
    expect(finalOutput(turn2)).toBe('Draft rejected.');
  });
});
