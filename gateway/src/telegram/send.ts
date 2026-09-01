/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sending an {@link OutboundMessage} through the Bot API.
 */

import {stripTelegramHtml} from '../render/markdown.js';
import type {
  ChannelTarget,
  MessageRef,
  OutboundAttachment,
  OutboundMessage,
} from '../types.js';
import {TelegramApiError, type TelegramClient} from './client.js';
import type {TgInlineKeyboardMarkup, TgMessage} from './types.js';

/** Telegram's caption limit, well below the 4096 for message text. */
const MAX_CAPTION = 1024;

/** What {@link sendMessage} needs. */
export interface SendOptions {
  client: TelegramClient;
  channelName: string;
  target: ChannelTarget;
  message: OutboundMessage;
  /** Resolves a button's payload to the ≤64 bytes `callback_data` allows. */
  encodeAction?: (payload: unknown) => string;
  signal?: AbortSignal;
}

/** Sends one message, with its attachments and buttons. */
export async function sendMessage(options: SendOptions): Promise<MessageRef> {
  const {target, message} = options;

  const base = {
    chat_id: numericChatId(target.conversationId),
    message_thread_id: target.threadId ? Number(target.threadId) : undefined,
    reply_markup: keyboard(message, options.encodeAction),
  };

  const attachment = message.attachments?.[0];
  if (attachment) {
    return toRef(
      await sendWithAttachment(options, base, attachment),
      options.channelName,
      target,
    );
  }

  const sent = await sendText(options, base, message.text ?? '');
  return toRef(sent, options.channelName, target);
}

/**
 * Sends text, retrying once without formatting if Telegram rejects the markup.
 *
 * A single bad entity makes the API reject the entire message, and losing the
 * answer over a stray `<` is far worse than losing the bold.
 */
async function sendText(
  options: SendOptions,
  base: Record<string, unknown>,
  text: string,
): Promise<TgMessage> {
  const {client, signal} = options;
  try {
    return await client.call<TgMessage>(
      'sendMessage',
      {...base, text, parse_mode: 'HTML'},
      {signal},
    );
  } catch (error) {
    if (!isParseError(error)) {
      throw error;
    }
    return client.call<TgMessage>(
      'sendMessage',
      {...base, text: stripTelegramHtml(text)},
      {signal},
    );
  }
}

async function sendWithAttachment(
  options: SendOptions,
  base: Record<string, unknown>,
  attachment: OutboundAttachment,
): Promise<TgMessage> {
  const {client, signal, message} = options;
  const {method, field} = methodFor(attachment);

  const caption = truncate(attachment.caption ?? message.text, MAX_CAPTION);
  const params = {
    ...base,
    caption,
    parse_mode: caption ? 'HTML' : undefined,
  };

  const sent = attachment.fileId
    ? await client.call<TgMessage>(
        method,
        {...params, [field]: attachment.fileId},
        {signal},
      )
    : await client.upload<TgMessage>(
        method,
        params,
        {
          field,
          bytes: attachment.bytes ?? new Uint8Array(),
          fileName: attachment.fileName ?? defaultFileName(attachment),
          mimeType: attachment.mimeType,
        },
        {signal},
      );

  // Text longer than a caption allows follows as its own message rather than
  // being silently cut off at 1024.
  const overflow =
    message.text && message.text.length > MAX_CAPTION
      ? message.text
      : undefined;
  if (overflow) {
    await sendText(options, base, overflow);
  }

  return sent;
}

/** Which Bot API method carries which kind of attachment. */
function methodFor(attachment: OutboundAttachment): {
  method: string;
  field: string;
} {
  switch (attachment.kind) {
    case 'image':
      return {method: 'sendPhoto', field: 'photo'};
    // `sendVoice` renders as a playable voice note, but only accepts OGG/Opus,
    // MP3 or M4A. Anything else must go as audio or a document.
    case 'voice':
      return {method: 'sendVoice', field: 'voice'};
    case 'audio':
      return {method: 'sendAudio', field: 'audio'};
    case 'video':
      return {method: 'sendVideo', field: 'video'};
    case 'video-note':
      return {method: 'sendVideoNote', field: 'video_note'};
    case 'sticker':
      return {method: 'sendSticker', field: 'sticker'};
    case 'document':
    default:
      return {method: 'sendDocument', field: 'document'};
  }
}

function defaultFileName(attachment: OutboundAttachment): string {
  const extension = attachment.mimeType?.split('/')[1]?.split('+')[0] ?? 'bin';
  return `${attachment.kind}.${extension}`;
}

/** Builds an inline keyboard, one button per row for legibility. */
function keyboard(
  message: OutboundMessage,
  encodeAction?: (payload: unknown) => string,
): TgInlineKeyboardMarkup | undefined {
  if (!message.actions?.length) {
    return undefined;
  }
  return {
    inline_keyboard: message.actions.map((action) => [
      {
        text: action.label,
        callback_data: encodeAction
          ? encodeAction(action.payload)
          : String(action.payload),
      },
    ]),
  };
}

/**
 * Telegram chat ids are numbers, and supergroup ids are large and negative.
 * They exceed 32 bits but stay within 53, so a JS number is safe.
 */
function numericChatId(id: string): number | string {
  const parsed = Number(id);
  return Number.isFinite(parsed) ? parsed : id;
}

function truncate(text: string | undefined, max: number): string | undefined {
  if (!text) {
    return undefined;
  }
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isParseError(error: unknown): boolean {
  return (
    error instanceof TelegramApiError &&
    /can't parse entities|unsupported start tag|unmatched end tag/i.test(
      error.message,
    )
  );
}

function toRef(
  sent: TgMessage,
  channelName: string,
  target: ChannelTarget,
): MessageRef {
  return {
    channel: channelName,
    conversationId: target.conversationId,
    threadId: target.threadId,
    messageId: String(sent.message_id),
  };
}
