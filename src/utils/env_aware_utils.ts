/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns true if the environment is a browser.
 */
export function isBrowser() {
  return typeof window !== 'undefined';
}

const crypto = isBrowser() ? window.crypto : require('crypto');

/**
 * Generates a random UUID.
 */
export function randomUUID() {
  return crypto.randomUUID();
}
