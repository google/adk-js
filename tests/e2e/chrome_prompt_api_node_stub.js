/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stand-ins for the Node built-ins the adapter's import graph reaches but never
 * calls in a browser: the logger transport and the client-label helpers.
 *
 * Used only by `chrome_prompt_api_test.ts`, to bundle the adapter for a page.
 * Nothing here ships.
 */

export class AsyncLocalStorage {
  getStore() {
    return undefined;
  }
  run(_store, fn) {
    return fn();
  }
}

export const hostname = () => 'browser';
export const randomUUID = () => globalThis.crypto.randomUUID();
export const format = (...args) => args.join(' ');
export const inspect = (value) => String(value);

/**
 * Reached through the OAuth2 PKCE helpers, which nothing in these tests calls.
 * They throw rather than return something plausible, so a future test that does
 * reach them fails loudly instead of quietly signing with a stub.
 */
const unsupported = (name) => () => {
  throw new Error(`${name} is not available in the browser test bundle`);
};
export const createHash = unsupported('createHash');
export const randomBytes = unsupported('randomBytes');

export function createLogger() {
  const noop = () => {};
  return {debug: noop, info: noop, warn: noop, error: noop};
}

export const transports = {Console: class {}};
export const config = {npm: {levels: {}}};

export default {
  AsyncLocalStorage,
  config,
  createHash,
  createLogger,
  format,
  hostname,
  inspect,
  randomBytes,
  randomUUID,
  transports,
};
