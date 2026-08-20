/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Message: the many ways a node can emit display messages — plain string,
 * multi-modal (text + inline image), multiple messages, and streamed partial
 * chunks. One-to-one port of Python
 * `contributing/samples/workflows/message/agent.py`.
 *
 * Python builds these with `Event(message=...)`, which routes the payload
 * through `t_content` and so produces `role: "user"` content. TS has no
 * `message` shorthand on `createEvent`, so the role is spelled out to keep the
 * emitted events identical to Python's.
 *
 * Run (offline):
 *   npm run sample -- tests/integration/workflows/message/agent.ts
 */

import {createEvent, node, Workflow} from '@google/adk';

// A 16x16 solid red PNG, base64 encoded.
const RED_SQUARE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAXElEQVR4nO2TSQ7AIAwD' +
  '7fz/z+ZQtapwmrJc8QklmjBIgZJgIZMiAIl9KYbhjx4fgwosbNxgMrF0+4uhgHnYDM6' +
  'AzQHJeg5HYtyHFfgy2AztN/5tZWfrBtVzkl4DzfQkEPd+cEkAAAAASUVORK5CYII=';

/** Mirrors Python's `sleep_if_not_pytest`: the sample paces itself when run
 * interactively, but must not burn wall-clock inside the test suite. */
async function sleepIfNotUnderTest(seconds: number): Promise<void> {
  if (process.env['VITEST_WORKER_ID'] !== undefined) return;
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** Python's `Event(message=...)` content shape. */
const message = (text: string) => ({
  role: 'user',
  parts: [{text}],
});

const sendString = node(
  async function* () {
    yield createEvent({
      content: message('#1 This is a simple string message.'),
    });
  },
  {name: 'send_string'},
);

const sendMultimodal = node(
  async function* () {
    yield createEvent({
      content: {
        role: 'user',
        parts: [
          {
            text:
              '#2 Here is a multi-modal message with an inline image (red' +
              ' circle):',
          },
          {inlineData: {data: RED_SQUARE_PNG, mimeType: 'image/png'}},
        ],
      },
    });
  },
  {name: 'send_multimodal'},
);

const multipleMessages = node(
  async function* () {
    yield createEvent({content: message('#3 Multiple messages')});
    await sleepIfNotUnderTest(1.0);

    yield createEvent({content: message('Processing step 1...')});
    await sleepIfNotUnderTest(1.0);

    yield createEvent({content: message('Processing step 2...')});
    await sleepIfNotUnderTest(1.0);

    yield createEvent({content: message('Done processing.')});
  },
  {name: 'multiple_messages'},
);

/**
 * Demonstrates streaming by sending a sentence in chunks.
 * The `partial: true` flag tells the UI that this is part of an ongoing
 * message. Partial events are not written to the session, so the node ends by
 * yielding the assembled sentence once as a non-partial event.
 */
const streamSentence = node(
  async function* () {
    yield createEvent({content: message('#4 Starting to stream...')});
    const sentence =
      'This is a streaming message sent in chunks.\n' +
      '\n' +
      'You can stream in markdown as well. For example, the table below:\n' +
      '\n' +
      '| Header 1 | Header 2 |\n' +
      '|----------|----------|\n' +
      '| Cell 1   | Cell 2   |\n' +
      '| Cell 3   | Cell 4   |\n';

    for (let i = 0; i < sentence.length; i += 5) {
      yield createEvent({
        partial: true,
        content: message(sentence.slice(i, i + 5)),
      });
      await sleepIfNotUnderTest(0.2);
    }

    yield createEvent({content: message(sentence)});
  },
  {name: 'stream_sentence'},
);

export const rootAgent = new Workflow({
  name: 'message',
  edges: [
    ['START', sendString, sendMultimodal, multipleMessages, streamSentence],
  ],
});
