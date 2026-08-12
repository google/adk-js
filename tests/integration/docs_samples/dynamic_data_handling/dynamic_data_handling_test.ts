/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Docs sample: `dynamic/data_handling` —
 * https://adk.dev/graphs/dynamic/#data-handling
 *
 * What it demonstrates, and what is asserted here, is that an agent node's
 * output reaches a function node directly — no session-state key in between.
 * Run against recorded responses so the assertion is about the plumbing, not
 * the paragraph the model produced.
 */

import {describe, expect, it} from 'vitest';
import {finalOutput, outputOf, runRecorded} from '../_shared.js';

describe('docs sample: dynamic/data_handling', () => {
  it('hands the agent node output straight to the function node', async () => {
    const events = await runRecorded(
      'dynamic/data_handling',
      ['a short paragraph about why graphs beat long prompts'],
      import.meta.url,
    );

    const draft = outputOf(events, 'draft_agent');
    expect(typeof draft).toBe('string');

    const formatted = String(finalOutput(events));
    const lines = formatted.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.startsWith('| '))).toBe(true);
    // The formatter ran on the draft, rather than on something else.
    expect(formatted).toContain(String(draft).split('\n')[0].trim());
  });
});
