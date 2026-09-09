/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser stand-in for the `node:crypto` builtin, wired up by the alias in
 * `build.js` so that the Node fallback in `env_aware_utils.ts` does not pull a
 * Node builtin into the web bundle.
 *
 * `randomUUID` is reached here only after both `globalThis.crypto` branches in
 * `env_aware_utils.ts` have been ruled out. In a browser that means the Web
 * Crypto API is genuinely absent, so there is no secure source left to fall
 * back to and the only correct move is to fail rather than degrade.
 */
export function randomUUID(): string {
  throw new Error(
    'randomUUID: no cryptographically secure source of randomness is ' +
      'available. Neither crypto.randomUUID() nor crypto.getRandomValues() is ' +
      'present in this environment.',
  );
}

/**
 * Stand-in for `createHash`, reached from the PKCE helpers in
 * `auth/oauth2/oauth2_utils.ts`.
 *
 * A PKCE code challenge needs a synchronous SHA-256, and the Web Crypto API
 * offers none: `crypto.subtle.digest` is asynchronous, while `generateAuthUri`
 * is called from synchronous public API. PKCE is therefore unavailable in the
 * bundled web build, and this throws rather than emit an authorization request
 * with a missing or forged challenge.
 */
export function createHash(_algorithm: string): never {
  throw new Error(
    'createHash: PKCE code challenges require a synchronous SHA-256, which ' +
      'the Web Crypto API does not provide (crypto.subtle.digest is async).',
  );
}

/**
 * Stand-in for `randomBytes`, reached when the PKCE helpers in
 * `auth/oauth2/oauth2_utils.ts` generate a code verifier.
 */
export function randomBytes(_size: number): never {
  throw new Error(
    'randomBytes: no cryptographically secure source of randomness is ' +
      'available in this environment.',
  );
}
