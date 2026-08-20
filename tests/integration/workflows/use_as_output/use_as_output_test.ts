/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `use_as_output` sample: an orchestrator node delegates to a
 * summarizer with `useAsOutput`, so the child's result becomes the node's
 * output. Turn mirrors the Python golden
 * `contributing/samples/workflows/use_as_output/tests/go.json`.
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
  it("promotes the child's result to the delegating node's output", async () => {
    const perTurn = await runSample({
      name: 'use_as_output',
      rootAgent,
      turns: ['go'],
    });
    const events = allEvents(perTurn);

    expect(authors(events).has('summarizer')).toBe(true);

    const summary = events.find((e) => e.author === 'summarizer');
    expect(summary?.nodeInfo?.messageAsOutput).toBe(true);
    const summaryText = (summary?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');

    expect(finalOutput(events)).toBe(`final: ${summaryText}`);

    const outputFor = summary?.nodeInfo?.outputFor ?? [];
    expect(outputFor[0]).toBe(summary?.nodeInfo?.path);
    expect(outputFor[1]).toContain('orchestrate');

    expect(
      events.filter((e) => e.output === summaryText).map((e) => e.author),
    ).toEqual(['summarizer']);
  }, 60000);
});
