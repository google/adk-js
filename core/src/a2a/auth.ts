/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {timingSafeEqual} from 'node:crypto';
import {A2aUserBuilder} from './agent_to_a2a.js';

/** A shared secret identifies a deployment, not an individual principal. */
const AUTHENTICATED_USER_NAME = 'a2a-bearer-token';

const BEARER_SCHEME_PREFIX = 'bearer ';

/** Compares two secrets without leaking their contents through timing. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, so the lengths must be
  // compared first. The length of a rejected credential is not a secret.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Builds an {@link A2aUserBuilder} that authenticates A2A requests against a
 * shared bearer token.
 *
 * Callers must send `Authorization: Bearer <token>`; the credential is
 * compared against `token` in constant time, and a request with a missing,
 * malformed or incorrect one is rejected before the agent or any of its tools
 * is invoked. Serve the surface over HTTPS, or the secret travels in clear
 * text on every call.
 *
 * ```ts
 * toA2a(agent, {authentication: bearerTokenUserBuilder(process.env.MY_TOKEN)});
 * ```
 *
 * A rejected request surfaces as whatever the `@a2a-js/sdk` handler produces
 * for a failing `UserBuilder`, which is an HTTP 500 rather than a 401. The
 * guarantee here is that the agent is never reached, not that the caller gets
 * a particular status code.
 *
 * @param token The shared secret callers must present; surrounding whitespace
 *   is trimmed, because HTTP strips it from header values anyway.
 * @throws If `token` is empty or contains only whitespace.
 */
export function bearerTokenUserBuilder(token: string): A2aUserBuilder {
  const expected = token.trim();
  if (!expected) {
    throw new Error(
      'bearerTokenUserBuilder: an empty A2A bearer token is not a valid ' +
        'authenticator. Supply a real shared secret, or configure no token ' +
        'at all to run the A2A surface unauthenticated.',
    );
  }

  return async (req) => {
    const header = req.headers.authorization ?? '';
    // RFC 6750 makes the bearer scheme case-insensitive.
    const credential = header.toLowerCase().startsWith(BEARER_SCHEME_PREFIX)
      ? header.slice(BEARER_SCHEME_PREFIX.length)
      : '';
    if (!timingSafeEqualStrings(credential, expected)) {
      throw new Error(
        'A2A request rejected: missing or invalid `Authorization: Bearer` ' +
          'credential.',
      );
    }
    return {isAuthenticated: true, userName: AUTHENTICATED_USER_NAME};
  };
}
