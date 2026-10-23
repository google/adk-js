/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface UrlParts {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
}

/** Python `len`: a string's length in code points, not UTF-16 units. */
function codePointLength(text: string): number {
  let count = 0;
  for (const char of text) {
    count += char.length > 0 ? 1 : 0;
  }
  return count;
}

/** Python `text[:limit]` in code points. */
export function sliceCodePoints(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  let end = 0;
  let count = 0;
  for (const char of text) {
    if (count === limit) {
      break;
    }
    end += char.length;
    count += 1;
  }
  return text.slice(0, end);
}

export function exceedsCodePoints(text: string, maxLength: number): boolean {
  return (
    maxLength !== -1 &&
    text.length > maxLength &&
    codePointLength(text) > maxLength
  );
}

const ALWAYS_SAFE_URL_CHAR = /[A-Za-z0-9_.~-]/;

/** Python `quote(safe="")`, or `quote_plus(safe="")` with `plusForSpace`. */
export function percentEncode(text: string, plusForSpace: boolean): string {
  return [...Buffer.from(text, 'utf8')]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      if (ALWAYS_SAFE_URL_CHAR.test(char)) {
        return char;
      }
      if (plusForSpace && byte === 0x20) {
        return '+';
      }
      return `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

/** Python `unquote_plus` with `errors="replace"`. */
function unquotePlus(text: string): string {
  const spaced = text.replaceAll('+', ' ');
  const bytes: Array<number> = [];
  for (let index = 0; index < spaced.length; index += 1) {
    const hex = spaced.slice(index + 1, index + 3);
    if (spaced[index] === '%' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(spaced.charAt(index), 'utf8'));
    }
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*$/;
// urlsplit strips leading C0 controls and spaces.
// eslint-disable-next-line no-control-regex
const LEADING_CONTROL_CHARS = /^[\u0000- ]+/;

/**
 * Python `urllib.parse.urlsplit`, including its control-character stripping and
 * bracket validation.
 */
export function urlSplit(rawUrl: string): UrlParts {
  const url = rawUrl
    .replace(LEADING_CONTROL_CHARS, '')
    .replaceAll(/[\t\r\n]/g, '');
  let rest = url;
  let scheme = '';
  const colon = rest.indexOf(':');
  if (colon > 0 && SCHEME_PATTERN.test(rest.slice(0, colon))) {
    scheme = rest.slice(0, colon).toLowerCase();
    rest = rest.slice(colon + 1);
  }
  let netloc = '';
  if (rest.startsWith('//')) {
    const afterSlashes = rest.slice(2);
    const end = afterSlashes.search(/[/?#]/);
    netloc = end === -1 ? afterSlashes : afterSlashes.slice(0, end);
    rest = end === -1 ? '' : afterSlashes.slice(end);
    if (netloc.includes('[') !== netloc.includes(']')) {
      throw new RangeError('Invalid IPv6 URL');
    }
  }
  const hash = rest.indexOf('#');
  const fragment = hash === -1 ? '' : rest.slice(hash + 1);
  rest = hash === -1 ? rest : rest.slice(0, hash);
  const question = rest.indexOf('?');
  return {
    scheme,
    netloc,
    path: question === -1 ? rest : rest.slice(0, question),
    query: question === -1 ? '' : rest.slice(question + 1),
    fragment,
  };
}

/** Python `parse_qsl(keep_blank_values=True)`. */
export function parseQueryPairs(query: string): Array<[string, string]> {
  return query
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair): [string, string] => {
      const equals = pair.indexOf('=');
      return equals === -1
        ? [unquotePlus(pair), '']
        : [
            unquotePlus(pair.slice(0, equals)),
            unquotePlus(pair.slice(equals + 1)),
          ];
    });
}

export function urlUnsplit({
  scheme,
  netloc,
  path,
  query,
  fragment,
}: UrlParts): string {
  let url = path;
  if (netloc !== '' || (scheme !== '' && url.startsWith('//'))) {
    url = `//${netloc}${url !== '' && !url.startsWith('/') ? '/' : ''}${url}`;
  }
  if (scheme !== '') {
    url = `${scheme}:${url}`;
  }
  if (query !== '') {
    url = `${url}?${query}`;
  }
  if (fragment !== '') {
    url = `${url}#${fragment}`;
  }
  return url;
}
