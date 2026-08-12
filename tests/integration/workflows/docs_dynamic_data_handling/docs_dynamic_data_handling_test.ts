/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/dynamic/data_handling` —
 *
 * https://adk.dev/graphs/dynamic/#data-handling An agent node's output reaches
 * a function node directly, with no session-state key in between. Driven
 * against the recorded responses beside this test, so the assertion is about
 * that plumbing rather than the paragraph the model produced.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('docs sample: dynamic/data_handling', () => {
  it('hands the agent node output straight to the function node', async () => {
    const perTurn = await runSample({
      name: 'docs_dynamic_data_handling',
      rootAgent,
      turns: ['a short paragraph about why graphs beat long prompts'],
    });
    const events = allEvents(perTurn);

    const draft = finalOutput(events.filter((e) => e.author === 'draft_agent'));
    expect(typeof draft).toBe('string');

    const formatted = String(finalOutput(events));
    const lines = formatted.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.startsWith('| '))).toBe(true);
    // The formatter ran on the draft, rather than on something else.
    expect(formatted).toContain(String(draft).split('\n')[0].trim());
  });
});
