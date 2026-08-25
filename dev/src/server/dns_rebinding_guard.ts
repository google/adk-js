/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DNS-rebinding guard for the dev server (adk web / api_server).
 *
 * A page reached by rebinding an attacker-controlled hostname to 127.0.0.1
 * is same-origin as far as the browser is concerned, so it omits Origin --
 * meaning read endpoints (GET /list-apps, /version, etc.) are reachable from
 * any external page a developer running the dev server happens to visit,
 * with no explicit configuration required to be vulnerable. Origin cannot
 * be relied on to catch this; the guard keys off Host instead, on every
 * method including GET, applied as the very first middleware before any
 * route.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost']);

/** Returns *host* without its port, or unchanged if it has no valid one. */
function stripPort(host: string): string {
  // A malformed authority must come back whole, so callers never read
  // "127.0.0.1:8000.evil.com" as loopback.
  if (host.startsWith('[')) {
    // [addr] or [addr]:port
    const closeBracket = host.indexOf(']');
    if (closeBracket === -1) {
      return host;
    }
    const bare = host.slice(1, closeBracket);
    const suffix = host.slice(closeBracket + 1);
    if (suffix && !/^:\d+$/.test(suffix)) {
      return host;
    }
    return bare;
  }
  const colonCount = (host.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    // host:port; bracketless IPv6 has more colons.
    const colonIndex = host.indexOf(':');
    if (!/^\d+$/.test(host.slice(colonIndex + 1))) {
      return host;
    }
    return host.slice(0, colonIndex);
  }
  return host;
}

/**
 * Returns true if *host* (with or without a port) refers to a loopback
 * address: 127.0.0.0/8, ::1, or "localhost".
 */
export function isLoopbackAddress(host: string): boolean {
  // Host names are case-insensitive and may carry a root dot ("localhost.").
  const bare = stripPort(host).toLowerCase().replace(/\.$/, '');
  if (LOOPBACK_HOSTNAMES.has(bare)) {
    return true;
  }
  if (bare === '::1') {
    return true;
  }
  const ipv4Match = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match && ipv4Match.slice(1).every((octet) => Number(octet) <= 255)) {
    return ipv4Match[1] === '127';
  }
  return false;
}

/**
 * Returns the hosts the DNS-rebinding guard accepts besides loopback, or
 * `null` if every host should be accepted (guard disabled).
 *
 * A loopback bind behind a same-machine proxy sees the proxy's hostname in
 * Host, so an operator naming an origin in --allow_origins vouches for that
 * origin's host, and *extraAllowedHosts* (ServerOptions.allowedHosts /
 * --allowed_hosts) vouches for any host explicitly listed there -- the
 * latter exists so an embedder behind a proxy can widen the guard without
 * having to open CORS to every origin on the internet just to get a Host
 * header through. Only "*" in allowOrigins opts out of the guard entirely.
 */
export function getAllowedRequestHosts(
  allowOrigins: string | undefined,
  extraAllowedHosts?: readonly string[],
): Set<string> | null {
  const origin = (allowOrigins ?? '').trim();
  if (origin === '*') {
    return null;
  }
  const hosts = new Set<string>();
  if (origin) {
    try {
      const host = new URL(origin).hostname;
      if (host) {
        hosts.add(host.toLowerCase());
      }
    } catch {
      // A malformed origin vouches for no host.
    }
  }
  for (const rawHost of extraAllowedHosts ?? []) {
    const host = rawHost.trim().toLowerCase();
    if (host) {
      hosts.add(host);
    }
  }
  return hosts;
}

/**
 * Returns true if *req* must be rejected as a possible DNS-rebinding
 * attempt: the server is bound to loopback, and the request's Host header
 * names neither loopback nor an operator-configured origin's host.
 *
 * Origin cannot catch this: browsers omit it on requests they consider
 * same-origin, as a DNS-rebound page's requests are, so this must be
 * applied to every request, safe methods (GET/HEAD/OPTIONS) included.
 */
export function isDnsRebindingRequest(
  hostHeaderValue: string | undefined,
  bindHost: string | undefined,
  allowedRequestHosts: Set<string> | null,
): boolean {
  if (allowedRequestHosts === null || bindHost === undefined) {
    return false;
  }
  if (!isLoopbackAddress(bindHost)) {
    return false;
  }
  if (hostHeaderValue === undefined) {
    // Browsers always send Host, so its absence is not a rebinding vector.
    return false;
  }
  if (hostHeaderValue.includes(',')) {
    // Node joins duplicate headers with a comma; Host is a singleton
    // header, so more than one value is smuggling, not a client.
    return true;
  }
  if (isLoopbackAddress(hostHeaderValue)) {
    return false;
  }
  const bareHost = stripPort(hostHeaderValue).toLowerCase().replace(/\.$/, '');
  return !allowedRequestHosts.has(bareHost);
}
