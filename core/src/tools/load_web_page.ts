/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {
  isHttpUrl,
  isLocalhostHostname,
  isNonGlobalAddress,
  normalizeHost,
  resolveHostAddresses,
} from '../utils/ssrf_guard.js';
import {FunctionTool} from './function_tool.js';

/** Options for {@link loadWebPage}. */
export interface LoadWebPageOptions {
  /** Request timeout in milliseconds. Defaults to 30_000 (30s). */
  timeoutMs?: number;
}

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Builds the single failure message returned for every unsuccessful fetch, so
 * the caller cannot tell which check rejected the URL.
 */
function failedToFetchMessage(url: string): string {
  return `Failed to fetch url: ${url}`;
}

/**
 * Validates the URL's scheme and hostname up front (before any network access).
 * Throws for malformed URLs, disallowed schemes, and blocked hostnames.
 */
function assertUrlAllowed(url: string): URL {
  const parsed = new URL(url);
  if (!isHttpUrl(parsed)) {
    throw new Error(`Unsupported url scheme: ${url}`);
  }
  if (isLocalhostHostname(parsed.hostname)) {
    throw new Error(`Blocked host: ${parsed.hostname}`);
  }
  return parsed;
}

/** Resolves the host and throws if any resolved address is not globally routable. */
async function validateResolvedAddresses(hostname: string): Promise<void> {
  const addresses = await resolveHostAddresses(hostname);
  if (addresses.some(isNonGlobalAddress)) {
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
 * keeps only lines with more than three words.
 */
/**
 * A letter of a script written without spaces between words: Thai and Lao,
 * Myanmar, Khmer, Hiragana and Katakana (including half-width), and the CJK
 * ideographs (including the supplementary planes). Captured so `split` keeps
 * the letters at the odd indexes.
 */
const UNSPACED_LETTER =
  /((?=\p{L})[฀-໿က-႟ក-៿぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ\u{20000}-\u{3FFFF}])/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Counts the words in a line of page text.
 *
 * Words are separated by whitespace. In a script written without spaces, such
 * as Chinese, Japanese or Thai, each letter counts as a word, and the runs of
 * other characters around those letters count only if they hold a letter or a
 * digit, so that a full stop such as "。" is not counted as a word.
 */
function countWords(line: string): number {
  let count = 0;
  for (const token of line.split(/\s+/).filter(Boolean)) {
    if (!UNSPACED_LETTER.test(token)) {
      count++;
      continue;
    }
    token.split(UNSPACED_LETTER).forEach((part, index) => {
      if (index % 2 === 1 || LETTER_OR_DIGIT.test(part)) {
        count++;
      }
    });
  }
  return count;
}

function htmlToText(html: string): string {
  const withoutCode = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = decodeHtmlEntities(withoutCode.replace(/<[^>]+>/g, '\n'));
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => countWords(line) > 3)
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
