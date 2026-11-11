/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Optional HMAC integrity check for function calls stored in the session.
 *
 * Mirrors adk-python's `google.adk.plugins._tool_call_integrity_plugin`.
 */

import {Content, FunctionCall} from '@google/genai';

import {Context} from '../agents/context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {createEvent, Event, getFunctionCalls} from '../events/event.js';
import {
  INTERNAL_METADATA_PREFIX,
  markRestored,
  RESTORED_EVENT_KEY,
} from '../events/internal_metadata.js';
import {Session} from '../sessions/session.js';
import {BaseTool} from '../tools/base_tool.js';
import {logger} from '../utils/logger.js';
import {BasePlugin} from './base_plugin.js';

/** `customMetadata` key holding `{functionCallId: stamp}`. */
export const TOOL_CALL_HMAC_METADATA_KEY = `${INTERNAL_METADATA_PREFIX}fc_hmac`;

/** Prefix of every stamp, so the payload format can change later. */
const STAMP_PREFIX = 'v1:';

/** A function call in the session failed its integrity check. */
export class ToolCallIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolCallIntegrityError';
  }
}

/** Options for {@link ToolCallIntegrityPlugin}. */
export interface ToolCallIntegrityPluginOptions {
  /**
   * The HMAC key, or a list of keys during rotation. The first key stamps new
   * calls; every key is accepted when verifying.
   */
  secretKey: Uint8Array | readonly Uint8Array[];

  /**
   * Log a warning instead of throwing for function calls that have no stamp,
   * such as calls stored before the plugin was installed. Such calls also run,
   * so this reports tampering that removes a stamp but does not prevent it. A
   * stamp that is present but wrong is always rejected. Defaults to `false`.
   */
  allowUnstampedCalls?: boolean;

  /** The plugin name. Defaults to `'tool_call_integrity'`. */
  name?: string;
}

/**
 * Returns `value` in the JSON form that the session stores write, so values
 * such as dates verify after a round trip through storage.
 */
function jsonForm(value: unknown): unknown {
  const json = JSON.stringify(value);
  return json === undefined ? null : JSON.parse(json);
}

/** JSON with object keys sorted at every level and no whitespace. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The call's args in the JSON form that the session stores write. */
function jsonArgs(args: Record<string, unknown> | undefined): unknown {
  const json = jsonForm(args ?? {});
  return json ?? {};
}

/**
 * The bytes a stamp covers: session, invocation, branch, author and call.
 *
 * The field names and JSON form match adk-python, so a stamp written by one
 * verifies in the other for the argument values both encode the same way.
 */
function canonicalPayload(
  session: Session,
  event: Event,
  functionCall: FunctionCall,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    canonicalJson({
      app_name: session.appName,
      user_id: session.userId,
      session_id: session.id,
      invocation_id: event.invocationId ?? null,
      branch: event.branch ?? null,
      author: event.author ?? null,
      name: functionCall.name ?? null,
      id: functionCall.id ?? null,
      args: jsonArgs(functionCall.args),
    }),
  );
}

function isStampMap(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(
      // eslint-disable-next-line no-control-regex
      (stamp) => typeof stamp === 'string' && /^[\x00-\x7f]*$/.test(stamp),
    )
  );
}

function isRestored(event: Event): boolean {
  return Boolean(event.customMetadata?.[RESTORED_EVENT_KEY]);
}

/** Returns the event's stamps, throwing if the metadata is malformed. */
function getStamps(event: Event): Record<string, string> {
  const stamps = event.customMetadata?.[TOOL_CALL_HMAC_METADATA_KEY];
  if (stamps === undefined || stamps === null) {
    return {};
  }
  if (!isStampMap(stamps)) {
    throw new ToolCallIntegrityError(
      `Event '${event.id}' has a malformed integrity stamp.`,
    );
  }
  return stamps;
}

function hasStamp(stamps: Record<string, string>, callId: string): boolean {
  return Object.hasOwn(stamps, callId);
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** Decodes the 64 lowercase hex digits of a SHA-256 HMAC, or returns undefined. */
function fromHex(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
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
 * Stamps function calls and verifies them before runs and tool calls.
 *
 * `onEventCallback` adds `"v1:" + HMAC-SHA256(key, payload)` for each function
 * call to `event.customMetadata["__adk_internal_fc_hmac"]`, and throws
 * {@link ToolCallIntegrityError} for a response that repeats a call ID before
 * it is stored. `beforeRunCallback` recomputes the HMAC for every function call
 * with an ID in the session history, answered or not, and throws when a stamp
 * is wrong, malformed, repeated or left over from a call that no longer
 * matches. `beforeToolCallback` lets a tool run only when every stored copy of
 * its call verifies and the tool's name and arguments match one of them; it
 * always refuses a call with no ID. Unstamped calls are rejected unless
 * `allowUnstampedCalls` is set, in which case they are logged.
 *
 * Events without function calls are ignored. Events marked as restored are not
 * verified, and their function calls are never executed. ADK marks events
 * restored by `adk run --replay`, and {@link prepareRestoredEvent} marks events
 * that your code copies. Anyone who can write to the session store can also
 * set the marker, but `beforeToolCallback` still refuses those events' calls.
 *
 * `PluginManager` re-throws plugin errors as a generic `Error`; the
 * {@link ToolCallIntegrityError} is its `cause`.
 *
 * Register this plugin before other plugins. `PluginManager` stops at the first
 * `onEventCallback` that returns an event, and a later plugin must not change
 * function calls or replace `customMetadata`.
 *
 * Requires the Web Crypto API (`globalThis.crypto.subtle`), available in
 * browsers and in Node.js 19 and later.
 *
 * Example:
 * ```typescript
 * const plugin = new ToolCallIntegrityPlugin({secretKey: keyBytes});
 * const app = {name: 'my_app', rootAgent: agent, plugins: [plugin]};
 *
 * // Key rotation: stamp with the new key, accept both.
 * new ToolCallIntegrityPlugin({secretKey: [newKeyBytes, oldKeyBytes]});
 * ```
 */
export class ToolCallIntegrityPlugin extends BasePlugin {
  private readonly keys: Array<Uint8Array<ArrayBuffer>>;
  private readonly allowUnstampedCalls: boolean;
  private cryptoKeys?: Promise<CryptoKey[]>;

  /**
   * @throws {Error} If `secretKey` is empty or contains a key that is not
   *     non-empty bytes.
   */
  constructor(options: ToolCallIntegrityPluginOptions) {
    super(options.name ?? 'tool_call_integrity');
    const secretKey: unknown = options.secretKey;
    const rawKeys: unknown[] =
      secretKey instanceof Uint8Array
        ? [secretKey]
        : Array.isArray(secretKey)
          ? [...secretKey]
          : [];
    if (
      rawKeys.length === 0 ||
      !rawKeys.every((key) => key instanceof Uint8Array && key.length > 0)
    ) {
      throw new Error(
        'secretKey must be non-empty bytes or a non-empty list of them.',
      );
    }
    // Copied, so a caller mutating its buffer cannot change the key.
    this.keys = (rawKeys as Uint8Array[]).map((key) => new Uint8Array(key));
    this.allowUnstampedCalls = options.allowUnstampedCalls ?? false;
  }

  /**
   * Returns a copy with internal metadata removed and marked as restored.
   *
   * Use it on events that your code copies into another session, so that the
   * history passes the integrity check. The copy only keeps the history: its
   * function calls are never executed.
   *
   * @param event The event to copy. It is not modified.
   * @returns The marked copy, ready to append to the new session.
   */
  static prepareRestoredEvent(event: Event): Event {
    return markRestored(createEvent(structuredClone(event)));
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

  private async sign(payload: Uint8Array<ArrayBuffer>): Promise<string> {
    const [primary] = await this.getCryptoKeys();
    const digest = await getSubtleCrypto().sign('HMAC', primary, payload);
    return STAMP_PREFIX + toHex(digest);
  }

  /** `subtle.verify` compares in constant time. */
  private async verify(
    payload: Uint8Array<ArrayBuffer>,
    stamp: string,
  ): Promise<boolean> {
    if (!stamp.startsWith(STAMP_PREFIX)) {
      return false;
    }
    const signature = fromHex(stamp.slice(STAMP_PREFIX.length));
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

  private unstamped(name: string | undefined, callId: string): void {
    const message = `${name} call '${callId}' has no integrity stamp.`;
    if (!this.allowUnstampedCalls) {
      throw new ToolCallIntegrityError(message);
    }
    logger.warn(message);
  }

  override async onEventCallback({
    invocationContext,
    event,
  }: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    const session = invocationContext.session;
    const calls = getFunctionCalls(event).filter((fc) => fc.id);
    // Stamps are keyed by call ID, so a response that repeats an ID cannot be
    // stamped, and beforeRunCallback would reject the session on every later
    // run. This is hypothetical: model provider APIs emit unique IDs, and ADK
    // fills in missing ones. The response is refused before it is stored, so
    // none of its calls run and the session stays usable. Partial events are
    // neither stored nor executed.
    if (!event.partial) {
      const seen = new Set<string>();
      for (const fc of calls) {
        if (seen.has(fc.id!)) {
          throw new ToolCallIntegrityError(
            `Event '${event.id}' repeats function call ID '${fc.id}'.`,
          );
        }
        seen.add(fc.id!);
      }
    }
    const stamps: Record<string, string> = {};
    for (const fc of calls) {
      stamps[fc.id!] = await this.sign(canonicalPayload(session, event, fc));
    }
    if (Object.keys(stamps).length > 0) {
      event.customMetadata = {
        ...(event.customMetadata ?? {}),
        [TOOL_CALL_HMAC_METADATA_KEY]: stamps,
      };
    }
    return undefined;
  }

  override async beforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    const session = invocationContext.session;
    for (const event of session.events) {
      const calls = getFunctionCalls(event);
      // A stamp on an event without calls has nothing to execute. Calls in
      // restored events are refused by beforeToolCallback instead.
      if (calls.length === 0 || isRestored(event)) {
        continue;
      }

      const stamps = getStamps(event);
      const verified = new Set<string>();
      for (const fc of calls) {
        // A call without an ID cannot be stamped. beforeToolCallback refuses
        // to run it, so there is nothing to check here.
        if (!fc.id) {
          continue;
        }
        if (!hasStamp(stamps, fc.id)) {
          this.unstamped(fc.name, fc.id);
          continue;
        }
        if (verified.has(fc.id)) {
          throw new ToolCallIntegrityError(
            `Event '${event.id}' has duplicate function call ID '${fc.id}'.`,
          );
        }
        const payload = canonicalPayload(session, event, fc);
        if (!(await this.verify(payload, stamps[fc.id]))) {
          throw new ToolCallIntegrityError(
            `${fc.name} call '${fc.id}' does not match its integrity stamp.`,
          );
        }
        verified.add(fc.id);
      }

      // A stamp without a matching call in its event means the call was
      // renamed, re-keyed or removed.
      const unmatched = Object.keys(stamps)
        .filter((id) => !verified.has(id))
        .sort();
      if (unmatched.length > 0) {
        throw new ToolCallIntegrityError(
          `Event '${event.id}' has integrity stamps with no matching call: ` +
            `${JSON.stringify(unmatched)}.`,
        );
      }
    }
    return undefined;
  }

  override async beforeToolCallback({
    tool,
    toolArgs,
    toolContext,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    const callId = toolContext.functionCallId;
    // ADK gives every new call an ID before running it, so a call without one
    // was replayed from the session and cannot be matched to its stamp.
    if (!callId) {
      throw new ToolCallIntegrityError(
        `${tool.name} call has no ID, so its integrity cannot be checked.`,
      );
    }
    const session = toolContext.invocationContext.session;
    const stored: Array<[Event, FunctionCall]> = [];
    let restored = false;
    for (const event of session.events) {
      for (const fc of getFunctionCalls(event)) {
        if (fc.id !== callId) {
          continue;
        }
        if (isRestored(event)) {
          restored = true;
        } else {
          stored.push([event, fc]);
        }
      }
    }
    if (stored.length === 0) {
      if (restored) {
        throw new ToolCallIntegrityError(
          `${tool.name} call '${callId}' comes from restored history and ` +
            'cannot be executed.',
        );
      }
      this.unstamped(tool.name, callId);
      return undefined;
    }

    // Every stored copy of the call must verify, so a repeated ID cannot
    // borrow the stamp of another copy. Restored copies are never trusted; an
    // unstamped copy is trusted only when allowUnstampedCalls logged it.
    const trusted: FunctionCall[] = [];
    for (const [event, fc] of stored) {
      const stamps = getStamps(event);
      if (!hasStamp(stamps, callId)) {
        this.unstamped(tool.name, callId);
      } else if (
        !(await this.verify(
          canonicalPayload(session, event, fc),
          stamps[callId],
        ))
      ) {
        throw new ToolCallIntegrityError(
          `${tool.name} call '${callId}' does not match its integrity stamp.`,
        );
      }
      trusted.push(fc);
    }

    // What runs must be one of those calls, whichever copy ADK took the
    // arguments from.
    const executed = canonicalJson(jsonArgs(toolArgs));
    const matches = trusted.some(
      (fc) =>
        fc.name === tool.name && canonicalJson(jsonArgs(fc.args)) === executed,
    );
    if (!matches) {
      throw new ToolCallIntegrityError(
        `${tool.name} call '${callId}' arguments do not match its stored call.`,
      );
    }
    return undefined;
  }
}
