/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from './env_aware_utils.js';
import {logger} from './logger.js';

/**
 * Returns a new unique ID string.
 */
export type IdProvider = () => string;

let idProvider: IdProvider | undefined;

/**
 * Sets the function used to generate event, invocation, session and
 * function-call IDs. Without a provider, every ID keeps its default format.
 *
 * Useful when random IDs are not unique, e.g. runtimes restored from one
 * memory snapshot share RNG state. Like adk-python's `set_id_provider`, but
 * global instead of scoped to an async context.
 *
 * Each value must be a non-empty string that no other runtime produces.
 * Session IDs come from it too, so the values should also be hard to guess.
 * For runtimes restored from a VM snapshot, use `urandomIdProvider`.
 *
 * @param provider A function that returns a unique ID string.
 */
export function setIdProvider(provider: IdProvider): void {
  idProvider = provider;
}

/**
 * Removes the provider set with `setIdProvider`, so IDs go back to their
 * default formats.
 */
export function resetIdProvider(): void {
  idProvider = undefined;
}

/**
 * Returns a new unique ID from the provider set with `setIdProvider`, or a
 * random v4 UUID when none is set.
 */
export function newId(): string {
  return newIdOr(randomUUID);
}

/**
 * Returns a new unique ID from the provider set with `setIdProvider`, or from
 * `fallback` when none is set.
 *
 * Internal to the framework: not part of the public API. For IDs whose default
 * is not a random v4 UUID, such as event IDs.
 *
 * @param fallback A function that returns the default ID.
 */
export function newIdOr(fallback: IdProvider): string {
  return idProvider ? idProvider() : fallback();
}

// The part of `node:fs` that `readUrandom` uses.
interface UrandomFs {
  openSync(path: string, flags: string): number;
  readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): number;
  closeSync(fd: number): void;
}

const URANDOM_PATH = '/dev/urandom';

// `process.getBuiltinModule` (Node 20.16+ and 22.3+, Bun, Deno) loads
// `node:fs` without a static import, so the web bundle needs no alias in
// `build.js`. Everywhere else this returns null.
function nodeFs(): UrandomFs | null {
  const proc = (
    globalThis as {process?: {getBuiltinModule?(id: string): unknown}}
  ).process;
  return (proc?.getBuiltinModule?.('node:fs') as UrandomFs | undefined) ?? null;
}

/**
 * Fills `bytes` from `/dev/urandom`: opens it, reads until the buffer is full,
 * and closes it. Nothing is kept in the process between calls, so a memory
 * snapshot copies no random state and no file descriptor.
 *
 * Internal to the framework: not part of the public API.
 *
 * @throws An error with code `ERR_ADK_NO_FS` where there is no `node:fs`, or
 *     the error from `fs` when `/dev/urandom` cannot be read.
 */
export function readUrandom(
  bytes: Uint8Array,
  fs: UrandomFs | null = nodeFs(),
): void {
  if (!fs) {
    throw Object.assign(
      new Error(`No node:fs module to read ${URANDOM_PATH}.`),
      {
        code: 'ERR_ADK_NO_FS',
      },
    );
  }
  const fd = fs.openSync(URANDOM_PATH, 'r');
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read <= 0) {
        throw new Error(`Read of ${URANDOM_PATH} returned no bytes.`);
      }
      offset += read;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Errors that will not go away by trying again: no file, no permission, or no
// file system at all. After one of these the provider stops reading.
const PERMANENT_ERROR_CODES = new Set([
  'ENOENT',
  'ENOTDIR',
  'ENODEV',
  'ENXIO',
  'ENOSYS',
  'EACCES',
  'EPERM',
  'ERR_ACCESS_DENIED', // Node permission model
  'ERR_ADK_NO_FS',
]);

function isPermanent(error: unknown): boolean {
  const {code, name} = (error ?? {}) as {code?: unknown; name?: unknown};
  return (
    PERMANENT_ERROR_CODES.has(String(code)) ||
    name === 'NotCapable' || // Deno without read permission
    name === 'PermissionDenied'
  );
}

// Node, Bun and Deno all set `process.versions.node`. Browsers and workers
// have no `process`; no VM snapshot clones them, so a warning is only noise.
function isServerRuntime(): boolean {
  const proc = (globalThis as {process?: {versions?: {node?: unknown}}})
    .process;
  return typeof proc?.versions?.node === 'string';
}

function toUuidV4(bytes: Uint8Array): string {
  // RFC 9562: version 4 in the high nibble of octet 6, variant 10xx in the
  // two high bits of octet 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Returns an ID provider that makes a v4 UUID from 16 bytes of `read` for
 * each ID. When a read fails it returns `fallback()` for that ID; after a
 * permanent error it uses `fallback` from then on. On a server runtime it
 * logs one warning the first time it falls back.
 *
 * Internal to the framework: not part of the public API.
 */
export function createUrandomIdProvider(
  read: (bytes: Uint8Array) => void = readUrandom,
  fallback: IdProvider = randomUUID,
  shouldWarn: () => boolean = isServerRuntime,
): IdProvider {
  let stopped = false;
  let warned = false;
  return () => {
    if (stopped) return fallback();
    const bytes = new Uint8Array(16);
    try {
      read(bytes);
      return toUuidV4(bytes);
    } catch (error) {
      stopped = isPermanent(error);
      if (!warned && shouldWarn()) {
        warned = true;
        logger.warn(
          `urandomIdProvider: cannot read ${URANDOM_PATH} (${String(error)}), ` +
            'so IDs come from crypto.randomUUID(). Those can repeat across ' +
            'runtimes restored from one memory snapshot.',
        );
      }
      return fallback();
    }
  };
}

/**
 * An ID provider for runtimes restored from a VM snapshot, such as Lambda
 * MicroVMs or Firecracker: `setIdProvider(urandomIdProvider)`.
 *
 * Each ID is a v4 UUID from 16 bytes read from `/dev/urandom` at that moment.
 * No random state is kept in the process, so a snapshot copies none. In
 * contrast, `Math.random` and the generator behind `node:crypto` live in
 * process memory, so restored copies repeat their values. On a guest kernel
 * with VMGenID support (Linux 5.18+), the kernel reseeds `/dev/urandom` when
 * the VM is restored.
 *
 * Where `/dev/urandom` cannot be read (Windows, a browser, Node before 20.16,
 * Deno without `--allow-read=/dev/urandom`, the Node permission model without
 * `--allow-fs-read=/dev/urandom`), IDs come from `crypto.randomUUID()`
 * instead, and on Node, Bun and Deno one warning is logged.
 */
export const urandomIdProvider: IdProvider = createUrandomIdProvider();
