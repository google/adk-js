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
]);

/**
 * Redacts the credentials from a connection URI so the URI can be safely
 * included in error messages and logs.
 *
 * A database or session-service connection URI such as
 * `postgres://user:password@host:5432/db` embeds the password in its userinfo
 * component. Including such a URI verbatim in a thrown Error or log entry leaks
 * the credential to wherever those are collected (log files, error-tracking
 * services, stdout captured by an orchestrator), which is frequently a
 * different trust boundary from whoever provisioned the connection string.
 *
 * The same credential can instead arrive as a query parameter, for example
 * `postgres://user@host/db?password=secret`, which several drivers accept and
 * which reaches the same error paths. Both forms are masked.
 *
 * The rest of the URI is kept intact for debugging, mirroring the semantics of
 * Go's `net/url.URL.Redacted()`. A URI carrying no credential is returned
 * unchanged, byte for byte.
 *
 * If the input cannot be parsed as a URL, only its scheme prefix is returned so
 * that a credential embedded in an otherwise-unparseable string is not leaked.
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
