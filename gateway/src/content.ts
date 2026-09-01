/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turning an {@link InboundMessage} into the `Content` a runner takes.
 */

import type {Content, Part} from '@google/genai';

import {attachmentsToParts, type MediaPolicy} from './media/parts.js';
import type {InboundMessage, SessionConfig} from './types.js';

/** Options for {@link toContent}. */
export interface ToContentOptions {
  /**
   * Whether to label who is speaking.
   *
   * Defaults to labelling in groups and channels and not in direct chats: one
   * session carries many speakers in a group, and without a label the model
   * reads a three-way conversation as one person contradicting themselves.
   */
  groupIdentity?: SessionConfig['groupIdentity'];

  /** How attachments are admitted. */
  media?: MediaPolicy;
}

/**
 * Builds the user `Content` for one inbound message.
 *
 * Returns `undefined` when there is nothing for the model to read — a bare
 * button press, say, which the interrupt machinery answers instead.
 */
export async function toContent(
  message: InboundMessage,
  options: ToContentOptions = {},
): Promise<Content | undefined> {
  const parts: Part[] = [];

  const text = messageText(message, options);
  if (text) {
    parts.push({text});
  }

  if (message.attachments.length > 0) {
    parts.push(
      ...(await attachmentsToParts(message.attachments, options.media)),
    );
  }

  if (parts.length === 0) {
    return undefined;
  }
  return {role: 'user', parts};
}

/** The message text, with a speaker label where one is warranted. */
function messageText(
  message: InboundMessage,
  options: ToContentOptions,
): string | undefined {
  const text = message.text?.trim();
  if (!text) {
    return undefined;
  }

  const kind = message.conversation.kind ?? 'direct';
  const setting =
    options.groupIdentity ?? (kind === 'direct' ? 'none' : 'prefix');
  if (setting === 'none') {
    return text;
  }

  const label = speakerLabel(message);
  return label ? `${label}: ${text}` : text;
}

/** How to name the speaker, preferring a display name over a bare id. */
function speakerLabel(message: InboundMessage): string | undefined {
  const {displayName, username, id} = message.sender;
  if (displayName && username) {
    return `${displayName} (@${username})`;
  }
  return displayName ?? (username ? `@${username}` : id);
}
