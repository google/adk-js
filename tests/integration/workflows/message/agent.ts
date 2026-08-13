/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Vendored copy of samples/workflows/message/agent.ts so this integration test
// is self-contained; keep it in sync with the sample.

/**
 * Message: the many ways a node can emit display messages — plain string,
 * multi-modal (text + inline image), multiple messages, and streamed partial
 * chunks. Faithful port of Python `contributing/samples/workflows/message`.
 *
 * Run (offline):  npm run sample -- samples/workflows/message/agent.ts
 */

import {createEvent, node, Workflow} from '@google/adk';

// A 16x16 solid red PNG, base64 encoded.
const RED_SQUARE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAXElEQVR4nO2TSQ7AIAwD' +
  '7fz/z+ZQtapwmrJc8QklmjBIgZJgIZMiAIl9KYbhjx4fgwosbNxgMrF0+4uhgHnYDM6' +
  'AzQHJeg5HYtyHFfgy2AztN/5tZWfrBtVzkl4DzfQkEPd+cEkAAAAASUVORK5CYII=';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sendString = node(
  async function* () {
    yield createEvent({
      content: {
        role: 'model',
        parts: [{text: '#1 This is a simple string message.'}],
      },
    });
  },
  {name: 'send_string'},
);

const sendMultimodal = node(
  async function* () {
    yield createEvent({
      content: {
        role: 'model',
        parts: [
          {text: '#2 Here is a multi-modal message with an inline image:'},
          {inlineData: {data: RED_SQUARE_PNG, mimeType: 'image/png'}},
        ],
      },
    });
  },
  {name: 'send_multimodal'},
);

const multipleMessages = node(
  async function* () {
    const msg = (text: string) =>
      createEvent({content: {role: 'model', parts: [{text}]}});
    yield msg('#3 Multiple messages');
    await sleep(300);
    yield msg('Processing step 1...');
    await sleep(300);
    yield msg('Processing step 2...');
    await sleep(300);
    yield msg('Done processing.');
  },
  {name: 'multiple_messages'},
);

const streamSentence = node(
  async function* () {
    yield createEvent({
      content: {role: 'model', parts: [{text: '#4 Starting to stream...'}]},
    });
    const sentence =
      'This is a streaming message sent in chunks. ' +
      'You can stream markdown too.';
    for (let i = 0; i < sentence.length; i += 5) {
      yield createEvent({
        partial: true,
        content: {role: 'model', parts: [{text: sentence.slice(i, i + 5)}]},
      });
      await sleep(100);
    }
  },
  {name: 'stream_sentence'},
);

export const rootAgent = new Workflow({
  name: 'message',
  edges: [
    ['START', sendString, sendMultimodal, multipleMessages, streamSentence],
  ],
});
