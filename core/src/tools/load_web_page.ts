/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

import {z} from 'zod';

import {FunctionTool} from './function_tool.js';

/** Options for {@link loadWebPage}. */
export interface LoadWebPageOptions {
  /** Request timeout in milliseconds. Defaults to 30_000 (30s). */
  timeoutMs?: number;
}

/** URL schemes that are allowed to be fetched (WHATWG `URL.protocol` form). */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * IPv4 ranges that are not globally routable and therefore blocked to defeat
 * SSRF. Mirrors the non-global ranges rejected by Python's
 * `ipaddress.is_global`.
 */
const BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8', // "this host on this network"
  '10.0.0.0/8', // private
  '100.64.0.0/10', // shared address space / CGNAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local (includes GCP metadata 169.254.169.254)
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1 (documentation)
  '192.88.99.0/24', // 6to4 relay anycast (deprecated)
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // TEST-NET-2 (documentation)
  '203.0.113.0/24', // TEST-NET-3 (documentation)
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved / future use (includes 255.255.255.255)
].map(parseIpv4Cidr);

/**
 * IPv6 ranges that are not globally routable and therefore blocked. The
 * IPv4-mapped range `::ffff:0:0/96` is handled separately by extracting the
 * embedded IPv4 address and re-checking it with the IPv4 rules.
 */
const BLOCKED_IPV6_CIDRS = [
  '::/128', // unspecified
  '::1/128', // loopback
  '64:ff9b:1::/48', // local NAT64
  '100::/64', // discard-only
  '2001:db8::/32', // documentation
  'fc00::/7', // unique-local (ULA, private)
  'fe80::/10', // link-local
  'ff00::/8', // multicast
].map(parseIpv6Cidr);

/** Builds the parity failure message for a URL. */
function failedToFetchMessage(url: string): string {
  return `Failed to fetch url: ${url}`;
}

/**
 * Returns `true` for `localhost` and any `*.localhost` name (case-insensitive,
 * ignoring a trailing dot), matching the Python `_is_blocked_hostname` helper.
 */
function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.replace(/\.+$/, '').toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost');
}

/** Strips the surrounding brackets from an IPv6 URL hostname (`[::1]` → `::1`). */
function normalizeHost(hostname: string): string {
  return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
}

/** Parses a dotted-quad IPv4 string into its four octets, or `null`. */
function parseIpv4(address: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) {
    return null;
  }
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return null;
  }
  return octets;
}

/** Expands a valid IPv6 address string into its eight 16-bit hextets, or `null`. */
function parseIpv6(address: string): number[] | null {
  if (isIP(address) !== 6) {
    return null;
  }
  const [head, tail] = address.split('::');
  const highGroups = head ? expandHextets(head) : [];
  const lowGroups = tail ? expandHextets(tail) : [];
  const compressed = address.includes('::')
    ? new Array(8 - highGroups.length - lowGroups.length).fill(0)
    : [];
  return [...highGroups, ...compressed, ...lowGroups];
}

/**
 * Converts a colon-separated IPv6 fragment into hextets, expanding a trailing
 * embedded IPv4 group (e.g. the `1.2.3.4` in `::ffff:1.2.3.4`) into two hextets.
 */
function expandHextets(fragment: string): number[] {
  const hextets: number[] = [];
  for (const group of fragment.split(':')) {
    if (group.includes('.')) {
      const octets = parseIpv4(group)!;
      hextets.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    } else {
      hextets.push(parseInt(group, 16));
    }
  }
  return hextets;
}

/** Packs four IPv4 octets into an unsigned 32-bit integer. */
function ipv4ToInt(octets: number[]): number {
  return (
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  );
}

/** Packs eight IPv6 hextets into a 128-bit BigInt. */
function hextetsToBigInt(hextets: number[]): bigint {
  let value = 0n;
  for (const hextet of hextets) {
    value = (value << 16n) | BigInt(hextet);
  }
  return value;
}

/** Precomputes the network address and mask for an IPv4 CIDR string. */
function parseIpv4Cidr(cidr: string): {base: number; mask: number} {
  const [address, prefix] = cidr.split('/');
  const mask = (0xffffffff << (32 - Number(prefix))) >>> 0;
  return {base: (ipv4ToInt(parseIpv4(address)!) & mask) >>> 0, mask};
}

/** Precomputes the network address and prefix length for an IPv6 CIDR string. */
function parseIpv6Cidr(cidr: string): {base: bigint; prefix: number} {
  const [address, prefix] = cidr.split('/');
  return {base: hextetsToBigInt(parseIpv6(address)!), prefix: Number(prefix)};
}

/** Returns `true` if the IPv4 octets fall within any blocked range. */
function isBlockedIpv4(octets: number[]): boolean {
  const value = ipv4ToInt(octets);
  return BLOCKED_IPV4_CIDRS.some(
    ({base, mask}) => (value & mask) >>> 0 === base,
  );
}

/** Returns `true` if the IPv6 hextets fall within any blocked range. */
function isBlockedIpv6(hextets: number[]): boolean {
  const value = hextetsToBigInt(hextets);
  // IPv4-mapped (::ffff:0:0/96): re-check the embedded IPv4 address.
  if (value >> 32n === 0xffffn) {
    return isBlockedIpv4([
      Number((value >> 24n) & 0xffn),
      Number((value >> 16n) & 0xffn),
      Number((value >> 8n) & 0xffn),
      Number(value & 0xffn),
    ]);
  }
  return BLOCKED_IPV6_CIDRS.some(
    ({base, prefix}) =>
      value >> BigInt(128 - prefix) === base >> BigInt(128 - prefix),
  );
}

/**
 * Returns `true` when `address` is not globally routable (private, loopback,
 * link-local, shared, reserved, multicast, ...). Unparseable input fails
 * closed (blocked).
 */
function isBlockedAddress(address: string): boolean {
  const octets = parseIpv4(address);
  if (octets) {
    return isBlockedIpv4(octets);
  }
  const hextets = parseIpv6(address);
  if (hextets) {
    return isBlockedIpv6(hextets);
  }
  return true;
}

/**
 * Resolves `hostname` to a de-duplicated list of IP addresses. IP literals are
 * returned as-is; hostnames are resolved via DNS. Throws when resolution
 * yields no address.
 */
async function resolveHostAddresses(hostname: string): Promise<string[]> {
  if (isIP(hostname) !== 0) {
    return [hostname];
  }
  const records = await lookup(hostname, {all: true});
  const addresses = [...new Set(records.map((record) => record.address))];
  if (addresses.length === 0) {
    throw new Error(`Unable to resolve host: ${hostname}`);
  }
  return addresses;
}

/**
 * Validates the URL's scheme and hostname up front (before any network access).
 * Throws for malformed URLs, disallowed schemes, and blocked hostnames.
 */
function assertUrlAllowed(url: string): URL {
  const parsed = new URL(url);
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Unsupported url scheme: ${url}`);
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error(`Blocked host: ${parsed.hostname}`);
  }
  return parsed;
}

/** Resolves the host and throws if any resolved address is not globally routable. */
async function validateResolvedAddresses(hostname: string): Promise<void> {
  const addresses = await resolveHostAddresses(hostname);
  if (addresses.some(isBlockedAddress)) {
    throw new Error(`Blocked host: ${hostname}`);
  }
}

/** Decodes the small set of HTML entities that survive tag stripping. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Extracts readable text from an HTML document. Removes `<script>`/`<style>`
 * blocks and comments, strips remaining tags, decodes common entities, and
 * keeps only lines with more than three words (parity with the Python tool).
 */
function htmlToText(html: string): string {
  const withoutCode = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = decodeHtmlEntities(withoutCode.replace(/<[^>]+>/g, '\n'));
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.split(/\s+/).filter(Boolean).length > 3)
    .join('\n');
}

/**
 * Fetches the content at `url` and returns its extracted, readable text.
 *
 * Hardened against SSRF: only `http`/`https` URLs are fetched, the host is
 * resolved and rejected up front if it is `localhost`-style or resolves to a
 * private / loopback / link-local / shared / reserved / multicast address, and
 * redirects are never followed. Never throws for expected failures (bad scheme,
 * blocked host, non-200, timeout, network error); returns
 * `Failed to fetch url: <url>` instead.
 *
 * Known limitation: global `fetch` performs its own DNS resolution at connect
 * time, so a residual time-of-check/time-of-use (DNS-rebinding) window exists
 * between this pre-flight lookup and fetch's own lookup. Full connection
 * IP-pinning (e.g. an `undici` Agent with a custom `lookup`) is a possible
 * future hardening.
 */
export async function loadWebPage(
  url: string,
  options?: LoadWebPageOptions,
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const parsed = assertUrlAllowed(url);
    await validateResolvedAddresses(normalizeHost(parsed.hostname));
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      return failedToFetchMessage(url);
    }
    return htmlToText(await response.text());
  } catch {
    return failedToFetchMessage(url);
  }
}

/** A global {@link FunctionTool} exposing {@link loadWebPage} to the model. */
export const LOAD_WEB_PAGE = new FunctionTool({
  name: 'load_web_page',
  description:
    'Fetches the content at the given URL and returns the readable text extracted from the page.',
  parameters: z.object({
    url: z.string().describe('The URL to fetch and extract text from.'),
  }),
  execute: ({url}) => loadWebPage(url),
});
