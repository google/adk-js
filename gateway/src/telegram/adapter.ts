/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Telegram channel adapter.
 *
 * Receives by long polling (the default, and all a developer needs) or by
 * webhook, and sends through the Bot API.
 */

import {resolveSessionConfig} from '../session/strategies.js';
import type {
  AccessPolicy,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelRuntime,
  ChannelTarget,
  ConversationRef,
  InboundMessage,
  MessageRef,
  OutboundMessage,
  SessionConfig,
  SessionKey,
  WebhookHandler,
} from '../types.js';
import {TelegramClient, type TelegramClientOptions} from './client.js';
import type {TelegramMediaOptions} from './media.js';
import {normalizeUpdate} from './normalize.js';
import {sendMessage} from './send.js';
import type {TgMessage, TgUpdate, TgUser} from './types.js';

/** Telegram's own limits, as capabilities. */
const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  maxTextLength: 4096,
  // HTML rather than MarkdownV2: three escaped characters instead of eighteen.
  // See `render/markdown.ts`.
  textFormat: 'html',
  editMessages: true,
  // Native draft streaming exists but only in private chats, so the baseline
  // is the edit path and `capabilitiesFor` upgrades direct chats.
  streaming: 'edit',
  typingIndicator: true,
  buttons: 'inline',
  // `callback_data` is capped at 64 bytes, which is why button payloads are
  // tokenized rather than embedded.
  buttonPayloadBytes: 64,
  threads: true,
  attachments: {upload: true, download: true, maxBytes: 20 * 1024 * 1024},
  proactive: {supported: true, requiresTemplate: false},
};

/** How to receive updates by webhook. */
export interface TelegramWebhookOptions {
  /** The path to mount, e.g. `'/telegram'`. */
  path: string;
  /**
   * The public HTTPS URL of that path. When set, the adapter registers it with
   * `setWebhook` on start; when omitted, registration is left to you.
   */
  publicUrl?: string;
  /**
   * A shared secret echoed back in `X-Telegram-Bot-Api-Secret-Token`.
   *
   * Strongly recommended: the webhook URL is otherwise the only thing standing
   * between your bot and anyone who can guess it.
   */
  secretToken?: string;
  /** Whether to discard updates queued while the bot was down. Defaults to true. */
  dropPendingUpdates?: boolean;
}

/** How to build the Telegram channel. */
export interface TelegramOptions extends Pick<
  TelegramClientOptions,
  'baseUrl' | 'fetch'
> {
  /** The bot token from @BotFather. */
  token: string;

  /**
   * How conversations map to sessions. Defaults to `'per-conversation'`, so a
   * group shares one session and forum topics fold into it.
   */
  session?: SessionKey | SessionConfig;

  /** Who may talk to the bot here. */
  access?: AccessPolicy;

  /** What to do with stickers and video. */
  media?: TelegramMediaOptions;

  /** Receive by webhook instead of long polling. */
  webhook?: TelegramWebhookOptions;

  /** Long-poll timeout in seconds. Defaults to 30. */
  pollTimeoutSec?: number;

  /**
   * Whether to answer in groups only when addressed. Defaults to true.
   *
   * A bot that answers every message in a busy group is a nuisance, and with
   * Telegram's privacy mode on it will not see most of them anyway.
   */
  requireMentionInGroups?: boolean;
}

/** The Telegram channel. */
export class TelegramChannel implements ChannelAdapter {
  readonly name = 'telegram';
  readonly capabilities = TELEGRAM_CAPABILITIES;
  readonly session: SessionConfig;
  readonly access?: AccessPolicy;
  readonly webhook?: {path: string; handle: WebhookHandler};

  private readonly client: TelegramClient;
  private readonly options: TelegramOptions;
  private runtime?: ChannelRuntime;
  private me?: TgUser;
  private polling?: Promise<void>;
  private offset = 0;
  private stopped = false;

  constructor(options: TelegramOptions) {
    this.options = options;
    this.client = new TelegramClient(options);
    this.session = resolveSessionConfig(options.session, 'per-conversation');
    this.access = options.access;

    if (options.webhook) {
      this.webhook = {
        path: options.webhook.path,
        handle: this.handleWebhook.bind(this),
      };
    }
  }

  /**
   * Direct chats support native draft streaming; groups do not. Same channel,
   * different capabilities — which is why this is per-conversation.
   */
  capabilitiesFor(conversation: ConversationRef): ChannelCapabilities {
    if (conversation.kind === 'direct') {
      return {...TELEGRAM_CAPABILITIES, streaming: 'native-draft'};
    }
    return TELEGRAM_CAPABILITIES;
  }

  async start(runtime: ChannelRuntime): Promise<void> {
    this.runtime = runtime;
    this.stopped = false;
    this.me = await this.client.call<TgUser>('getMe');

    runtime.logger.info?.(
      `[telegram] connected as @${this.me.username ?? this.me.first_name}`,
    );

    if (this.options.webhook) {
      await this.registerWebhook();
    } else {
      // Polling and webhooks are mutually exclusive; a webhook left over from a
      // previous run would silently starve getUpdates.
      await this.client.call('deleteWebhook', {drop_pending_updates: true});
      this.polling = this.poll(runtime);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.polling?.catch(() => undefined);
    this.polling = undefined;
    this.runtime = undefined;
  }

  async send(
    target: ChannelTarget,
    message: OutboundMessage,
  ): Promise<MessageRef> {
    return sendMessage({
      client: this.client,
      channelName: this.name,
      target,
      message,
    });
  }

  async edit(ref: MessageRef, message: OutboundMessage): Promise<MessageRef> {
    await this.client.call<TgMessage>('editMessageText', {
      chat_id: Number(ref.conversationId),
      message_id: Number(ref.messageId),
      text: message.text ?? '',
      parse_mode: 'HTML',
    });
    return ref;
  }

  async delete(ref: MessageRef): Promise<void> {
    await this.client.call('deleteMessage', {
      chat_id: Number(ref.conversationId),
      message_id: Number(ref.messageId),
    });
  }

  /**
   * Shows "typing…".
   *
   * Telegram clears the status after five seconds, so a turn that outlasts that
   * needs it re-sent; {@link keepTyping} does the re-sending.
   */
  async typing(target: ChannelTarget, on: boolean): Promise<void> {
    if (!on) {
      return;
    }
    await this.client.call('sendChatAction', {
      chat_id: Number(target.conversationId),
      message_thread_id: target.threadId ? Number(target.threadId) : undefined,
      action: 'typing',
    });
  }

  /** Answers a button press, which stops the client's spinner. */
  async ackAction(actionId: string, note?: string): Promise<void> {
    await this.client.call('answerCallbackQuery', {
      callback_query_id: actionId,
      text: note,
    });
  }

  /** The underlying API client, for callers who need a method not wrapped here. */
  get api(): TelegramClient {
    return this.client;
  }

  private async registerWebhook(): Promise<void> {
    const webhook = this.options.webhook!;
    if (!webhook.publicUrl) {
      return;
    }
    await this.client.call('setWebhook', {
      url: webhook.publicUrl,
      secret_token: webhook.secretToken,
      drop_pending_updates: webhook.dropPendingUpdates ?? true,
      allowed_updates: ['message', 'callback_query'],
    });
  }

  /** Validates and dispatches one webhook delivery. */
  private async handleWebhook(request: {
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<{status: number; body?: unknown}> {
    const expected = this.options.webhook?.secretToken;
    if (expected) {
      const provided = header(
        request.headers,
        'x-telegram-bot-api-secret-token',
      );
      if (!provided || !timingSafeEqual(provided, expected)) {
        return {status: 401};
      }
    }

    // Answer immediately and run the turn in the background: Telegram retries
    // deliveries it considers failed, and a slow 200 looks like a failure.
    void this.dispatch(request.body as TgUpdate);
    return {status: 200};
  }

  private async poll(runtime: ChannelRuntime): Promise<void> {
    const timeout = this.options.pollTimeoutSec ?? 30;

    while (!this.stopped && !runtime.signal.aborted) {
      try {
        const updates = await this.client.call<TgUpdate[]>(
          'getUpdates',
          {
            offset: this.offset,
            timeout,
            allowed_updates: ['message', 'callback_query'],
          },
          {signal: runtime.signal},
        );

        for (const update of updates) {
          // Acknowledge by advancing past this update, before handling it: a
          // handler that throws must not make the same update arrive forever.
          this.offset = Math.max(this.offset, update.update_id + 1);
          void this.dispatch(update);
        }
      } catch (error) {
        if (this.stopped || runtime.signal.aborted) {
          return;
        }
        runtime.logger.error?.(`[telegram] polling failed: ${describe(error)}`);
        await sleep(1000, runtime.signal);
      }
    }
  }

  /** Normalizes an update and runs it, keeping "typing…" alive meanwhile. */
  private async dispatch(update: TgUpdate): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) {
      return;
    }

    let message;
    try {
      message = normalizeUpdate(update, {
        channelName: this.name,
        client: this.client,
        botUsername: this.me?.username,
        media: this.options.media,
        signal: runtime.signal,
      });
    } catch (error) {
      runtime.logger.error?.(
        `[telegram] could not read update: ${describe(error)}`,
      );
      return;
    }

    if (!message) {
      return;
    }

    // A button press leaves a spinner on the client until it is answered, and
    // that should not wait for the whole turn.
    if (message.action) {
      await this.ackAction(message.action.id).catch(() => undefined);
      // Buttons are single-use, so take the keyboard away rather than leave
      // the user looking at choices that no longer do anything.
      await this.clearKeyboard(message).catch(() => undefined);
    }

    const requireMention = this.options.requireMentionInGroups ?? true;
    if (requireMention && !message.mentionsBot) {
      return;
    }

    const target: ChannelTarget = {
      conversationId: message.conversation.id,
      threadId: message.conversation.threadId,
    };
    const stopTyping = this.keepTyping(target);

    try {
      await runtime.dispatch(message);
    } catch (error) {
      runtime.logger.error?.(`[telegram] turn failed: ${describe(error)}`);
    } finally {
      stopTyping();
    }
  }

  /** Removes the inline keyboard from the message a button was pressed on. */
  private async clearKeyboard(message: InboundMessage): Promise<void> {
    await this.client.call('editMessageReplyMarkup', {
      chat_id: Number(message.conversation.id),
      message_id: Number(message.messageId),
      reply_markup: {inline_keyboard: []},
    });
  }

  /** Re-sends the typing action until the returned function is called. */
  private keepTyping(target: ChannelTarget): () => void {
    void this.typing(target, true).catch(() => undefined);
    // Telegram clears the indicator after five seconds.
    const timer = setInterval(() => {
      void this.typing(target, true).catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }
}

/** Builds the Telegram channel. */
export function telegram(options: TelegramOptions): TelegramChannel {
  return new TelegramChannel(options);
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Compares two secrets without leaking their length through timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function describe(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, {once: true});
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
  });
}
