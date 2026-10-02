/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AsyncLocalStorage} from 'node:async_hooks';
import {version} from '../version.js';
import {isBrowser} from './env_aware_utils.js';

const ADK_LABEL = 'google-adk';
const LANGUAGE_LABEL = 'gl-typescript';
const AGENT_ENGINE_TELEMETRY_TAG = 'remote_reasoning_engine';
const AGENT_ENGINE_TELEMETRY_ENV_VARIABLE_NAME = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';
const TRACKING_HEADER_NAMES = ['x-goog-api-client', 'user-agent'] as const;

/**
 * The header shapes that `fetch` accepts. This matches the DOM library's
 * `HeadersInit`, which is not used by name because the lint configuration
 * defines only Node globals and its `no-undef` rule rejects it.
 */
type HeadersInput = Headers | Array<[string, string]> | Record<string, string>;

const clientLabelLocalStorage = new AsyncLocalStorage<string>();

const USER_AGENT_PATTERNS = [
  ['Edge', /(?:Edg|Edge|EdgA)\/([0-9.]+)/i],
  ['Firefox', /(?:Firefox|FxiOS)\/([0-9.]+)/i],
  ['Chrome', /(?:Chrome|CriOS)\/([0-9.]+)/i],
  ['Safari', /Version\/([0-9.]+).*Safari/i],
] as const;

export function parseUserAgent(userAgent: string): string {
  if (!userAgent) {
    return 'Browser';
  }

  for (const [name, regex] of USER_AGENT_PATTERNS) {
    const match = userAgent.match(regex);
    if (match) {
      return `${name}/${match[1]}`;
    }
  }

  return 'Browser';
}

function _getDefaultLabels(): string[] {
  let frameworkLabel = `${ADK_LABEL}/${version}`;

  if (!isBrowser() && process.env[AGENT_ENGINE_TELEMETRY_ENV_VARIABLE_NAME]) {
    frameworkLabel = `${frameworkLabel}+${AGENT_ENGINE_TELEMETRY_TAG}`;
  }

  const languageLabelDetail = isBrowser()
    ? // eslint-disable-next-line no-undef
      parseUserAgent(window.navigator.userAgent)
    : process.version;

  const languageLabel = `${LANGUAGE_LABEL}/${languageLabelDetail}`;
  return [frameworkLabel, languageLabel];
}

/**
 * Runs the given callback within a context that has the specified client label.
 * All LLM calls made within this callback will include the client label in their tracking headers.
 *
 * @param clientLabel The custom client label to apply.
 * @param callback The callback function to execute.
 * @return The result of the callback.
 */
export function runWithClientLabel<R>(
  clientLabel: string,
  callback: () => R,
): R {
  if (typeof clientLabel !== 'string' || clientLabel.trim() === '') {
    throw new Error('Client label must be a non-empty string.');
  }

  return clientLabelLocalStorage.run(clientLabel, callback);
}

/**
 * Returns the current list of client labels that can be added to HTTP Headers.
 */
export function getClientLabels(): string[] {
  const labels = _getDefaultLabels();
  const contextLabel = clientLabelLocalStorage.getStore();
  if (contextLabel) {
    labels.push(contextLabel);
  }
  return labels;
}

/**
 * Returns the HTTP headers that identify a request as coming from ADK.
 *
 * Both headers carry the current client labels, including a label set with
 * {@link runWithClientLabel} when called inside that context.
 */
export function getTrackingHeaders(): Record<string, string> {
  const headerValue = getClientLabels().join(' ');
  return {
    'x-goog-api-client': headerValue,
    'user-agent': headerValue,
  };
}

function isTrackingHeaderName(name: string): boolean {
  return TRACKING_HEADER_NAMES.some((trackingName) => trackingName === name);
}

function isHeaders(
  headers: Headers | Record<string, string>,
): headers is Headers {
  return typeof headers.forEach === 'function';
}

function headerEntries(headers?: HeadersInput): Array<[string, string]> {
  if (!headers) {
    return [];
  }
  if (Array.isArray(headers)) {
    return headers.map(([name, value]) => [name, value]);
  }
  if (isHeaders(headers)) {
    const entries: Array<[string, string]> = [];
    headers.forEach((value, name) => {
      entries.push([name, value]);
    });
    return entries;
  }
  return Object.entries(headers);
}

/**
 * Returns a copy of `headers` with the ADK tracking headers merged in.
 *
 * HTTP header names are case-insensitive, so a caller's `User-Agent` or
 * `X-Goog-Api-Client` in any casing is folded onto the lower-case name and the
 * header is sent once. For each tracking header, the ADK tokens come first,
 * followed by every caller token that is not already present. Caller values
 * are split on whitespace and empty tokens are dropped; adk-python splits on a
 * single space, so the two differ only for values with repeated or non-space
 * whitespace. Commas are not treated as separators, so a `Headers` object that
 * joined two values of one header with `, ` keeps the comma on the first
 * token. Other repeated header names are combined in encounter order,
 * matching the comma-joined values produced by `Headers` for request headers.
 *
 * The input is never mutated.
 *
 * @param headers The caller's headers, in any `HeadersInit` shape.
 * @return A new plain object with the merged headers.
 */
export function mergeTrackingHeaders(
  headers?: HeadersInput,
): Record<string, string> {
  const otherHeaders = new Map<string, {name: string; values: string[]}>();
  const callerValues = new Map<string, string[]>();

  for (const [name, value] of headerEntries(headers)) {
    const lowerName = name.toLowerCase();
    if (isTrackingHeaderName(lowerName)) {
      callerValues.set(lowerName, [
        ...(callerValues.get(lowerName) ?? []),
        value,
      ]);
    } else {
      const existing = otherHeaders.get(lowerName);
      if (existing) {
        existing.values.push(value);
      } else {
        otherHeaders.set(lowerName, {name, values: [value]});
      }
    }
  }

  const merged = Object.fromEntries(
    Array.from(otherHeaders.values(), ({name, values}) => [
      name,
      values.join(', '),
    ]),
  ) as Record<string, string>;

  for (const [name, trackingValue] of Object.entries(getTrackingHeaders())) {
    const tokens = trackingValue.split(' ');
    for (const value of callerValues.get(name) ?? []) {
      for (const token of value.split(/\s+/)) {
        if (token && !tokens.includes(token)) {
          tokens.push(token);
        }
      }
    }
    merged[name] = tokens.join(' ');
  }

  return merged;
}
