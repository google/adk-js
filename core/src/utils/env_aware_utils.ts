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
 * Generates a random UUID from a cryptographically secure source.
 *
 * `crypto.randomUUID()` is only exposed in secure contexts, so it is absent on
 * plain-HTTP origins even though `crypto` itself is present.
 * `crypto.getRandomValues()` carries no such restriction, so it is used as the
 * fallback rather than `Math.random()`.
 *
 * Some callers use this value to make security decisions — the OAuth2 `state`
 * parameter in `AuthHandler` and the session identifiers minted by the session
 * services — so this function must not silently degrade to a non-cryptographic
 * generator.
 */
export function randomUUID(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  if (globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    // RFC 4122 section 4.4: version 4 in the high nibble of octet 6, variant
    // 10xx in the two high bits of octet 8.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
    return [
      hex.slice(0, 4),
      hex.slice(4, 6),
      hex.slice(6, 8),
      hex.slice(8, 10),
      hex.slice(10, 16),
    ]
      .map((group) => group.join(''))
      .join('-');
  }

  throw new Error(
    'randomUUID: no cryptographically secure source of randomness is ' +
      'available. Neither crypto.randomUUID() nor crypto.getRandomValues() is ' +
      'present in this environment.',
  );
}

/**
 * Encodes the given string or Uint8Array to base64.
 *
 * @param data The data to encode.
 * @return The base64-encoded string.
 */
export function base64Encode(data: string | Uint8Array): string {
  if (isBrowser()) {
    let strData = '';
    if (typeof data === 'string') {
      strData = data;
    } else {
      const len = data.byteLength;
      for (let i = 0; i < len; i++) {
        strData += String.fromCharCode(data[i]);
      }
    }
    // eslint-disable-next-line no-undef
    return window.btoa(strData);
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
    // eslint-disable-next-line no-undef
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
  } catch (_e: unknown) {
    return false;
  }
}

/**
 * Gets the boolean value of the given environment variable.
 *
 * @param envVar The environment variable to get the value of.
 * @return The boolean value of the environment variable.
 */
export function getBooleanEnvVar(envVar: string): boolean {
  if (!process.env) {
    return false;
  }

  const envVarValue = (process.env[envVar] || '').toLowerCase();

  return ['true', '1'].includes(envVarValue);
}
