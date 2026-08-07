/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `use_as_output` sample: an orchestrator runs a summarizer
 * sub-node with `useAsOutput`, then a finalize node wraps that output.
 */

import {describe, expect, it} from 'vitest';
import {
  allEvents,
  authors,
  finalOutput,
  runSample,
} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: use_as_output', () => {
  it('promotes the sub-node result and wraps it in the final node', async () => {
    const perTurn = await runSample({
      name: 'use_as_output',
      rootAgent,
      turns: [
        'The quick brown fox jumps over the lazy dog, repeatedly, all day.',
      ],
    });
    const events = allEvents(perTurn);

    // The summarizer sub-node ran (reached via ctx.runNode with useAsOutput).
    expect(authors(events).has('summarizer')).toBe(true);

    // The finalize node wrapped the promoted summary as the workflow output.
    const output = finalOutput(events);
    expect(typeof output).toBe('string');
    expect(output as string).toMatch(/^final: /);
  });
});
