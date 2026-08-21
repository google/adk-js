/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `multi_triggers` sample (offline): one successor node is
 * triggered once per upstream branch, each with that branch's payload. Turn and
 * expectations mirror the Python golden
 * `contributing/samples/workflows/multi_triggers/tests/go.json`.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: multi_triggers', () => {
  it('fires the successor once per triggering branch', async () => {
    const perTurn = await runSample({
      name: 'multi_triggers',
      rootAgent,
      turns: ['go'],
      offline: true,
    });
    const events = allEvents(perTurn);

    const texts = events
      .filter((e) => e.author === 'send_message')
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text ?? '');

    expect(texts).toHaveLength(3);
    expect(texts.sort()).toEqual(
      [
        'Triggered for input: GO',
        'Triggered for input: 2',
        'Triggered for input: og',
      ].sort(),
    );
  });
});
