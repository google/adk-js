/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export {TelegramChannel, telegram} from './adapter.js';
export type {TelegramOptions, TelegramWebhookOptions} from './adapter.js';
export {TelegramApiError, TelegramClient} from './client.js';
export type {TelegramClientOptions} from './client.js';
export {describeSticker, largestPhoto} from './media.js';
export type {StickerMode, TelegramMediaOptions, VideoMode} from './media.js';
export {normalizeUpdate, parseCommand} from './normalize.js';
export type {NormalizeOptions} from './normalize.js';
export * from './types.js';
