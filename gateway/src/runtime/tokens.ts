/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Short opaque handles for button payloads.
 *
 * Two reasons this exists, and the second matters more than the first:
 *
 * 1. **Size.** Telegram allows 64 bytes of `callback_data`, which will not hold
 *    an interrupt id plus an answer.
 * 2. **Binding.** A button payload comes back from the client, so a user can
 *    send whatever they like. A token is unguessable and remembers which
 *    session it was issued for, so a crafted press cannot answer somebody
 *    else's pending question.
 */

import {randomUUID} from 'node:crypto';

/** What a button press stands for. */
export interface ActionToken {
  /** The session the button was offered in. */
  sessionId: string;
  /** The interrupt this answers. */
  interruptId: string;
  /** The framework call name to answer with. */
  functionCallName: string;
  /** The answer itself. */
  value: unknown;
}

/** Options for {@link ActionTokenStore}. */
export interface ActionTokenStoreOptions {
  /** How long a token stays valid, in milliseconds. Defaults to 24 hours. */
  ttlMs?: number;
  /** Most tokens to retain. Defaults to 10,000. */
  maxEntries?: number;
  /** Injectable for tests. */
  now?: () => number;
}

interface StoredToken extends ActionToken {
  expiresAt: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

/** An in-memory token store. */
export class ActionTokenStore {
  private readonly tokens = new Map<string, StoredToken>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: ActionTokenStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** Mints a handle for one answer. */
  issue(token: ActionToken): string {
    this.evictIfFull();
    // 22 URL-safe characters: unguessable, and well inside Telegram's 64 bytes
    // once a caller has added any prefix of their own.
    const id = randomUUID().replace(/-/g, '').slice(0, 22);
    this.tokens.set(id, {...token, expiresAt: this.now() + this.ttlMs});
    return id;
  }

  /**
   * Resolves a handle, if it is valid and belongs to this session.
   *
   * Returns `undefined` for an unknown, expired or mismatched token — a caller
   * cannot tell which, which is the point.
   */
  resolve(id: string, sessionId: string): ActionToken | undefined {
    const stored = this.tokens.get(id);
    if (!stored) {
      return undefined;
    }
    if (stored.expiresAt <= this.now()) {
      this.tokens.delete(id);
      return undefined;
    }
    if (stored.sessionId !== sessionId) {
      return undefined;
    }
    return stored;
  }

  /**
   * Spends a handle so the same button cannot be pressed twice.
   *
   * Telegram leaves a keyboard on screen after it is used, so without this a
   * user can approve the same action repeatedly.
   */
  consume(id: string, sessionId: string): ActionToken | undefined {
    const token = this.resolve(id, sessionId);
    if (token) {
      this.tokens.delete(id);
    }
    return token;
  }

  /** How many handles are live. Exposed for tests and metrics. */
  get size(): number {
    return this.tokens.size;
  }

  private evictIfFull(): void {
    if (this.tokens.size < this.maxEntries) {
      return;
    }
    const now = this.now();
    for (const [id, token] of this.tokens) {
      if (token.expiresAt <= now) {
        this.tokens.delete(id);
      }
    }
    // Still full of live tokens: drop the oldest, since Map preserves
    // insertion order.
    while (this.tokens.size >= this.maxEntries) {
      const oldest = this.tokens.keys().next();
      if (oldest.done) {
        break;
      }
      this.tokens.delete(oldest.value);
    }
  }
}
