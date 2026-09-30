/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A stand-in for `winston`, so the adapter's logger can be constructed in a
 * page.
 *
 * `SimpleLogger` builds a real winston logger in its constructor
 * (`core/src/utils/logger.ts`), which runs on import and pulls the whole
 * Node-only transport stack into a browser bundle. This provides the narrow
 * surface that constructor touches and drops every message.
 *
 * Used only by `chrome_prompt_api_test.ts`. Nothing here ships.
 */

/** Formatters are never applied, so each is the identity. */
const formatter = () => (info) => info;

export const format = Object.assign(
  // `winston.format(fn)()` wraps a formatter function.
  (fn) => () => fn,
  {
    combine: formatter,
    label: formatter,
    colorize: formatter,
    timestamp: formatter,
    printf: formatter,
  },
);

export function createLogger() {
  const noop = () => {};
  return {log: noop, debug: noop, info: noop, warn: noop, error: noop};
}

export const transports = {Console: class {}};

export default {createLogger, format, transports};
