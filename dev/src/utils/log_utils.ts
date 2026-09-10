/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Longest header value written to a log line before it is truncated. */
const MAX_LOGGED_HEADER_LENGTH = 128;

/**
 * Formats an untrusted request header value for a log line. The value is
 * coerced to a string, capped at {@link MAX_LOGGED_HEADER_LENGTH} characters,
 * and quoted with `JSON.stringify` so an injected newline or control character
 * cannot forge a second log line. The Host guard and the Origin gate both log
 * through this, so a rejected request reads the same wherever it is refused.
 */
export function formatHeaderForLog(value: unknown): string {
  return JSON.stringify(String(value).slice(0, MAX_LOGGED_HEADER_LENGTH));
}
