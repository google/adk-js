/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `message` sample (offline): the ways a node can emit display
 * messages. Turn and expectations mirror the Python golden
 * `contributing/samples/workflows/message/tests/go.json`, which pins the eight
 * non-partial events (partial chunks are deliberately not persisted).
 */

import {describe, expect, it} from 'vitest';
import {allEvents, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

const STREAMED_SENTENCE =
  'This is a streaming message sent in chunks.\n' +
  '\n' +
  'You can stream in markdown as well. For example, the table below:\n' +
  '\n' +
  '| Header 1 | Header 2 |\n' +
  '|----------|----------|\n' +
  '| Cell 1   | Cell 2   |\n' +
  '| Cell 3   | Cell 4   |\n';

describe('workflow sample: message', () => {
  it('emits string, multimodal, multiple and streamed messages', async () => {
    const perTurn = await runSample({
      name: 'message',
      rootAgent,
      turns: ['go'],
      offline: true,
    });
    const events = allEvents(perTurn);

    const texts = events
      .filter((e) => !e.partial)
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text)
      .filter((t): t is string => !!t);

    expect(texts).toEqual([
      '#1 This is a simple string message.',
      '#2 Here is a multi-modal message with an inline image (red circle):',
      '#3 Multiple messages',
      'Processing step 1...',
      'Processing step 2...',
      'Done processing.',
      '#4 Starting to stream...',
      STREAMED_SENTENCE,
    ]);

    const inline = events
      .flatMap((e) => e.content?.parts ?? [])
      .find((p) => p.inlineData);
    expect(inline?.inlineData?.mimeType).toBe('image/png');

    const partials = events.filter((e) => e.partial);
    expect(partials.length).toBe(Math.ceil(STREAMED_SENTENCE.length / 5));
    expect(
      partials
        .flatMap((e) => e.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join(''),
    ).toBe(STREAMED_SENTENCE);
  });
});
