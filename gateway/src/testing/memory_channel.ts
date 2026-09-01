/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An in-process channel, for testing a bot without a network or a token.
 *
 * It also exists to keep the capability model honest. Telegram is the most
 * capable of the messengers this package targets, so validating the renderer
 * only against Telegram is how you end up with an abstraction that leaks on the
 * poorest channel. The profiles below let the same bot be driven through a
 * channel that cannot edit, cannot show buttons and has no threads.
 */

import {resolveSessionConfig} from '../session/strategies.js';
import type {
  AccessPolicy,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelRuntime,
  ChannelTarget,
  ConversationKind,
  InboundMessage,
  MessageRef,
  OutboundAction,
  OutboundMessage,
  SessionConfig,
  SessionKey,
} from '../types.js';

/** A richly capable channel: edits, native streaming, inline buttons, threads. */
export const TELEGRAM_LIKE: ChannelCapabilities = {
  maxTextLength: 4096,
  textFormat: 'markdownv2',
  editMessages: true,
  streaming: 'native-draft',
  typingIndicator: true,
  buttons: 'inline',
  buttonPayloadBytes: 64,
  threads: true,
  attachments: {upload: true, download: true, maxBytes: 20 * 1024 * 1024},
  proactive: {supported: true, requiresTemplate: false},
};

/** No edits, no streaming, few buttons, and a window on proactive messages. */
export const WHATSAPP_LIKE: ChannelCapabilities = {
  maxTextLength: 4096,
  textFormat: 'plain',
  editMessages: false,
  streaming: 'none',
  typingIndicator: false,
  buttons: 'quick-reply',
  buttonPayloadBytes: 256,
  threads: false,
  attachments: {upload: true, download: true, maxBytes: 16 * 1024 * 1024},
  proactive: {
    supported: true,
    freeformWindowMs: 24 * 60 * 60 * 1000,
    requiresTemplate: true,
  },
};

/** The floor: text only, short messages, nothing else. */
export const MINIMAL: ChannelCapabilities = {
  maxTextLength: 500,
  textFormat: 'plain',
  editMessages: false,
  streaming: 'none',
  typingIndicator: false,
  buttons: 'none',
  buttonPayloadBytes: 0,
  threads: false,
  attachments: {upload: false, download: false, maxBytes: 0},
  proactive: {supported: false, requiresTemplate: false},
};

/** One message the bot sent. */
export interface SentMessage {
  target: ChannelTarget;
  message: OutboundMessage;
}

/** How a simulated user speaks. */
export interface UserSaysOptions {
  conversationId?: string;
  conversationKind?: ConversationKind;
  threadId?: string;
  senderId?: string;
  displayName?: string;
  /** Parsed as a command when the text starts with `/`. Defaults to true. */
  parseCommands?: boolean;
}

/** How to build a {@link MemoryChannel}. */
export interface MemoryChannelOptions {
  name?: string;
  capabilities?: ChannelCapabilities;
  session?: SessionKey | SessionConfig;
  access?: AccessPolicy;
}

/**
 * A channel that delivers messages to the gateway from memory and records what
 * comes back.
 */
export class MemoryChannel implements ChannelAdapter {
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  readonly session: SessionConfig;
  readonly access?: AccessPolicy;

  /** Every message the bot has sent, oldest first. */
  readonly sent: SentMessage[] = [];

  private runtime?: ChannelRuntime;
  private messageCounter = 0;

  constructor(options: MemoryChannelOptions = {}) {
    this.name = options.name ?? 'memory';
    this.capabilities = options.capabilities ?? TELEGRAM_LIKE;
    this.session = resolveSessionConfig(options.session, 'per-conversation');
    this.access = options.access;
  }

  async start(runtime: ChannelRuntime): Promise<void> {
    this.runtime = runtime;
  }

  async stop(): Promise<void> {
    this.runtime = undefined;
  }

  async send(
    target: ChannelTarget,
    message: OutboundMessage,
  ): Promise<MessageRef> {
    this.sent.push({target, message});
    return {
      channel: this.name,
      conversationId: target.conversationId,
      threadId: target.threadId,
      messageId: `out-${this.sent.length}`,
    };
  }

  async edit(ref: MessageRef, message: OutboundMessage): Promise<MessageRef> {
    const index = Number(ref.messageId.replace('out-', '')) - 1;
    if (this.sent[index]) {
      this.sent[index] = {...this.sent[index], message};
    }
    return ref;
  }

  /**
   * Delivers a message as if a user had sent it, and returns everything the bot
   * sent while the turn was in flight.
   *
   * Resolves once the turn is complete, so a test can assert on the reply
   * without polling.
   *
   * The return value is only precise when calls are awaited one at a time. Two
   * overlapping turns cannot be told apart by send order alone, so a test that
   * dispatches concurrently — checking queueing, say — should assert on
   * {@link texts} or {@link sent} instead.
   */
  async userSays(
    text: string,
    options: UserSaysOptions = {},
  ): Promise<OutboundMessage[]> {
    if (!this.runtime) {
      throw new Error(
        'MemoryChannel is not started. Call gateway.start() before userSays().',
      );
    }

    const before = this.sent.length;
    await this.runtime.dispatch(this.buildMessage(text, options));
    return this.sent.slice(before).map((entry) => entry.message);
  }

  /**
   * Presses a button the bot offered, and returns what it sent in response.
   *
   * Pass the `payload` from an {@link OutboundAction} the bot sent — that is
   * the opaque handle the gateway issued, exactly as a real client would send
   * it back.
   */
  async userTaps(
    payload: unknown,
    options: UserSaysOptions = {},
  ): Promise<OutboundMessage[]> {
    if (!this.runtime) {
      throw new Error(
        'MemoryChannel is not started. Call gateway.start() before userTaps().',
      );
    }

    const before = this.sent.length;
    const message = this.buildMessage('', options);
    await this.runtime.dispatch({
      ...message,
      text: undefined,
      action: {id: `tap-${++this.messageCounter}`, payload},
    });
    return this.sent.slice(before).map((entry) => entry.message);
  }

  /** The buttons on the most recent message that carried any. */
  get lastActions(): OutboundAction[] {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const actions = this.sent[i].message.actions;
      if (actions?.length) {
        return actions;
      }
    }
    return [];
  }

  /** Forgets everything the bot has sent. */
  reset(): void {
    this.sent.length = 0;
  }

  /** The text of every message sent so far, for terse assertions. */
  get texts(): string[] {
    return this.sent
      .map((entry) => entry.message.text)
      .filter((text): text is string => text !== undefined);
  }

  private buildMessage(text: string, options: UserSaysOptions): InboundMessage {
    const kind = options.conversationKind ?? 'direct';
    const parseCommands = options.parseCommands ?? true;
    const command =
      parseCommands && text.startsWith('/') ? parseCommand(text) : undefined;

    return {
      channel: this.name,
      conversation: {
        channel: this.name,
        id: options.conversationId ?? 'conv-1',
        kind,
        threadId: options.threadId,
      },
      sender: {
        id: options.senderId ?? 'user-1',
        displayName: options.displayName,
      },
      messageId: `in-${++this.messageCounter}`,
      text,
      attachments: [],
      command,
      mentionsBot: kind === 'direct',
      receivedAt: new Date(),
      raw: {text},
    };
  }
}

/** Builds an in-process channel. */
export function memoryChannel(options?: MemoryChannelOptions): MemoryChannel {
  return new MemoryChannel(options);
}

function parseCommand(text: string): {name: string; args: string} {
  const [head, ...rest] = text.slice(1).split(/\s+/);
  return {name: head, args: rest.join(' ')};
}
