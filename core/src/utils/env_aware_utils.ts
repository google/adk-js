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

/**
 * Generates a random UUID.
 */
const UUID_MASK = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
export function randomUUID() {
  let uuid = '';

  for (let i = 0; i < UUID_MASK.length; i++) {
    const randomValue = (Math.random() * 16) | 0;

    if (UUID_MASK[i] === 'x') {
      uuid += randomValue.toString(16);
    } else if (UUID_MASK[i] === 'y') {
      uuid += ((randomValue & 0x3) | 0x8).toString(16);
    } else {
      uuid += UUID_MASK[i];
    }
  }

  return uuid;
}

/**
 * Encodes the given string to base64.
 *
 * @param data The string to encode.
 * @return The base64-encoded string.
 */
export function base64Encode(data: string): string {
  if (isBrowser()) {
    return window.btoa(data);
  }

  return Buffer.from(data).toString('base64');
}

/**
 * Decodes the given base64 string to a string.
 *
 * @param data The base64-encoded string.
 * @return The decoded string.
 */
export function base64Decode(data: string): string {
  if (isBrowser()) {
    return window.atob(data);
  }

  return Buffer.from(data, 'base64').toString();
}

/**
 * Checks if the given string is base64-encoded.
 *
 * @param data The string to check.
 * @return True if the string is base64-encoded, false otherwise.
 */
export function isBase64Encoded(data: string): boolean {
  try {
    return base64Encode(base64Decode(data)) === data;
  } catch (e) {
    return false;
  }
}
