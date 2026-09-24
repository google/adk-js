/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionCall} from '@google/genai';

import {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from '../agents/functions.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event, getFunctionCalls} from '../events/event.js';
import {logger} from '../utils/logger.js';
import {BasePlugin} from './base_plugin.js';

/**
 * Optional HMAC integrity check for HITL tool-call arguments.
 *
 * When an agent pauses for human approval (`adk_request_confirmation`) or user
 * input (`adk_request_input`), the pending tool call lives in the session
 * store until the human responds. If the session store is compromised, an
 * attacker can silently alter the call's arguments between the moment the
 * human reviews the call and the moment the agent executes it.
 *
 * {@link ToolCallIntegrityPlugin} stamps each HITL tool call with
 * `HMAC(secretKey, canonical(call))` and verifies the HMAC before every agent
 * run. Because the attacker does not possess the secret key, they cannot forge
 * a valid HMAC for tampered arguments.
 *
 * Design constraints:
 *
 * - **HITL-scoped**: only `adk_request_confirmation` and `adk_request_input`
 *   function calls are stamped.
 * - **No cross-event chain**: each HMAC is independent, so concurrent or
 *   out-of-order event writes do not cause false positives.
 * - **Server-side only**: the HMAC is stored in `customMetadata` and verified
 *   in `beforeRunCallback`.
 * - **HMAC-only**: a secret key is mandatory.
 * - **Key rotation**: pass a list of keys; the first is used for minting, all
 *   are tried during validation.
 */

/** `customMetadata` key that maps `{functionCallId: hmacHex}`. */
const HMAC_META_KEY = '_hitl_hmac';

const HITL_NAMES: ReadonlySet<string> = new Set([
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
]);

/** How validation failures are handled. */
export enum EnforcementMode {
  /** Validate but only warn about missing stamps; invocation proceeds. */
  SHADOW_MODE = 'shadow',
  /** Validate and reject; invocation is aborted. */
  BLOCK_MODE = 'block',
}

/** An HMAC mismatch indicates a HITL tool call was tampered with. */
export class ToolCallIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolCallIntegrityError';
  }
}

/** A secret key, as raw bytes or a string encoded as UTF-8. */
export type ToolCallIntegrityKey = string | Uint8Array;

export interface ToolCallIntegrityPluginOptions {
  /**
   * A single key or a list of keys for rotation. The first key is used for
   * minting, all keys are tried during validation.
   */
  secretKey: ToolCallIntegrityKey | readonly ToolCallIntegrityKey[];

  /** Defaults to {@link EnforcementMode.BLOCK_MODE}. */
  enforcement?: EnforcementMode;

  /** Defaults to 'tool_call_integrity'. */
  name?: string;
}

/**
 * Normalizes a value for store stability: drops `null`/`undefined` object
 * values, matching the adk-python canonical form. Integral floats need no
 * coercion because JavaScript has a single number type.
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== null && item !== undefined) {
        result[key] = normalize(item);
      }
    }
    return result;
  }
  return value;
}

/** JSON with object keys sorted at every level and no whitespace. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const entries = Object.keys(source)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic bytes binding a tool call to its session identity. */
function canonicalPayload(
  invocationContext: InvocationContext,
  functionCall: FunctionCall,
): Uint8Array<ArrayBuffer> {
  const session = invocationContext.session;
  return new TextEncoder().encode(
    canonicalJson(
      normalize({
        app_name: session.appName,
        user_id: session.userId,
        session_id: session.id,
        name: functionCall.name,
        id: functionCall.id,
        args: functionCall.args ?? {},
      }),
    ),
  );
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** Decodes a lowercase or uppercase hex string, or returns undefined. */
function fromHex(hex: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) {
    return undefined;
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    return undefined;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'ToolCallIntegrityPlugin requires the Web Crypto API ' +
        '(globalThis.crypto.subtle), which is not available in this ' +
        'environment.',
    );
  }
  return subtle;
}

/**
 * Optional HMAC guard for human-in-the-loop tool calls.
 *
 * Detects tampering with pending `adk_request_confirmation` /
 * `adk_request_input` tool calls when the session store is compromised.
 *
 * On `onEventCallback`, stamps each HITL call with `HMAC(key, canonical(call))`
 * in `customMetadata['_hitl_hmac']`.
 *
 * On `beforeRunCallback`, recomputes the HMAC from the stored call and
 * compares; a mismatch means the call's arguments were altered after minting.
 *
 * To rotate keys: deploy `[newKey, oldKey]`, wait for in-flight sessions to
 * drain, then deploy `[newKey]`.
 *
 * Note: `PluginManager` wraps plugin exceptions in a generic `Error`. Callers
 * should inspect its `cause` to find the original
 * {@link ToolCallIntegrityError}.
 *
 * Example:
 * ```typescript
 * const plugin = new ToolCallIntegrityPlugin({secretKey: 'rotate-me-regularly'});
 *
 * // Key rotation: mint with the new key, validate with both.
 * new ToolCallIntegrityPlugin({secretKey: ['new-key', 'old-key']});
 *
 * // Shadow mode: tolerate missing stamps with a warning.
 * new ToolCallIntegrityPlugin({
 *   secretKey: 'rotate-me-regularly',
 *   enforcement: EnforcementMode.SHADOW_MODE,
 * });
 * ```
 */
export class ToolCallIntegrityPlugin extends BasePlugin {
  private readonly keys: Array<Uint8Array<ArrayBuffer>>;
  private readonly enforcement: EnforcementMode;
  private cryptoKeys?: Promise<CryptoKey[]>;

  constructor(options: ToolCallIntegrityPluginOptions) {
    super(options.name ?? 'tool_call_integrity');
    const rawKeys: readonly ToolCallIntegrityKey[] =
      typeof options.secretKey === 'string' ||
      options.secretKey instanceof Uint8Array
        ? [options.secretKey]
        : [...options.secretKey];
    const keys = rawKeys.map((key) =>
      typeof key === 'string'
        ? new TextEncoder().encode(key)
        : new Uint8Array(key),
    );
    if (keys.length === 0 || keys.some((key) => key.length === 0)) {
      throw new Error('secretKey must be a non-empty key or list of keys');
    }
    this.keys = keys;
    this.enforcement = options.enforcement ?? EnforcementMode.BLOCK_MODE;
  }

  private getCryptoKeys(): Promise<CryptoKey[]> {
    if (!this.cryptoKeys) {
      const subtle = getSubtleCrypto();
      this.cryptoKeys = Promise.all(
        this.keys.map((key) =>
          subtle.importKey('raw', key, {name: 'HMAC', hash: 'SHA-256'}, false, [
            'sign',
            'verify',
          ]),
        ),
      );
    }
    return this.cryptoKeys;
  }

  /** HMAC with the primary (first) key, used for minting. */
  private async mintHmac(payload: Uint8Array<ArrayBuffer>): Promise<string> {
    const [primary] = await this.getCryptoKeys();
    return toHex(await getSubtleCrypto().sign('HMAC', primary, payload));
  }

  /**
   * Checks `stored` against every key; true if any matches. `subtle.verify`
   * compares in constant time.
   */
  private async verifyHmac(
    payload: Uint8Array<ArrayBuffer>,
    stored: unknown,
  ): Promise<boolean> {
    const signature = fromHex(stored);
    if (!signature) {
      return false;
    }
    const subtle = getSubtleCrypto();
    for (const key of await this.getCryptoKeys()) {
      if (await subtle.verify('HMAC', key, signature, payload)) {
        return true;
      }
    }
    return false;
  }

  override async onEventCallback({
    invocationContext,
    event,
  }: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    const hmacs: Record<string, string> = {};
    for (const fc of getFunctionCalls(event)) {
      if (fc.id && fc.name && HITL_NAMES.has(fc.name)) {
        hmacs[fc.id] = await this.mintHmac(
          canonicalPayload(invocationContext, fc),
        );
      }
    }
    if (Object.keys(hmacs).length > 0) {
      event.customMetadata = {
        ...(event.customMetadata ?? {}),
        [HMAC_META_KEY]: hmacs,
      };
    }
    return undefined;
  }

  override async beforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    for (const event of invocationContext.session.events) {
      const rawStored = event.customMetadata?.[HMAC_META_KEY];
      const stored =
        rawStored !== null && typeof rawStored === 'object'
          ? (rawStored as Record<string, unknown>)
          : undefined;

      // Track which stored HMAC entries were matched to a live function call.
      const validatedIds = new Set<string>();

      for (const fc of getFunctionCalls(event)) {
        if (!fc.id || !fc.name || !HITL_NAMES.has(fc.name)) {
          continue;
        }
        if (!stored || !Object.prototype.hasOwnProperty.call(stored, fc.id)) {
          // HITL call with no HMAC: either pre-plugin or stripped. Shadow mode
          // tolerates this (pre-plugin sessions); block mode rejects it.
          const message = `Missing HMAC on ${fc.name} call '${fc.id}' — HITL call has no integrity stamp.`;
          if (this.enforcement === EnforcementMode.BLOCK_MODE) {
            throw new ToolCallIntegrityError(message);
          }
          logger.warn(message);
          continue;
        }
        validatedIds.add(fc.id);
        const payload = canonicalPayload(invocationContext, fc);
        if (!(await this.verifyHmac(payload, stored[fc.id]))) {
          // A mismatch is always fatal: an HMAC was present but wrong, which is
          // proof of tampering, not a migration gap.
          throw new ToolCallIntegrityError(
            `HMAC mismatch on ${fc.name} call '${fc.id}' — tool call arguments were tampered with.`,
          );
        }
      }

      // Stored HMACs with no matching HITL call: the attacker renamed the
      // function call to dodge validation.
      if (stored) {
        const orphaned = Object.keys(stored).filter(
          (id) => !validatedIds.has(id),
        );
        if (orphaned.length > 0) {
          throw new ToolCallIntegrityError(
            `Stored HMAC(s) for call(s) ${orphaned.map((id) => `'${id}'`).join(', ')} have no matching HITL function call — call may have been renamed.`,
          );
        }
      }
    }
    return undefined;
  }
}
