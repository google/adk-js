/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A stub Telegram Bot API, good enough to drive the real adapter.
 *
 * Only `fetch` is replaced, so polling, normalization, downloads, rendering and
 * sending all run for real.
 */

import type {
  TgChat,
  TgMessage,
  TgUpdate,
} from '@google/adk-gateway/telegram/index.js';

/** One recorded API call. */
export interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

const BOT_USERNAME = 'test_bot';

export class FakeTelegram {
  readonly calls: RecordedCall[] = [];
  /** File ids whose bytes were actually fetched. */
  readonly downloads: string[] = [];

  private readonly queue: TgUpdate[] = [];
  private updateId = 1;
  private messageId = 1000;
  private lastActivityAt = Date.now();
  private parseFailures = 0;
  private pollFailures = 0;

  /** The `fetch` to hand the adapter. */
  readonly fetch = async (
    input: string | URL | Request,
    init?: {body?: unknown},
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();

    const download = /\/file\/bot[^/]+\/(.+)$/.exec(url);
    if (download) {
      this.downloads.push(download[1].replace(/^files\//, ''));
      return new Response(new Uint8Array([1, 2, 3, 4]));
    }

    const method = url.split('/').pop()!;
    const params = readParams(init);

    if (method !== 'getUpdates') {
      this.calls.push({method, params});
      this.lastActivityAt = Date.now();
    }

    return new Response(JSON.stringify(await this.respond(method, params)), {
      headers: {'content-type': 'application/json'},
    });
  };

  /** Queues a message from a user. */
  userSends(
    message: Partial<TgMessage>,
    overrides: {chat?: Partial<TgChat>} = {},
  ): void {
    this.queue.push({
      update_id: this.updateId++,
      message: {
        message_id: this.messageId++,
        date: Math.floor(Date.now() / 1000),
        from: {id: 42, is_bot: false, first_name: 'Ada', username: 'ada'},
        chat: {id: 7, type: 'private', ...overrides.chat} as TgChat,
        ...message,
      } as TgMessage,
    });
    this.lastActivityAt = Date.now();
  }

  /** The inline keyboard on the most recent message that carried one. */
  get lastKeyboard(): Array<{text: string; callback_data?: string}> {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const markup = this.calls[i].params.reply_markup as
        | {
            inline_keyboard?: Array<
              Array<{text: string; callback_data?: string}>
            >;
          }
        | undefined;
      if (markup?.inline_keyboard?.length) {
        return markup.inline_keyboard.flat();
      }
    }
    return [];
  }

  /** Queues a button press on the bot's own message. */
  userTaps(data: string): void {
    this.queue.push({
      update_id: this.updateId++,
      callback_query: {
        id: `cb-${this.updateId}`,
        from: {id: 42, is_bot: false, first_name: 'Ada'},
        data,
        message: {
          message_id: this.messageId++,
          date: Math.floor(Date.now() / 1000),
          chat: {id: 7, type: 'private'},
        } as TgMessage,
      },
    });
    this.lastActivityAt = Date.now();
  }

  /** Makes the next formatted send fail the way a bad entity would. */
  failNextParse(): void {
    this.parseFailures++;
  }

  /** Makes the next poll fail the way a dropped connection would. */
  failNextPoll(): void {
    this.pollFailures++;
  }

  /** Every method called, in order. */
  get calledMethods(): string[] {
    return this.calls.map((call) => call.method);
  }

  /** The text of every message sent. */
  get sentTexts(): string[] {
    return this.calls
      .filter((call) => call.method === 'sendMessage')
      .map((call) => String(call.params.text));
  }

  /**
   * Waits for the queue to drain and the resulting work to go quiet.
   *
   * Polling is excluded from the activity signal, or the long-poll loop would
   * keep the gateway looking permanently busy.
   */
  async settled(quietMs = 60, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(10);
      if (
        this.queue.length === 0 &&
        Date.now() - this.lastActivityAt > quietMs
      ) {
        return;
      }
    }
    throw new Error('Timed out waiting for the bot to settle.');
  }

  private async respond(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case 'getMe':
        return ok({
          id: 1,
          is_bot: true,
          first_name: 'Test Bot',
          username: BOT_USERNAME,
        });

      case 'getUpdates': {
        if (this.pollFailures > 0) {
          this.pollFailures--;
          return {ok: false, error_code: 500, description: 'internal'};
        }
        if (this.queue.length === 0) {
          await sleep(5);
          return ok([]);
        }
        return ok(this.queue.splice(0));
      }

      case 'sendMessage': {
        if (params.parse_mode && this.parseFailures > 0) {
          this.parseFailures--;
          return {
            ok: false,
            error_code: 400,
            description: "Bad Request: can't parse entities: unexpected tag",
          };
        }
        return ok({
          message_id: this.messageId++,
          date: Math.floor(Date.now() / 1000),
          chat: {id: Number(params.chat_id), type: 'private'},
          text: params.text,
        });
      }

      case 'getFile':
        return ok({
          file_id: params.file_id,
          file_path: `files/${params.file_id}`,
        });

      default:
        return ok(true);
    }
  }
}

function ok(result: unknown) {
  return {ok: true, result};
}

/** Pulls the JSON parameters out of the request the client built. */
function readParams(init?: {body?: unknown}): Record<string, unknown> {
  if (typeof init?.body !== 'string') {
    return {};
  }
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
