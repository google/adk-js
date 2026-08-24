/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/message.
 *
 * Python's `Event(message=...)` is sugar for "content for the human, not
 * output for the next node". TS has no `message` field, so each one becomes
 * `createEvent({content})` — the same distinction the TS docs draw between
 * `content` and `output`.
 *
 * A multi-modal message is a second `Part` on the same content; Python decodes
 * the PNG to bytes and the serializer re-encodes it, so the literal base64 is
 * passed through here instead.
 */
import {createEvent, Event, node, Workflow} from '@google/adk';

async function sleepIfNotPytest(seconds: number): Promise<void> {
  if (!('PYTEST_CURRENT_TEST' in process.env)) {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
}

/** Python's `Event(message=...)`. */
function message(text: string, partial?: boolean): Event {
  return createEvent({
    content: {role: 'model', parts: [{text}]},
    ...(partial ? {partial: true} : {}),
  });
}

/** Sends a single string message. */
const sendString = node(
  function* () {
    yield message('#1 This is a simple string message.');
  },
  {name: 'send_string'},
);

/** Sends a multi-modal message containing a string and an inline image. */
const sendMultimodal = node(
  function* () {
    // A 16x16 solid red PNG base64 encoded
    const redSquarePng =
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAXElEQVR4nO2TSQ7AIAwD' +
      '7fz/z+ZQtapwmrJc8QklmjBIgZJgIZMiAIl9KYbhjx4fgwosbNxgMrF0+4uhgHnYDM6' +
      'AzQHJeg5HYtyHFfgy2AztN/5tZWfrBtVzkl4DzfQkEPd+cEkAAAAASUVORK5CYII=';
    yield createEvent({
      content: {
        role: 'model',
        parts: [
          {
            text:
              '#2 Here is a multi-modal message with an inline image (red' +
              ' circle):',
          },
          {inlineData: {data: redSquarePng, mimeType: 'image/png'}},
        ],
      },
    });
  },
  {name: 'send_multimodal'},
);

/** Sends multiple complete messages from the same node with an interval. */
const multipleMessages = node(
  async function* () {
    yield message('#3 Multiple messages');
    await sleepIfNotPytest(1.0);

    yield message('Processing step 1...');
    await sleepIfNotPytest(1.0);

    yield message('Processing step 2...');
    await sleepIfNotPytest(1.0);

    yield message('Done processing.');
  },
  {name: 'multiple_messages'},
);

/**
 * Demonstrates streaming by sending a sentence in chunks.
 * The `partial=True` flag tells the UI that this is part of an ongoing message.
 * Partial events are not written to the session, so the node ends by yielding
 * the assembled sentence once as a non-partial event.
 */
const streamSentence = node(
  async function* () {
    yield message('#4 Starting to stream...');
    const sentence = `This is a streaming message sent in chunks.

You can stream in markdown as well. For example, the table below:

| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |
| Cell 3   | Cell 4   |
`;

    for (let i = 0; i < sentence.length; i += 5) {
      yield message(sentence.slice(i, i + 5), true);
      await sleepIfNotPytest(0.2);
    }

    yield message(sentence);
  },
  {name: 'stream_sentence'},
);

export const rootAgent = new Workflow({
  name: 'message',
  edges: [
    ['START', sendString, sendMultimodal, multipleMessages, streamSentence],
  ],
});
