/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {toContent, type InboundMessage} from '@google/adk-gateway';
import {describe, expect, it} from 'vitest';

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'tg',
    conversation: {channel: 'tg', id: 'chat-1', kind: 'direct'},
    sender: {id: 'u-1'},
    messageId: 'm-1',
    text: 'hello',
    attachments: [],
    mentionsBot: true,
    receivedAt: new Date(),
    raw: {},
    ...overrides,
  };
}

async function textOf(
  content: ReturnType<typeof toContent>,
): Promise<string | undefined> {
  return (await content)?.parts?.map((part) => part.text).join('');
}

describe('toContent', () => {
  it('marks the content as coming from the user', async () => {
    expect((await toContent(message()))?.role).toBe('user');
  });

  it('passes text through untouched in a direct chat', async () => {
    expect(await textOf(toContent(message()))).toBe('hello');
  });

  it('returns nothing when there is nothing for the model to read', async () => {
    expect(await toContent(message({text: undefined}))).toBeUndefined();
    expect(await toContent(message({text: '   '}))).toBeUndefined();
  });

  describe('in a group', () => {
    const inGroup = (overrides: Partial<InboundMessage['sender']> = {}) =>
      message({
        conversation: {channel: 'tg', id: 'chat-1', kind: 'group'},
        sender: {id: 'u-1', ...overrides},
      });

    it('labels the speaker by default', async () => {
      // One session carries many speakers in a group. Unlabelled, the model
      // reads a three-way conversation as one person contradicting themselves.
      const content = toContent(inGroup({displayName: 'Ada', username: 'ada'}));
      expect(await textOf(content)).toBe('Ada (@ada): hello');
    });

    it('uses whatever name it has', async () => {
      expect(await textOf(toContent(inGroup({displayName: 'Ada'})))).toBe(
        'Ada: hello',
      );
      expect(await textOf(toContent(inGroup({username: 'ada'})))).toBe(
        '@ada: hello',
      );
      expect(await textOf(toContent(inGroup()))).toBe('u-1: hello');
    });

    it('can be told not to label', async () => {
      const content = toContent(inGroup({displayName: 'Ada'}), {
        groupIdentity: 'none',
      });
      expect(await textOf(content)).toBe('hello');
    });
  });

  it('does not label in a direct chat even when asked to prefix', async () => {
    // A direct chat has one speaker; naming them every turn is noise.
    const content = toContent(
      message({sender: {id: 'u-1', displayName: 'Ada'}}),
    );
    expect(await textOf(content)).toBe('hello');
  });

  it('inlines an attachment the model can read', async () => {
    const content = await toContent(
      message({
        text: 'look',
        attachments: [
          {
            kind: 'image',
            mimeType: 'image/png',
            fileName: 'cat.png',
            download: async () => new Uint8Array([1, 2, 3]),
          },
        ],
      }),
    );

    expect(content?.parts?.[1].inlineData?.mimeType).toBe('image/png');
  });

  it('describes an attachment the model cannot read', async () => {
    const content = await toContent(
      message({
        text: 'look',
        attachments: [
          {
            kind: 'sticker',
            mimeType: 'application/x-tgsticker',
            download: async () => new Uint8Array([1]),
          },
        ],
      }),
    );

    // The model should know something arrived that it cannot see, rather than
    // reading a bare "look" and wondering.
    expect(content?.parts?.[1].text).toBe('[sticker — unsupported format]');
  });
});
