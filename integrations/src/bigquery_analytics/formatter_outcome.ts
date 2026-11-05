/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '@google/adk';
import {
  exceedsCodePoints,
  lastCodePoints,
  sliceCodePoints,
} from './python_strings.js';
import {isPlainObject, objectTag, safeGet} from './sanitize.js';

/**
 * Written in place of event content when a configured content formatter fails
 * or returns an unsupported value.
 */
export const FORMATTER_FAILED_SENTINEL = '[FORMATTER_FAILED]';

const MAX_FORMATTER_TRACEBACK_PART_CHARS = 1024;
const MAX_FORMATTER_TRACEBACK_CHARS = 4096;
const FORMATTER_TRACEBACK_CUT = '\n... [traceback truncated]';

// Only built-ins carry a label: a class created at runtime can take its name
// from the content the formatter was protecting, so its own name is never read.
const TRUSTED_PROTOTYPE_LABELS = new Map<unknown, string>([
  [Error.prototype, 'Error'],
  [TypeError.prototype, 'TypeError'],
  [RangeError.prototype, 'RangeError'],
  [SyntaxError.prototype, 'SyntaxError'],
  [ReferenceError.prototype, 'ReferenceError'],
  [EvalError.prototype, 'EvalError'],
  [URIError.prototype, 'URIError'],
  [AggregateError.prototype, 'AggregateError'],
  [Map.prototype, 'Map'],
  [Set.prototype, 'Set'],
  [WeakMap.prototype, 'WeakMap'],
  [WeakSet.prototype, 'WeakSet'],
  [Date.prototype, 'Date'],
  [RegExp.prototype, 'RegExp'],
  [Promise.prototype, 'Promise'],
  [ArrayBuffer.prototype, 'ArrayBuffer'],
  [Uint8Array.prototype, 'Uint8Array'],
  [Function.prototype, 'Function'],
  [Number.prototype, 'Number'],
  [Boolean.prototype, 'Boolean'],
  [Symbol.prototype, 'Symbol'],
  [BigInt.prototype, 'BigInt'],
  [Object.prototype, 'Object'],
]);

function formatterFailureMessage(value: unknown, raised: boolean): string {
  const outcome = raised ? 'raised' : 'returned unsupported type';
  if (typeof value !== 'object' && typeof value !== 'function') {
    return `content_formatter ${outcome} ${value === undefined ? 'undefined' : typeof value}`;
  }
  if (value === null) {
    return `content_formatter ${outcome} null`;
  }
  try {
    let prototype: unknown = Object.getPrototypeOf(value);
    for (let depth = 0; prototype !== null && depth < 1000; depth += 1) {
      const label = TRUSTED_PROTOTYPE_LABELS.get(prototype);
      if (label !== undefined) {
        return depth === 0
          ? `content_formatter ${outcome} ${label}`
          : `content_formatter ${outcome} <subclass of ${label}>`;
      }
      prototype = Object.getPrototypeOf(prototype);
    }
  } catch {
    // A Proxy's getPrototypeOf trap can throw; the class then stays unnamed.
  }
  return `content_formatter ${outcome} <unknown class>`;
}

function renderFormatterTraceback(error: unknown): string {
  try {
    const stack = error instanceof Error ? safeGet(error, 'stack') : undefined;
    const rendered = (typeof stack === 'string' ? stack : String(error))
      .split('\n')
      .map((part) =>
        exceedsCodePoints(part, MAX_FORMATTER_TRACEBACK_PART_CHARS)
          ? `${sliceCodePoints(part, MAX_FORMATTER_TRACEBACK_PART_CHARS)}...`
          : part,
      )
      .join('\n')
      .trimEnd();
    if (exceedsCodePoints(rendered, MAX_FORMATTER_TRACEBACK_CHARS)) {
      const half = MAX_FORMATTER_TRACEBACK_CHARS / 2;
      return `${sliceCodePoints(rendered, half)}${FORMATTER_TRACEBACK_CUT}\n${lastCodePoints(rendered, half)}`;
    }
    return rendered;
  } catch {
    return '[traceback could not be rendered]';
  }
}

function isBoxedString(value: object): boolean {
  return objectTag(value) === '[object String]';
}

function isNativelyParsed(formatted: unknown): boolean {
  return (
    formatted === null ||
    formatted === undefined ||
    typeof formatted === 'string' ||
    Array.isArray(formatted) ||
    (typeof formatted === 'object' &&
      (isPlainObject(formatted) || isBoxedString(formatted)))
  );
}

function releaseRejectedResult(formatted: unknown): void {
  try {
    if (formatted instanceof Promise) {
      void formatted.then(undefined, () => undefined);
      return;
    }
    if (typeof formatted !== 'object' || formatted === null) {
      return;
    }
    const tag = objectTag(formatted);
    if (tag !== '[object Generator]' && tag !== '[object AsyncGenerator]') {
      return;
    }
    const close = safeGet(formatted, 'return');
    if (typeof close !== 'function') {
      return;
    }
    const closed: unknown = Reflect.apply(close, formatted, []);
    if (closed instanceof Promise) {
      void closed.then(undefined, () => undefined);
    }
  } catch {
    // Closing ran code the content under redaction may control; nothing it
    // raises may end the run.
  }
}

/**
 * What a row logs once the content formatter ran: the content, and the error
 * note when it failed.
 */
export interface FormatterOutcome {
  content: unknown;
  errorMessage: string | null;
}

/**
 * Decides what the row logs after the content formatter ran, failing closed
 * (port of `_settle_formatter_outcome`). Pass `failure` only when the formatter
 * threw; a nullish `failure` means it returned `formatted`, so the caller wraps
 * a thrown nullish value in an `Error`.
 */
export function settleFormatterOutcome({
  formatted,
  failure,
  eventType,
  debug,
}: {
  formatted: unknown;
  failure: unknown;
  eventType: string;
  debug: boolean;
}): FormatterOutcome {
  const raised = failure !== null && failure !== undefined;
  let note = `content_formatter ${raised ? 'raised' : 'returned unsupported type'} <unknown class>`;
  try {
    if (!raised) {
      if (isNativelyParsed(formatted)) {
        return {
          content:
            typeof formatted === 'object' &&
            formatted !== null &&
            isBoxedString(formatted)
              ? String.prototype.valueOf.call(formatted)
              : formatted,
          errorMessage: null,
        };
      }
      releaseRejectedResult(formatted);
    }
    note = formatterFailureMessage(raised ? failure : formatted, raised);
    if (!raised) {
      logger.warn(
        `Content formatter returned an unsupported result type for event ${eventType}; writing sentinel instead of original content.`,
      );
    } else if (debug) {
      logger.warn(
        `Content formatter failed for event ${eventType}; writing sentinel instead of original content. Debug traceback:\n${renderFormatterTraceback(failure)}`,
      );
    } else {
      logger.warn(
        `Content formatter failed for event ${eventType}; writing sentinel instead of original content.`,
      );
    }
  } catch {
    // The logger may be what failed, and the failure can carry the content.
  }
  return {content: FORMATTER_FAILED_SENTINEL, errorMessage: note};
}
