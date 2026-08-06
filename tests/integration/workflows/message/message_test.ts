/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Runs the real `message` sample (offline): the many ways a node emits messages. */

import {describe, expect, it} from 'vitest';
import {allEvents, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: message', () => {
  it('emits string, multimodal, multiple, and streamed messages', async () => {
    const perTurn = await runSample({
      name: 'message',
      rootAgent,
      turns: ['go'],
      offline: true,
    });
    const events = allEvents(perTurn);
    const parts = events.flatMap((e) => e.content?.parts ?? []);

    // Plain string message.
    expect(parts.some((p) => p.text?.includes('simple string message'))).toBe(
      true,
    );
    // Multi-modal message with an inline image.
    expect(parts.some((p) => p.inlineData?.mimeType === 'image/png')).toBe(
      true,
    );
    // Streamed partial chunks were emitted.
    expect(events.some((e) => e.partial === true)).toBe(true);
  });
});
