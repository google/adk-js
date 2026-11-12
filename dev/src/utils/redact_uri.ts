/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Query parameters that carry a credential in the connection URIs this helper
 * guards. Matched case-insensitively, since drivers accept them that way.
 */
const SECRET_QUERY_PARAMS = new Set([
  'password',
  'passwd',
  'pwd',
  'sslpassword',
  'code',
  'access_token',
  'id_token',
  'refresh_token',
  'client_secret',
  'code_verifier',
]);

/**
 * Redacts credentials from a URI so it can be safely included in error
 * messages and logs.
 *
 * @param uri The URI to redact credentials from.
 * @returns The redacted URI string.
 */
export function redactUriPassword(uri: string): string {
  try {
    const url = new URL(uri);
    let redacted = false;

    if (url.password) {
      url.password = '***';
      redacted = true;
    }

    for (const name of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_PARAMS.has(name.toLowerCase())) {
        url.searchParams.set(name, '***');
        redacted = true;
      }
    }

    return redacted ? url.toString() : uri;
  } catch {
    const schemeEnd = uri.indexOf('://');
    return schemeEnd === -1
      ? '<unparseable URI, redacted>'
      : `${uri.slice(0, schemeEnd)}://<unparseable URI, redacted>`;
  }
}
