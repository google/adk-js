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
