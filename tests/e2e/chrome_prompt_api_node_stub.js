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

export function createLogger() {
  const noop = () => {};
  return {debug: noop, info: noop, warn: noop, error: noop};
}

export const transports = {Console: class {}};
export const config = {npm: {levels: {}}};

export default {
  AsyncLocalStorage,
  config,
  createLogger,
  format,
  hostname,
  inspect,
  randomUUID,
  transports,
};
