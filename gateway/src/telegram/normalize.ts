/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turning a Telegram `Update` into an {@link InboundMessage}.
 */

import type {ConversationKind, InboundMessage} from '../types.js';
import type {TelegramClient} from './client.js';
import {extractAttachments, type TelegramMediaOptions} from './media.js';
import type {TgChat, TgMessage, TgUpdate, TgUser} from './types.js';

/** What {@link normalizeUpdate} needs beyond the update. */
export interface NormalizeOptions {
  channelName: string;
  client: TelegramClient;
  /** The bot's own username, used to spot mentions and strip command suffixes. */
  botUsername?: string;
  media?: TelegramMediaOptions;
  signal?: AbortSignal;
}

/**
 * Converts one update, or returns `undefined` for updates this adapter does not
 * act on (channel posts, edits, service messages).
 */
export function normalizeUpdate(
  update: TgUpdate,
  options: NormalizeOptions,
): InboundMessage | undefined {
  if (update.callback_query) {
    return normalizeCallback(update.callback_query, options);
  }

  // Edits deliberately ignored: re-answering a question the user rewrote
  // produces two answers to one question, which reads as a malfunction.
  const message = update.message;
  if (!message || !message.from) {
    return undefined;
  }

  return normalizeMessage(message, message.from, options);
}

function normalizeMessage(
  message: TgMessage,
  from: TgUser,
  options: NormalizeOptions,
): InboundMessage {
  const {attachments, notes} = extractAttachments(message, {
    client: options.client,
    media: options.media,
    signal: options.signal,
  });

  const body = message.text ?? message.caption;
  const command = body ? parseCommand(body, options.botUsername) : undefined;

  // Sticker glosses and video-note summaries are text the model must see;
  // there is no other place for them to go.
  const text = [body, ...notes].filter(Boolean).join(' ').trim() || undefined;

  return {
    channel: options.channelName,
    conversation: conversationOf(message.chat, message, options.channelName),
    sender: {
      id: String(from.id),
      displayName: displayName(from),
      username: from.username,
      isBot: from.is_bot,
    },
    messageId: String(message.message_id),
    text,
    attachments,
    command,
    replyTo: message.reply_to_message
      ? {
          messageId: String(message.reply_to_message.message_id),
          fromBot: message.reply_to_message.from?.is_bot ?? false,
        }
      : undefined,
    mentionsBot: mentionsBot(message, options.botUsername),
    receivedAt: new Date(message.date * 1000),
    raw: message,
  };
}

function normalizeCallback(
  query: NonNullable<TgUpdate['callback_query']>,
  options: NormalizeOptions,
): InboundMessage | undefined {
  const message = query.message;
  if (!message) {
    return undefined;
  }

  return {
    channel: options.channelName,
    conversation: conversationOf(message.chat, message, options.channelName),
    sender: {
      id: String(query.from.id),
      displayName: displayName(query.from),
      username: query.from.username,
      isBot: query.from.is_bot,
    },
    messageId: String(message.message_id),
    attachments: [],
    action: {id: query.id, payload: query.data},
    replyTo: {messageId: String(message.message_id), fromBot: true},
    // A button on the bot's own message is always addressed to the bot.
    mentionsBot: true,
    receivedAt: new Date(),
    raw: query,
  };
}

function conversationOf(
  chat: TgChat,
  message: TgMessage,
  channel: string,
): InboundMessage['conversation'] {
  return {
    channel,
    id: String(chat.id),
    kind: conversationKind(chat),
    // Only forum topics count as threads. A supergroup can put a
    // `message_thread_id` on an ordinary reply chain, and treating that as a
    // thread would shatter one conversation into a session per reply.
    threadId:
      chat.is_forum && message.is_topic_message && message.message_thread_id
        ? String(message.message_thread_id)
        : undefined,
    title: chat.title,
  };
}

function conversationKind(chat: TgChat): ConversationKind {
  switch (chat.type) {
    case 'private':
      return 'direct';
    case 'channel':
      return 'channel';
    default:
      return 'group';
  }
}

function displayName(user: TgUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(' ');
}

/**
 * Parses a leading slash command.
 *
 * Telegram appends `@botname` in groups so that several bots can share a
 * command; the suffix is stripped, and a command aimed at a different bot is
 * not treated as a command at all.
 */
export function parseCommand(
  text: string,
  botUsername?: string,
): {name: string; args: string} | undefined {
  const match =
    /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(
      text.trim(),
    );
  if (!match) {
    return undefined;
  }

  const [, name, addressee, args] = match;
  if (
    addressee &&
    botUsername &&
    addressee.toLowerCase() !== botUsername.toLowerCase()
  ) {
    return undefined;
  }

  return {name, args: (args ?? '').trim()};
}

/** Whether the bot was addressed, which is what gates replying in a group. */
function mentionsBot(message: TgMessage, botUsername?: string): boolean {
  if (message.chat.type === 'private') {
    return true;
  }
  if (message.reply_to_message?.from?.is_bot) {
    return true;
  }
  if (!botUsername) {
    return false;
  }

  const handle = `@${botUsername.toLowerCase()}`;
  const body = (message.text ?? message.caption ?? '').toLowerCase();
  return body.includes(handle);
}
