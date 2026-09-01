/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createGateway,
  isAcceptedMimeType,
  normalizeMimeType,
} from '@google/adk-gateway';
import {
  describeSticker,
  largestPhoto,
  normalizeUpdate,
  parseCommand,
  telegram,
  TelegramClient,
  type TgMessage,
  type TgUpdate,
} from '@google/adk-gateway/telegram/index.js';
import {describe, expect, it, vi} from 'vitest';

import {EchoAgent} from './echo_agent.js';

const client = new TelegramClient({token: 'test-token', fetch: vi.fn()});

const options = {channelName: 'telegram', client, botUsername: 'my_bot'};

function update(message: Partial<TgMessage>): TgUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 100,
      date: 1_700_000_000,
      from: {id: 42, is_bot: false, first_name: 'Ada', username: 'ada'},
      chat: {id: 7, type: 'private'},
      ...message,
    } as TgMessage,
  };
}

describe('normalizeUpdate', () => {
  it('reads a plain direct message', () => {
    const message = normalizeUpdate(update({text: 'hello'}), options)!;

    expect(message.channel).toBe('telegram');
    expect(message.text).toBe('hello');
    expect(message.sender).toMatchObject({
      id: '42',
      displayName: 'Ada',
      username: 'ada',
    });
    expect(message.conversation).toMatchObject({id: '7', kind: 'direct'});
    expect(message.mentionsBot).toBe(true);
  });

  it('joins the sender name from both parts', () => {
    const raw = update({text: 'hi'});
    raw.message!.from!.last_name = 'Lovelace';
    expect(normalizeUpdate(raw, options)!.sender.displayName).toBe(
      'Ada Lovelace',
    );
  });

  it('converts the timestamp from seconds', () => {
    const message = normalizeUpdate(update({text: 'hi'}), options)!;
    expect(message.receivedAt.getTime()).toBe(1_700_000_000_000);
  });

  it('ignores an edit, rather than answering the question twice', () => {
    expect(
      normalizeUpdate({update_id: 1, edited_message: {} as TgMessage}, options),
    ).toBeUndefined();
  });

  it('ignores a message with no sender', () => {
    expect(
      normalizeUpdate({update_id: 1, message: {} as TgMessage}, options),
    ).toBeUndefined();
  });

  describe('conversation kind', () => {
    it.each([
      ['private', 'direct'],
      ['group', 'group'],
      ['supergroup', 'group'],
      ['channel', 'channel'],
    ] as const)('maps %s to %s', (type, kind) => {
      const raw = update({text: 'hi'});
      raw.message!.chat = {id: 7, type};
      expect(normalizeUpdate(raw, options)!.conversation.kind).toBe(kind);
    });
  });

  describe('threads', () => {
    it('treats a forum topic as a thread', () => {
      const raw = update({
        text: 'hi',
        message_thread_id: 55,
        is_topic_message: true,
      });
      raw.message!.chat = {id: -100, type: 'supergroup', is_forum: true};
      expect(normalizeUpdate(raw, options)!.conversation.threadId).toBe('55');
    });

    it('ignores a thread id outside a forum', () => {
      // A supergroup puts `message_thread_id` on ordinary reply chains too.
      // Treating those as threads would shatter one chat into a session per
      // reply.
      const raw = update({text: 'hi', message_thread_id: 55});
      raw.message!.chat = {id: -100, type: 'supergroup'};
      expect(
        normalizeUpdate(raw, options)!.conversation.threadId,
      ).toBeUndefined();
    });
  });

  describe('mentions in groups', () => {
    const inGroup = (text: string, extra: Partial<TgMessage> = {}) => {
      const raw = update({text, ...extra});
      raw.message!.chat = {id: -100, type: 'supergroup', title: 'Team'};
      return normalizeUpdate(raw, options)!;
    };

    it('spots an @mention', () => {
      expect(inGroup('hey @my_bot what is up').mentionsBot).toBe(true);
    });

    it('spots a reply to the bot', () => {
      const replied = inGroup('and this?', {
        reply_to_message: {
          message_id: 9,
          date: 1,
          chat: {id: -100, type: 'supergroup'},
          from: {id: 1, is_bot: true, first_name: 'Bot'},
        } as TgMessage,
      });
      expect(replied.mentionsBot).toBe(true);
    });

    it('reports an unaddressed message as not for the bot', () => {
      expect(inGroup('just chatting').mentionsBot).toBe(false);
    });
  });

  describe('media', () => {
    it('picks the largest photo, not the first', () => {
      // Telegram sends sizes ascending; taking [0] gets a postage stamp.
      const message = normalizeUpdate(
        update({
          photo: [
            {
              file_id: 'small',
              file_unique_id: 'a',
              width: 90,
              height: 90,
              file_size: 1000,
            },
            {
              file_id: 'big',
              file_unique_id: 'b',
              width: 1280,
              height: 1280,
              file_size: 90000,
            },
          ],
        }),
        options,
      )!;

      expect(message.attachments).toHaveLength(1);
      expect(message.attachments[0].mimeType).toBe('image/jpeg');
    });

    it('reads a voice note as audio with its duration', () => {
      const message = normalizeUpdate(
        update({voice: {file_id: 'v', duration: 12, mime_type: 'audio/ogg'}}),
        options,
      )!;

      expect(message.attachments[0]).toMatchObject({
        kind: 'audio',
        mimeType: 'audio/ogg',
        durationSec: 12,
      });
    });

    it('gives a video note the mime type Telegram omits', () => {
      const message = normalizeUpdate(
        update({
          video_note: {file_id: 'vn', length: 384, duration: 8},
        }),
        options,
      )!;

      // VideoNote has no mime_type field at all; these are always MPEG-4.
      // With the default `thumbnail` mode and no thumbnail, only the note text
      // survives.
      expect(message.text).toBe('[video message, 0:08]');
    });

    it('sends a video note in full when asked to', () => {
      const message = normalizeUpdate(
        update({video_note: {file_id: 'vn', length: 384, duration: 8}}),
        {...options, media: {videoNote: 'full'}},
      )!;

      expect(message.attachments[0]).toMatchObject({
        kind: 'video',
        mimeType: 'video/mp4',
      });
    });

    it('does not download anything while normalizing', async () => {
      const download = vi.fn();
      const lazyClient = Object.assign(
        Object.create(TelegramClient.prototype) as TelegramClient,
        {download},
      );

      normalizeUpdate(update({voice: {file_id: 'v', duration: 3}}), {
        ...options,
        client: lazyClient,
      });

      // A denied or oversized file should never cost a download.
      expect(download).not.toHaveBeenCalled();
    });
  });

  describe('stickers', () => {
    const sticker = (extra = {}) =>
      normalizeUpdate(
        update({
          sticker: {
            file_id: 's',
            type: 'regular',
            width: 512,
            height: 512,
            is_animated: false,
            is_video: false,
            emoji: '👍',
            set_name: 'Cats',
            thumbnail: {
              file_id: 'thumb',
              file_unique_id: 't',
              width: 128,
              height: 128,
            },
            ...extra,
          },
        }),
        options,
      )!;

    it('says in words what the sticker meant', () => {
      // The emoji is the message; the artwork is decoration.
      expect(sticker().text).toBe('[sticker 👍 from "Cats"]');
    });

    it('attaches a readable image for an animated sticker', () => {
      // A .tgs is gzipped Lottie JSON, which the model cannot read — but
      // Telegram guarantees a WEBP or JPG thumbnail.
      const message = sticker({is_animated: true});
      expect(message.attachments[0]).toMatchObject({
        kind: 'sticker',
        mimeType: 'image/webp',
      });
    });

    it('can be reduced to text only', () => {
      const message = normalizeUpdate(
        update({
          sticker: {
            file_id: 's',
            type: 'regular',
            width: 512,
            height: 512,
            is_animated: false,
            is_video: false,
            emoji: '👍',
          },
        }),
        {...options, media: {sticker: 'emoji'}},
      )!;

      expect(message.text).toBe('[sticker 👍]');
      expect(message.attachments).toEqual([]);
    });
  });

  describe('callback queries', () => {
    it('reads a button press, keeping the id needed to acknowledge it', () => {
      const message = normalizeUpdate(
        {
          update_id: 2,
          callback_query: {
            id: 'cb-1',
            from: {id: 42, is_bot: false, first_name: 'Ada'},
            data: 'approve',
            message: {
              message_id: 100,
              date: 1,
              chat: {id: 7, type: 'private'},
            } as TgMessage,
          },
        },
        options,
      )!;

      expect(message.action).toEqual({id: 'cb-1', payload: 'approve'});
      expect(message.mentionsBot).toBe(true);
    });
  });
});

describe('parseCommand', () => {
  it('reads a bare command', () => {
    expect(parseCommand('/reset')).toEqual({name: 'reset', args: ''});
  });

  it('reads arguments', () => {
    expect(parseCommand('/echo hello world')).toEqual({
      name: 'echo',
      args: 'hello world',
    });
  });

  it('strips the bot suffix Telegram adds in groups', () => {
    expect(parseCommand('/reset@my_bot', 'my_bot')).toEqual({
      name: 'reset',
      args: '',
    });
  });

  it('ignores a command aimed at another bot', () => {
    expect(parseCommand('/reset@other_bot', 'my_bot')).toBeUndefined();
  });

  it('ignores ordinary text', () => {
    expect(parseCommand('not a command')).toBeUndefined();
    expect(parseCommand('3/4 of the way')).toBeUndefined();
  });
});

describe('media helpers', () => {
  it('picks the largest photo size', () => {
    expect(
      largestPhoto([
        {
          file_id: 'a',
          file_unique_id: 'a',
          width: 90,
          height: 90,
          file_size: 100,
        },
        {
          file_id: 'b',
          file_unique_id: 'b',
          width: 800,
          height: 800,
          file_size: 9000,
        },
      ]).file_id,
    ).toBe('b');
  });

  it('describes a sticker with no set', () => {
    expect(
      describeSticker({
        file_id: 's',
        type: 'regular',
        width: 1,
        height: 1,
        is_animated: false,
        is_video: false,
        emoji: '🎉',
      }),
    ).toBe('[sticker 🎉]');
  });

  it('maps the container Telegram reports to the codec the model names', () => {
    // Telegram says audio/ogg; Gemini's accepted list says audio/opus.
    expect(normalizeMimeType('audio/ogg')).toBe('audio/opus');
    expect(isAcceptedMimeType('audio/ogg')).toBe(true);
  });

  it('refuses formats the model cannot read', () => {
    expect(isAcceptedMimeType('application/x-tgsticker')).toBe(false);
    expect(isAcceptedMimeType('image/gif')).toBe(false);
  });

  it('ignores a charset suffix', () => {
    expect(normalizeMimeType('text/plain; charset=utf-8')).toBe('text/plain');
  });
});

describe('the Telegram channel', () => {
  it('defaults to one session per conversation', () => {
    expect(telegram({token: 't'}).session).toEqual({key: 'per-conversation'});
  });

  it('honours a session override', () => {
    expect(telegram({token: 't', session: 'per-user'}).session).toEqual({
      key: 'per-user',
    });
  });

  it("declares Telegram's real limits", () => {
    const capabilities = telegram({token: 't'}).capabilities;
    expect(capabilities.maxTextLength).toBe(4096);
    expect(capabilities.buttonPayloadBytes).toBe(64);
    expect(capabilities.textFormat).toBe('html');
  });

  it('offers native streaming in direct chats only', () => {
    // sendMessageDraft takes a private chat id; groups fall back to edits.
    const channel = telegram({token: 't'});
    expect(
      channel.capabilitiesFor({channel: 'telegram', id: '1', kind: 'direct'})
        .streaming,
    ).toBe('native-draft');
    expect(
      channel.capabilitiesFor({channel: 'telegram', id: '1', kind: 'group'})
        .streaming,
    ).toBe('edit');
  });

  it('exposes a webhook route only when configured for one', () => {
    expect(telegram({token: 't'}).webhook).toBeUndefined();
    expect(telegram({token: 't', webhook: {path: '/tg'}}).webhook?.path).toBe(
      '/tg',
    );
  });

  describe('webhook authentication', () => {
    const channel = telegram({
      token: 't',
      webhook: {path: '/tg', secretToken: 'shhh'},
    });

    it('refuses a request with no secret', async () => {
      expect(await channel.webhook!.handle({body: {}, headers: {}})).toEqual({
        status: 401,
      });
    });

    it('refuses a request with the wrong secret', async () => {
      const result = await channel.webhook!.handle({
        body: {},
        headers: {'x-telegram-bot-api-secret-token': 'guess'},
      });
      expect(result).toEqual({status: 401});
    });

    it('accepts a request with the right secret', async () => {
      const result = await channel.webhook!.handle({
        body: {update_id: 1},
        headers: {'x-telegram-bot-api-secret-token': 'shhh'},
      });
      expect(result.status).toBe(200);
    });
  });

  it('registers with a gateway', () => {
    const gateway = createGateway({
      agent: new EchoAgent(),
      channels: [telegram({token: 't', webhook: {path: '/tg'}})],
    });
    expect(gateway.router()).toBeTypeOf('function');
  });
});
