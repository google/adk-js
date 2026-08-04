/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Runs the real `state` sample (offline): read/write shared workflow state. */

import {describe, expect, it} from 'vitest';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: state', () => {
  it('threads values through ctx.state across nodes', async () => {
    const perTurn = await runSample({
      name: 'state',
      rootAgent,
      turns: ['hello world'],
      offline: true,
    });
    const output = finalOutput(allEvents(perTurn));

    expect(typeof output).toBe('string');
    expect(output as string).toContain('Final Result:');
    // Uppercased value + the original are both threaded through state.
    expect(output as string).toContain('HELLO WORLD');
    expect(output as string).toContain('Original was: hello world');
  });
});
