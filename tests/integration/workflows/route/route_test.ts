/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `samples/workflows/route` agent with recorded model responses:
 * an LlmAgent classifies the input and the workflow routes to the matching
 * branch.
 */

import {Event} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

/** The route(s) emitted by the routing node across events. */
function routes(events: Event[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (typeof event.route === 'string') out.push(event.route);
    else if (Array.isArray(event.route)) out.push(...event.route.map(String));
  }
  return out;
}

describe('workflow sample: route', () => {
  it('classifies the input and dispatches to exactly one branch', async () => {
    const perTurn = await runSample({
      name: 'route',
      rootAgent,
      turns: ['What is ADK?'],
    });
    const events = allEvents(perTurn);

    // The classifier ran and a single category was routed.
    expect(authors(events).has('classify_input')).toBe(true);
    const routed = routes(events);
    expect(routed.length).toBe(1);
    expect(['question', 'statement', 'other']).toContain(routed[0]);

    // The branch matching the routed category is the one that handled it.
    const branchByRoute: Record<string, string> = {
      question: 'answer_question',
      statement: 'comment_on_statement',
      other: 'handle_other',
    };
    expect(authors(events).has(branchByRoute[routed[0]])).toBe(true);
  });
});
