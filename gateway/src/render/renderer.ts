/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turning a run's events into messages to send.
 *
 * Three jobs, in order of how badly each one fails when skipped:
 *
 * 1. **Surface interrupts.** A paused run carries its prompt in a
 *    `functionCall` part, invisible to anything that renders only text — so a
 *    bot that ignores them just appears to hang. This is the single most common
 *    "my bot is broken" bug and the main reason this layer exists.
 * 2. **Chunk.** Model answers routinely exceed a channel's message limit.
 * 3. **Convert markup** to the channel's dialect.
 */

import type {Event} from '@google/adk';

import type {ChannelCapabilities, OutboundMessage} from '../types.js';
import {chunkText} from './chunk.js';
import {
  actionsFor,
  interruptsIn,
  plainTextHint,
  promptFor,
  type GatewayInterrupt,
} from './interrupts.js';
import {toPlainText, toTelegramHtml} from './markdown.js';

/** What the renderer knows about where it is writing. */
export interface RenderContext {
  capabilities: ChannelCapabilities;
  /** Turns an error into something worth showing a user. */
  formatError?: (error: unknown) => string;
}

/** Converts a run's events into the messages to send back. */
export type Renderer = (
  events: AsyncIterable<Event>,
  context: RenderContext,
) => AsyncIterable<OutboundMessage>;

/**
 * Collects the model's answer, surfaces anything the run is waiting on, and
 * emits messages sized and formatted for the channel.
 */
export const defaultRenderer: Renderer = async function* (events, context) {
  const answer: string[] = [];
  const pending: GatewayInterrupt[] = [];

  for await (const event of events) {
    // Partial events are prefixes of the final text; taking both would emit
    // the answer twice. Progressive delivery is the adapter's job, via the
    // channel's own streaming mechanism.
    if (event.partial) {
      continue;
    }

    pending.push(...interruptsIn(event));

    const text = textOf(event);
    if (text) {
      answer.push(text);
    }
  }

  const body = answer.join('\n\n').trim();
  if (body) {
    yield* formatAndChunk(body, context.capabilities);
  }

  for (const interrupt of pending) {
    yield* renderInterrupt(interrupt, context.capabilities);
  }
};

/**
 * Renders one pending interrupt: a prompt, plus buttons where the channel has
 * them or an instruction to answer in words where it does not.
 *
 * The buttons ride on the last chunk, so a prompt long enough to be split still
 * ends with something to press.
 */
export function renderInterrupt(
  interrupt: GatewayInterrupt,
  capabilities: ChannelCapabilities,
): OutboundMessage[] {
  const actions = actionsFor(interrupt, capabilities);
  const hint = actions.length === 0 ? plainTextHint(interrupt) : undefined;
  const prompt = [promptFor(interrupt), hint].filter(Boolean).join('\n\n');

  const messages = formatAndChunk(prompt, capabilities);
  if (messages.length === 0) {
    return [];
  }
  if (actions.length > 0) {
    messages[messages.length - 1].actions = actions;
  }
  return messages;
}

/**
 * Renders one body of markdown as one or more channel-ready messages.
 *
 * Chunking happens after conversion so the limit applies to what is actually
 * sent — HTML tags count against Telegram's 4096.
 */
export function formatAndChunk(
  markdown: string,
  capabilities: ChannelCapabilities,
): OutboundMessage[] {
  const formatted = applyFormat(markdown, capabilities.textFormat);
  return chunkText(formatted, capabilities.maxTextLength).map((text) => ({
    text,
  }));
}

/** Converts markdown to a channel's dialect. */
export function applyFormat(
  markdown: string,
  format: ChannelCapabilities['textFormat'],
): string {
  switch (format) {
    case 'html':
      return toTelegramHtml(markdown);
    case 'markdown':
    case 'markdownv2':
    case 'slack-mrkdwn':
    case 'chat-cardv2':
      // Dialect converters for these land with their adapters. Passing the
      // markdown through unchanged is wrong less often than a half-written
      // escaper, and the renderer's plain-text retry covers the rest.
      return markdown;
    case 'plain':
      return toPlainText(markdown);
    default: {
      const unreachable: never = format;
      throw new Error(`Unknown text format: ${String(unreachable)}`);
    }
  }
}

/** The plain text an event carries, ignoring function calls and responses. */
export function textOf(event: Event): string | undefined {
  const parts = event.content?.parts;
  if (!parts) {
    return undefined;
  }

  const text = parts
    .map((part) =>
      part.functionCall || part.functionResponse ? '' : (part.text ?? ''),
    )
    .join('');

  return text.trim() ? text : undefined;
}
