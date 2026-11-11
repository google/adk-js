/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `node_output` sample: the four ways a node can produce output,
 * chained. Turn and expectations mirror the Python golden
 * `contributing/samples/workflows/node_output/tests/go.json`.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: node_output', () => {
  it('threads each output style into the next node', async () => {
    const perTurn = await runSample({
      name: 'node_output',
      rootAgent,
      turns: ['go'],
    });
    const events = allEvents(perTurn);

    const outputOf = (author: string) =>
      events.find((e) => e.author === author && e.output !== undefined)?.output;

    expect(outputOf('generate_string_output')).toBe('Processed input: go');
    expect(outputOf('generate_event_output')).toBe(
      'Event wrapped output: Processed input: go',
    );

    const topic = outputOf('generate_pydantic_output') as Record<
      string,
      unknown
    >;
    expect(Object.keys(topic).sort()).toEqual([
      'category',
      'description',
      'title',
    ]);

    expect(finalOutput(events)).toBe(
      'Received Pydantic Model!\n' +
        `Title: ${topic['title']}\n` +
        `Description: ${topic['description']}\n` +
        `Category: ${topic['category']}`,
    );
  });
});
