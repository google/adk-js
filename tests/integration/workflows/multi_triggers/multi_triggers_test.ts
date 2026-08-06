/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `multi_triggers` sample (offline): a node with several
 * predecessors runs once per incoming trigger.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: multi_triggers', () => {
  it('runs the downstream node once per predecessor trigger', async () => {
    const perTurn = await runSample({
      name: 'multi_triggers',
      rootAgent,
      turns: ['abc'],
      offline: true,
    });
    const events = allEvents(perTurn);

    // send_message has three predecessors, so it fires three times.
    const triggered = events.filter((e) => e.author === 'send_message');
    expect(triggered.length).toBe(3);
    expect(
      triggered.every((e) =>
        (e.content?.parts ?? []).some((p) => p.text?.includes('Triggered for')),
      ),
    ).toBe(true);
  });
});
