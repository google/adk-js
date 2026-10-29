/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Address and scheme predicates shared by the outbound fetches that must not be
 * pointed at an internal target.
 *
 * These are lexical and DNS-level checks, not a sandbox. Global `fetch`
 * performs its own DNS resolution at connect time, so a residual
 * time-of-check/time-of-use (DNS-rebinding) window exists between a caller's
 * pre-flight lookup and fetch's own lookup. Closing it needs connection-level
 * IP pinning (e.g. an `undici` Agent with a custom `lookup`).
 *
 * The module has no static Node.js imports, so the browser bundle can use the
 * lexical and address checks. Only {@link resolveHostAddresses} needs Node.js,
 * and it loads `node:dns/promises` when it is called.
 */

/**
 * The DNS module specifier. It is kept in a variable so that a bundler that
 * targets a browser does not try to resolve a Node.js built-in.
 */
const DNS_MODULE = 'node:dns/promises';

/** Characters that can appear in an IPv6 address literal. */
const IPV6_CHARACTERS = /^[0-9a-f:.]+$/i;

/** URL schemes that may be fetched (WHATWG `URL.protocol` form). */
const HTTP_SCHEMES = new Set(['http:', 'https:']);

/** An IPv4 network: its base address and mask, both unsigned 32-bit. */
interface Ipv4Cidr {
  base: number;
  mask: number;
}

/** An IPv6 network: its base address as eight hextets and its prefix length. */
interface Ipv6Cidr {
  base: number[];
  prefix: number;
}

/**
 * IPv4 ranges that are not globally routable. Mirrors the non-global ranges
 * rejected by Python's `ipaddress.is_global`.
 */
const NON_GLOBAL_IPV4_CIDRS = [
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
 * IPv6 ranges that are not globally routable. Addresses that embed an IPv4
 * target are handled separately by {@link embeddedIpv4}.
 */
const NON_GLOBAL_IPV6_CIDRS = [
  '::/128', // unspecified
  '::1/128', // loopback
  '64:ff9b:1::/48', // local NAT64
  '100::/64', // discard-only
  '2001:db8::/32', // documentation
  'fc00::/7', // unique-local (ULA, private)
  'fe80::/10', // link-local
  'ff00::/8', // multicast
].map(parseIpv6Cidr);

const LINK_LOCAL_IPV4_CIDR = parseIpv4Cidr('169.254.0.0/16');
const LINK_LOCAL_IPV6_CIDR = parseIpv6Cidr('fe80::/10');
const IPV4_MAPPED_CIDR = parseIpv6Cidr('::ffff:0:0/96');
const NAT64_CIDR = parseIpv6Cidr('64:ff9b::/96');
const SIX_TO_FOUR_CIDR = parseIpv6Cidr('2002::/16');
const IPV4_COMPATIBLE_CIDR = parseIpv6Cidr('::/96');

/** Returns `true` when `url` uses a scheme that may be fetched. */
export function isHttpUrl(url: URL): boolean {
  return HTTP_SCHEMES.has(url.protocol);
}

/**
 * Returns `true` for `localhost` and any `*.localhost` name (case-insensitive,
 * ignoring a trailing dot), matching Python's `_is_blocked_hostname` helper.
 */
export function isLocalhostHostname(hostname: string): boolean {
  const normalized = hostname.replace(/\.+$/, '').toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost');
}

/** Strips the surrounding brackets from an IPv6 URL hostname (`[::1]` → `::1`). */
export function normalizeHost(hostname: string): string {
  return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
}

/**
 * Returns `true` when `address` is not globally routable (private, loopback,
 * link-local, shared, reserved, multicast, ...). Unparseable input fails closed
 * (blocked).
 */
export function isNonGlobalAddress(address: string): boolean {
  return classifyAddress(address, isNonGlobalIpv4, isNonGlobalIpv6);
}

/**
 * Returns `true` when `address` is link-local: IPv4 `169.254.0.0/16` (which
 * holds the cloud metadata endpoint), IPv6 `fe80::/10`, or an IPv6 address that
 * embeds a link-local IPv4. Unparseable input fails closed (blocked).
 */
export function isLinkLocalAddress(address: string): boolean {
  return classifyAddress(address, isLinkLocalIpv4, isLinkLocalIpv6);
}

/** Returns `true` when `address` is an IPv4 or IPv6 literal (without brackets). */
export function isIpAddress(address: string): boolean {
  return parseIpv4(address) !== null || isIpv6Literal(address);
}

/**
 * Resolves `hostname` to a de-duplicated list of IP addresses. IP literals are
 * returned as-is; hostnames are resolved via DNS. Throws when resolution yields
 * no address.
 */
export async function resolveHostAddresses(
  hostname: string,
): Promise<string[]> {
  if (isIpAddress(hostname)) {
    return [hostname];
  }
  // A non-literal specifier types the module as `any`; the cast restores it.
  const {lookup} = (await import(
    DNS_MODULE
  )) as typeof import('node:dns/promises');
  const records = await lookup(hostname, {all: true});
  const addresses = [...new Set(records.map((record) => record.address))];
  if (addresses.length === 0) {
    throw new Error(`Unable to resolve host: ${hostname}`);
  }
  return addresses;
}

/**
 * Applies the matching family predicate to `address`, failing closed when the
 * address parses as neither IPv4 nor IPv6.
 */
function classifyAddress(
  address: string,
  matchesIpv4: (octets: number[]) => boolean,
  matchesIpv6: (hextets: number[]) => boolean,
): boolean {
  const octets = parseIpv4(address);
  if (octets) {
    return matchesIpv4(octets);
  }
  const hextets = parseIpv6(address);
  if (hextets) {
    return matchesIpv6(hextets);
  }
  return true;
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

/**
 * Returns `true` when `address` is a valid IPv6 literal without brackets.
 *
 * The WHATWG URL parser validates the address, so the check works the same in
 * Node.js and in a browser. The character check runs first, so `address`
 * cannot end the bracketed host and smuggle in a path.
 */
function isIpv6Literal(address: string): boolean {
  if (!address.includes(':') || !IPV6_CHARACTERS.test(address)) {
    return false;
  }
  try {
    new URL(`http://[${address}]/`);
    return true;
  } catch {
    return false;
  }
}

/** Expands a valid IPv6 address string into its eight 16-bit hextets, or `null`. */
function parseIpv6(address: string): number[] | null {
  if (!isIpv6Literal(address)) {
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

/** Precomputes the network address and mask for an IPv4 CIDR string. */
function parseIpv4Cidr(cidr: string): Ipv4Cidr {
  const [address, prefix] = cidr.split('/');
  const mask = (0xffffffff << (32 - Number(prefix))) >>> 0;
  return {base: (ipv4ToInt(parseIpv4(address)!) & mask) >>> 0, mask};
}

/** Precomputes the network address and prefix length for an IPv6 CIDR string. */
function parseIpv6Cidr(cidr: string): Ipv6Cidr {
  const [address, prefix] = cidr.split('/');
  return {base: parseIpv6(address)!, prefix: Number(prefix)};
}

/** Returns `true` when the IPv4 octets fall inside the network. */
function matchesIpv4Cidr(octets: number[], {base, mask}: Ipv4Cidr): boolean {
  return (ipv4ToInt(octets) & mask) >>> 0 === base;
}

/**
 * Returns `true` when the IPv6 hextets fall inside the network. The prefix is
 * compared one 16-bit hextet at a time, so the check needs no `BigInt`, which
 * the browser build targets do not all support.
 */
function matchesIpv6Cidr(hextets: number[], {base, prefix}: Ipv6Cidr): boolean {
  for (let i = 0; i < base.length; i++) {
    const bits = Math.min(16, prefix - i * 16);
    if (bits <= 0) {
      return true;
    }
    const mask = (0xffff << (16 - bits)) & 0xffff;
    if ((hextets[i] & mask) !== (base[i] & mask)) {
      return false;
    }
  }
  return true;
}

/**
 * Returns the IPv4 address embedded in an IPv6 address as four octets, or
 * `null` when it embeds none.
 *
 * An IPv6 range check alone does not reflect where such an address actually
 * routes: `64:ff9b::169.254.169.254` is a global IPv6 address, but on a network
 * with NAT64 it reaches the internal `169.254.169.254` metadata endpoint. The
 * caller vets the embedded IPv4 instead. Mirrors Python's `_embedded_ipv4`.
 */
function embeddedIpv4(hextets: number[]): number[] | null {
  if (matchesIpv6Cidr(hextets, SIX_TO_FOUR_CIDR)) {
    return hextetsToOctets(hextets[1], hextets[2]);
  }
  if (
    matchesIpv6Cidr(hextets, IPV4_MAPPED_CIDR) ||
    matchesIpv6Cidr(hextets, NAT64_CIDR)
  ) {
    return hextetsToOctets(hextets[6], hextets[7]);
  }
  // IPv4-compatible `::a.b.c.d` (deprecated), excluding `::` and `::1`.
  if (
    matchesIpv6Cidr(hextets, IPV4_COMPATIBLE_CIDR) &&
    (hextets[6] !== 0 || hextets[7] > 1)
  ) {
    return hextetsToOctets(hextets[6], hextets[7]);
  }
  return null;
}

/** Splits the two low hextets of an embedded IPv4 address into four octets. */
function hextetsToOctets(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** Returns `true` if the IPv4 octets fall within any non-global range. */
function isNonGlobalIpv4(octets: number[]): boolean {
  return NON_GLOBAL_IPV4_CIDRS.some((cidr) => matchesIpv4Cidr(octets, cidr));
}

/** Returns `true` if the IPv6 hextets fall within any non-global range. */
function isNonGlobalIpv6(hextets: number[]): boolean {
  const embedded = embeddedIpv4(hextets);
  if (embedded) {
    return isNonGlobalIpv4(embedded);
  }
  return NON_GLOBAL_IPV6_CIDRS.some((cidr) => matchesIpv6Cidr(hextets, cidr));
}

/** Returns `true` if the IPv4 octets are link-local. */
function isLinkLocalIpv4(octets: number[]): boolean {
  return matchesIpv4Cidr(octets, LINK_LOCAL_IPV4_CIDR);
}

/** Returns `true` if the IPv6 hextets are, or embed, a link-local address. */
function isLinkLocalIpv6(hextets: number[]): boolean {
  const embedded = embeddedIpv4(hextets);
  if (embedded) {
    return isLinkLocalIpv4(embedded);
  }
  return matchesIpv6Cidr(hextets, LINK_LOCAL_IPV6_CIDR);
}
