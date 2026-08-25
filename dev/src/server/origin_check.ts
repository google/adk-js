/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger} from '@google/adk';
import {NextFunction, Request, RequestHandler, Response} from 'express';
import * as http from 'node:http';

/** Methods that cannot change server state and are therefore not origin-checked. */
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Canonicalizes an `--allow_origins` entry to its origin form, so the gate and
 * `cors()` compare it against the browser's `Origin` consistently. A browser
 * sends `http://localhost:4200`, never the `http://localhost:4200/` a user may
 * type, so a raw string comparison silently never matches. The `*` wildcard and
 * any non-URL entry pass through unchanged.
 */
export function normalizeOrigin(origin: string): string {
  if (origin === '*') {
    return origin;
  }
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
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
      `${reason}: ${req.method} ${req.originalUrl} (host: ${req.headers.host}, origin: ${req.headers.origin})`,
    );
    res.status(403).type('text/plain').send(reason);
  };
}
