/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Redacts the password from a connection URI so the URI can be safely included
 * in error messages and logs.
 *
 * A database or session-service connection URI such as
 * `postgres://user:password@host:5432/db` embeds the password in its userinfo
 * component. Including such a URI verbatim in a thrown Error or log entry leaks
 * the credential to wherever those are collected (log files, error-tracking
 * services, stdout captured by an orchestrator), which is frequently a
 * different trust boundary from whoever provisioned the connection string.
 *
 * This masks the password while keeping the rest of the URI intact for
 * debugging, mirroring the semantics of Go's `net/url.URL.Redacted()`.
 *
 * If the input cannot be parsed as a URL, only its scheme prefix is returned so
 * that a credential embedded in an otherwise-unparseable string is not leaked.
 */
export function redactUriPassword(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.password) {
      url.password = '***';
      return url.toString();
    }
    return uri;
  } catch {
    const schemeEnd = uri.indexOf('://');
    return schemeEnd === -1 ? '<redacted>' : `${uri.slice(0, schemeEnd)}://<redacted>`;
  }
}
