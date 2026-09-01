/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A thin typed client for the Telegram Bot API.
 *
 * Plain HTTPS and JSON, so no SDK: the whole surface used here is `fetch`, a
 * couple of `multipart/form-data` uploads, and one file download.
 */

import type {TgFile, TgResponse} from './types.js';

/** Raised when the Bot API answers with `ok: false`. */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number | undefined,
    description: string,
    /** Seconds Telegram asked us to wait, on a 429. */
    readonly retryAfter?: number,
  ) {
    super(
      `Telegram ${method} failed${errorCode ? ` (${errorCode})` : ''}: ${description}`,
    );
    this.name = 'TelegramApiError';
  }

  /**
   * Whether this means the bot can never message this chat again — the user
   * blocked it, or the chat is gone. Worth distinguishing so a caller stops
   * retrying rather than hammering a dead conversation.
   */
  get isPermanent(): boolean {
    return this.errorCode === 403 || this.errorCode === 400;
  }
}

/** Options for {@link TelegramClient}. */
export interface TelegramClientOptions {
  token: string;
  /** Override for tests, or for a local Bot API server. */
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** How many times to retry a rate-limited call. Defaults to 3. */
  maxRetries?: number;
}

/** A file to upload as part of a multipart request. */
export interface UploadFile {
  field: string;
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string;
}

export class TelegramClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly maxRetries: number;

  constructor(options: TelegramClientOptions) {
    if (!options.token) {
      throw new Error('A Telegram bot token is required.');
    }
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? 'https://api.telegram.org';
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = options.maxRetries ?? 3;
  }

  /** Calls a Bot API method with JSON parameters. */
  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: {signal?: AbortSignal} = {},
  ): Promise<T> {
    return this.withRetry(method, options.signal, async () => {
      const response = await this.doFetch(this.methodUrl(method), {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(prune(params)),
        signal: options.signal,
      });
      return (await response.json()) as TgResponse<T>;
    });
  }

  /** Calls a Bot API method that carries a file upload. */
  async upload<T>(
    method: string,
    params: Record<string, unknown>,
    file: UploadFile,
    options: {signal?: AbortSignal} = {},
  ): Promise<T> {
    return this.withRetry(method, options.signal, async () => {
      const form = new FormData();
      for (const [key, value] of Object.entries(prune(params))) {
        form.append(
          key,
          typeof value === 'string' ? value : JSON.stringify(value),
        );
      }
      form.append(
        file.field,
        new Blob([toArrayBuffer(file.bytes)], {
          type: file.mimeType ?? 'application/octet-stream',
        }),
        file.fileName,
      );

      const response = await this.doFetch(this.methodUrl(method), {
        method: 'POST',
        body: form,
        signal: options.signal,
      });
      return (await response.json()) as TgResponse<T>;
    });
  }

  /**
   * Downloads a file the bot has been sent.
   *
   * Bots may only download files up to 20 MB; `getFile` fails above that. Note
   * the API docs' warning that this path does not preserve the original name or
   * mime type — both must be read off the `Message` at normalization time.
   */
  async download(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const file = await this.call<TgFile>(
      'getFile',
      {file_id: fileId},
      {signal},
    );
    if (!file.file_path) {
      throw new Error(`Telegram returned no file_path for ${fileId}.`);
    }
    const response = await this.doFetch(
      `${this.baseUrl}/file/bot${this.token}/${file.file_path}`,
      {signal},
    );
    if (!response.ok) {
      throw new Error(
        `Downloading ${fileId} failed: ${response.status} ${response.statusText}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  private methodUrl(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  /** Runs a call, honouring the `retry_after` Telegram sends with a 429. */
  private async withRetry<T>(
    method: string,
    signal: AbortSignal | undefined,
    send: () => Promise<TgResponse<T>>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const payload = await send();

      if (payload.ok) {
        return payload.result as T;
      }

      const retryAfter = payload.parameters?.retry_after;
      const canRetry =
        payload.error_code === 429 &&
        retryAfter !== undefined &&
        attempt < this.maxRetries;

      if (!canRetry) {
        throw new TelegramApiError(
          method,
          payload.error_code,
          payload.description ?? 'unknown error',
          retryAfter,
        );
      }

      await sleep(retryAfter * 1000, signal);
    }
  }
}

/** Drops undefined entries, which Telegram rejects rather than ignores. */
function prune(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
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
