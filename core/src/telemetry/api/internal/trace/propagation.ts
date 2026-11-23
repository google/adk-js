/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {TextMapGetter} from '@opentelemetry/api';

/** Incoming request headers, such as Node's `IncomingMessage.headers`. */
export type IncomingHeaders = Readonly<
  Record<string, string | string[] | undefined>
>;

/**
 * Reads incoming request headers for the propagator, matching names
 * case-insensitively. An array value is returned as is; the W3C propagator
 * reads its first element.
 */
export const INCOMING_HEADERS_GETTER: TextMapGetter<IncomingHeaders> =
  Object.freeze({
    keys: (carrier: IncomingHeaders): string[] => Object.keys(carrier),
    get(carrier: IncomingHeaders, key: string): string | string[] | undefined {
      const name = key.toLowerCase();
      for (const [headerName, value] of Object.entries(carrier)) {
        if (headerName.toLowerCase() === name) {
          return value;
        }
      }
      return undefined;
    },
  });

/**
 * Returns the headers a `fetch(input, init)` call sends, with each injected
 * header added unless the call already sets it.
 *
 * As in `fetch`, `init.headers` replaces the headers of a `Request` input
 * when given, and the `Request` headers are kept otherwise.
 */
export function addMissingHeaders(
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
  injected: Readonly<Record<string, string>>,
): Headers {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const headers = new Headers(
    init?.headers ?? (isRequest ? input.headers : undefined),
  );
  for (const [name, value] of Object.entries(injected)) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }
  return headers;
}
