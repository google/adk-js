/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger} from '@google/adk';
import {NextFunction, Request, RequestHandler, Response} from 'express';
import * as http from 'node:http';

import {formatHeaderForLog} from '../utils/log_utils.js';

/** Methods that cannot change server state and are therefore not origin-checked. */
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Canonicalizes an `--allow_origins` entry to its origin form, so the gate and
 * `cors()` compare it against the browser's `Origin` consistently. A browser
 * sends `http://localhost:4200`, never the `http://localhost:4200/` a user may
 * type, so a raw string comparison silently never matches. The `*` wildcard is
 * returned unchanged.
 *
 * Returns `null` for anything that is not an `http:`/`https:` URL. A scheme-less
 * entry like `localhost:4200` parses to the opaque origin `"null"`, so accepting
 * it would put the literal string `"null"` on the allowlist and grant every
 * opaque origin: sandboxed iframes, `data:`/`file:` documents, and
 * cross-origin-redirected requests all send `Origin: null`.
 */
export function normalizeOrigin(origin: string): string | null {
  if (origin === '*') {
    return origin;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  return url.origin;
}

/**
 * Parses a raw `--allow_origins` value into the origins the gate enforces and
 * the entries dropped as invalid. The value is a comma-separated list because a
 * browser sends one `Origin` per request, so `cors()` never matches the joined
 * string and the DNS-rebinding guard reads only its first host from it. Each
 * entry is canonicalized by {@link normalizeOrigin}; an entry that is neither
 * `*` nor an `http:`/`https:` URL is dropped, so a scheme-less typo cannot reach
 * the allowlist. The caller warns on each dropped entry so the typo surfaces at
 * startup.
 */
export function parseAllowedOrigins(raw: string | undefined): {
  origins: string[];
  rejected: string[];
} {
  const origins: string[] = [];
  const rejected: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const normalized = normalizeOrigin(trimmed);
    if (normalized === null) {
      rejected.push(trimmed);
    } else {
      origins.push(normalized);
    }
  }
  return {origins, rejected};
}

/**
 * Returns true if the `Origin` header is allowed: it is on the allowlist, the
 * allowlist is the `*` wildcard, or it is same-origin with the request's `Host`.
 *
 * Same-origin compares authorities, not full URLs. A TLS-terminating front end
 * (Cloud Run, ngrok, Codespaces) serves the UI over https while the container
 * sees a plain-http `Host`, so the scheme differs but the host is identical. The
 * browser cannot forge `Host`, so a matching authority is a real same-origin
 * request. Forwarding headers stay ignored, as `X-Forwarded-Host` is
 * attacker-controlled.
 */
export function isRequestOriginAllowed(
  origin: string,
  headers: http.IncomingHttpHeaders,
  allowedOrigins: string[],
): boolean {
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
    return true;
  }
  if (headers.host === undefined) {
    return false;
  }
  try {
    return new URL(origin).host === headers.host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Express middleware rejecting cross-origin state-changing requests. This gate
 * covers the `Origin` header only; the `Host` header defence against DNS
 * rebinding lives in `dns_rebinding_guard.ts` and runs on every request.
 *
 * A request without an `Origin` (curl, the ADK CLI) is not cross-origin, so it
 * passes here and is covered by the Host guard instead.
 */
export function createOriginCheckMiddleware(
  allowedOrigins: string[],
  logger: Logger,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (
      SAFE_HTTP_METHODS.has(req.method) ||
      origin === undefined ||
      isRequestOriginAllowed(origin, req.headers, allowedOrigins)
    ) {
      return next();
    }
    const reason = 'Forbidden: origin not allowed';
    logger.warn(
      `${reason}: ${req.method} ${formatHeaderForLog(req.originalUrl)} ` +
        `(host: ${formatHeaderForLog(req.headers.host)}, origin: ` +
        `${formatHeaderForLog(req.headers.origin)})`,
    );
    res.status(403).type('text/plain').send(reason);
  };
}
