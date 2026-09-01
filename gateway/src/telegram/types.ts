/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The slice of the Telegram Bot API this adapter uses.
 *
 * Hand-written rather than generated: the full surface is enormous and almost
 * none of it is relevant here, and a hand-written subset documents what the
 * adapter actually depends on.
 */

/** https://core.telegram.org/bots/api#user */
export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

/** https://core.telegram.org/bots/api#chat */
export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: true;
}

/** https://core.telegram.org/bots/api#photosize */
export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/** https://core.telegram.org/bots/api#voice */
export interface TgVoice {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

/** https://core.telegram.org/bots/api#audio */
export interface TgAudio {
  file_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** https://core.telegram.org/bots/api#video */
export interface TgVideo {
  file_id: string;
  width: number;
  height: number;
  duration: number;
  thumbnail?: TgPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/**
 * https://core.telegram.org/bots/api#videonote
 *
 * The round "telescope" message. Note there is no `mime_type` field at all —
 * these are always MPEG-4, and the adapter has to say so itself.
 */
export interface TgVideoNote {
  file_id: string;
  length: number;
  duration: number;
  thumbnail?: TgPhotoSize;
  file_size?: number;
}

/** https://core.telegram.org/bots/api#animation */
export interface TgAnimation {
  file_id: string;
  width: number;
  height: number;
  duration: number;
  thumbnail?: TgPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** https://core.telegram.org/bots/api#document */
export interface TgDocument {
  file_id: string;
  thumbnail?: TgPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/**
 * https://core.telegram.org/bots/api#sticker
 *
 * There is no `mime_type`: the format follows from `is_animated` (a gzipped
 * Lottie `.tgs`) and `is_video` (`.webm`), and a plain sticker is `.webp`.
 */
export interface TgSticker {
  file_id: string;
  type: 'regular' | 'mask' | 'custom_emoji';
  width: number;
  height: number;
  is_animated: boolean;
  is_video: boolean;
  thumbnail?: TgPhotoSize;
  emoji?: string;
  set_name?: string;
  custom_emoji_id?: string;
  file_size?: number;
}

/** https://core.telegram.org/bots/api#messageentity */
export interface TgMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  custom_emoji_id?: string;
}

/** https://core.telegram.org/bots/api#message */
export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TgUser;
  date: number;
  chat: TgChat;
  is_topic_message?: true;
  reply_to_message?: TgMessage;
  edit_date?: number;
  text?: string;
  caption?: string;
  entities?: TgMessageEntity[];
  caption_entities?: TgMessageEntity[];
  photo?: TgPhotoSize[];
  voice?: TgVoice;
  audio?: TgAudio;
  video?: TgVideo;
  video_note?: TgVideoNote;
  animation?: TgAnimation;
  document?: TgDocument;
  sticker?: TgSticker;
}

/** https://core.telegram.org/bots/api#callbackquery */
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

/** https://core.telegram.org/bots/api#update */
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/** https://core.telegram.org/bots/api#file */
export interface TgFile {
  file_id: string;
  file_size?: number;
  file_path?: string;
}

/** A button in an inline keyboard. */
export interface TgInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

/** https://core.telegram.org/bots/api#inlinekeyboardmarkup */
export interface TgInlineKeyboardMarkup {
  inline_keyboard: TgInlineKeyboardButton[][];
}

/** The envelope every Bot API method returns. */
export interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {retry_after?: number; migrate_to_chat_id?: number};
}
