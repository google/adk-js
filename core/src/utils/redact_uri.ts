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
  // OAuth2 callback/authorization-response URIs carry their own secrets as
  // query parameters rather than in userinfo: an authorization `code` is a
  // single-use, bearer-equivalent credential, and a token response echoed
  // back via URI can carry `access_token`/`id_token`/`refresh_token`.
  // Only the query string is scanned: in the implicit and hybrid flows those
  // token parameters arrive in the fragment, which is left untouched.
  // `client_secret` is not meant to travel in a URL at all, but is included
  // here in case a misconfigured flow puts it there anyway.
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
 * A database or session-service connection URI such as
 * `postgres://user:password@host:5432/db` embeds the password in its userinfo
 * component. An OAuth2 callback/authorization-response URI instead carries
 * its secret (an authorization code, or an echoed token) as a query
 * parameter, for example `https://app/callback?code=SECRET&state=xyz`.
 * Including either verbatim in a thrown Error or log entry leaks the
 * credential to wherever those are collected (log files, error-tracking
 * services, stdout captured by an orchestrator), which is frequently a
 * different trust boundary from whoever holds the credential.
 *
 * The same connection-string credential can also arrive as a query
 * parameter rather than userinfo, for example
 * `postgres://user@host/db?password=secret`, which several drivers accept
 * and which reaches the same error paths. All forms above are masked.
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
