/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `samples/workflows/dynamic_nodes` agent with recorded model
 * responses. Its LlmAgents are captured inside a `dynamicEntry` closure and are
 * unreachable by static traversal — so this proves the registry-level model
 * injection reaches every agent, however it is wired.
 */

import {describe, expect, it} from 'vitest';
import {
  allEvents,
  authors,
  finalOutput,
  runSample,
} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: dynamic_nodes', () => {
  it('drives closure-captured agents via dynamicEntry to a final headline', async () => {
    const perTurn = await runSample({
      name: 'dynamic_nodes',
      rootAgent,
      turns: ['the ocean'],
    });
    const events = allEvents(perTurn);

    // Both closure-captured agents ran (reached only via ctx.runNode).
    expect(authors(events).has('generate_headline')).toBe(true);
    expect(authors(events).has('evaluate_headline')).toBe(true);

    // The bounded loop terminates with a string output (a headline, or the
    // "gave up" message).
    const output = finalOutput(events);
    expect(typeof output).toBe('string');
    expect((output as string).length).toBeGreaterThan(0);
  });
});
