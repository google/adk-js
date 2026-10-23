/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type BaseTool, type Context, type Event, logger} from '@google/adk';
import {BlockedReason, FinishReason} from '@google/genai';
import {safeGet} from './sanitize.js';

// Callback contracts the observability plugins share (port of adk-python
// `plugins/_callback_helpers.py`). None of the tool-result checks run code of
// the result, its keys or its values, so a hostile result cannot throw into a
// callback or leak into a log.

/**
 * Model finish and block reasons: an `Event.errorCode` from this set is a model
 * termination, not a node failure.
 */
const LLM_RESPONSE_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  ...Object.values(FinishReason),
  ...Object.values(BlockedReason),
]);

const MCP_TOOL_ERROR_MESSAGE = 'Tool returned an MCP result with isError=true.';
const REFLECT_AND_RETRY_TOOL_ERROR_MESSAGE =
  'Tool raised an error that ReflectAndRetryToolPlugin handled.';
const CLASSIFIED_TOOL_ERROR_MESSAGE =
  'tool_result_classifier classified the tool result as an error.';
// `REFLECT_AND_RETRY_RESPONSE_TYPE` of `@google/adk`, which its public entry
// point does not export.
const REFLECT_AND_RETRY_RESPONSE_TYPE =
  'ERROR_HANDLED_BY_REFLECT_AND_RETRY_PLUGIN';
const RESULT_FIELD_NAMES: ReadonlySet<string> = new Set([
  'response_type',
  'error_details',
  'error_type',
  'isError',
  'is_error',
]);

/**
 * A `tool_result_classifier` verdict. Build it with {@link
 * toolResultClassification} to validate it.
 */
export interface ToolResultClassification {
  readonly status: 'OK' | 'ERROR';
  readonly errorMessage?: string | null;
}

/**
 * Decides whether a tool result reports a failure: `ERROR` records a
 * `TOOL_ERROR`, `OK` a completed call, and nullish leaves it to the built-in
 * rule. Must be synchronous and must not modify its arguments. Not called for a
 * `ReflectAndRetryToolPlugin` answer, which is always a tool error.
 */
export type ToolResultClassifier = (params: {
  tool: BaseTool;
  toolArgs: Record<string, unknown>;
  toolContext: Context;
  result: unknown;
}) => ToolResultClassification | null | undefined;

/**
 * Validates and freezes a classifier verdict (port of
 * `ToolResultClassification.__post_init__`).
 */
export function toolResultClassification({
  status,
  errorMessage = null,
}: ToolResultClassification): ToolResultClassification {
  // JavaScript callers bypass the type
  if (status !== 'OK' && status !== 'ERROR') {
    throw new RangeError("status must be 'OK' or 'ERROR'.");
  }
  if (errorMessage !== null && typeof errorMessage !== 'string') {
    throw new RangeError('errorMessage must be a string or null.');
  }
  return Object.freeze({status, errorMessage});
}

/**
 * Whether an event reports that a workflow node failed, as opposed to a model
 * finish or block reason.
 */
export function isDurableNodeError(event: Event): boolean {
  return (
    event.partial !== true &&
    Boolean(event.errorCode) &&
    !LLM_RESPONSE_ERROR_CODES.has(event.errorCode ?? '')
  );
}

function ownDataValue(obj: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(obj, key);
  return descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined;
}

/**
 * The entries of a plain-object result that the built-in rules read, through
 * descriptors so no getter or Proxy-free accessor runs. Any other result has no
 * entries.
 */
function resultFields(result: unknown): Map<string, unknown> {
  const fields = new Map<string, unknown>();
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return fields;
  }
  const prototype: unknown = Object.getPrototypeOf(result);
  if (prototype !== Object.prototype && prototype !== null) {
    return fields;
  }
  for (const name of RESULT_FIELD_NAMES) {
    if (Object.hasOwn(result, name)) {
      fields.set(name, ownDataValue(result, name));
    }
  }
  return fields;
}

function retryAnswerErrorMessage(fields: Map<string, unknown>): string | null {
  if (fields.get('response_type') !== REFLECT_AND_RETRY_RESPONSE_TYPE) {
    return null;
  }
  for (const key of ['error_details', 'error_type']) {
    const message = fields.get(key);
    if (typeof message === 'string' && message !== '') {
      return message;
    }
  }
  return REFLECT_AND_RETRY_TOOL_ERROR_MESSAGE;
}

function mcpErrorMessage(fields: Map<string, unknown>): string | null {
  return fields.get('isError') === true || fields.get('is_error') === true
    ? MCP_TOOL_ERROR_MESSAGE
    : null;
}

function applyRule(
  name: string,
  rule: (fields: Map<string, unknown>) => string | null,
  fields: Map<string, unknown>,
): string | null {
  try {
    return rule(fields);
  } catch {
    // Logged below, outside the catch, so a failing log handler never prints
    // the caught error, which can carry the result.
  }
  logger.warn(`Built-in tool result rule ${name} failed; skipping it.`);
  return null;
}

function classificationErrorMessage(classification: unknown): string | null {
  if (typeof classification !== 'object' || classification === null) {
    throw new TypeError(
      'tool_result_classifier returned an unsupported value.',
    );
  }
  const status = ownDataValue(classification, 'status');
  if (status === 'OK') {
    return null;
  }
  if (status !== 'ERROR') {
    throw new RangeError('ToolResultClassification.status is not OK or ERROR.');
  }
  const message = ownDataValue(classification, 'errorMessage');
  if (message === null || message === undefined) {
    return CLASSIFIED_TOOL_ERROR_MESSAGE;
  }
  if (typeof message !== 'string') {
    throw new TypeError(
      'ToolResultClassification.errorMessage is not a string.',
    );
  }
  return message === '' ? CLASSIFIED_TOOL_ERROR_MESSAGE : message;
}

function isThenable(value: unknown): boolean {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null
  ) {
    return false;
  }
  return typeof safeGet(value, 'then') === 'function';
}

function isAsyncFunction(fn: unknown): boolean {
  if (typeof fn !== 'function') {
    return false;
  }
  const tag = Object.prototype.toString.call(fn);
  return (
    tag === '[object AsyncFunction]' ||
    tag === '[object AsyncGeneratorFunction]'
  );
}

/**
 * Validates a plugin's `tool_result_classifier`: it runs synchronously inside
 * `afterToolCallback`, so an async one would only return a promise nobody
 * awaits.
 */
export function validateToolResultClassifier(classifier: unknown): void {
  if (classifier === null || classifier === undefined) {
    return;
  }
  if (typeof classifier !== 'function') {
    throw new RangeError(
      `toolResultClassifier must be a function, got ${typeof classifier}.`,
    );
  }
  if (isAsyncFunction(classifier)) {
    throw new RangeError(
      'toolResultClassifier must be synchronous; afterToolCallback calls it without awaiting the result.',
    );
  }
  if (classifier.length > 1) {
    throw new RangeError(
      'toolResultClassifier must take a single {tool, toolArgs, toolContext, result} object parameter.',
    );
  }
}

/**
 * Returns the error message for a tool result that reports a failure, or null
 * for a completed call (port of `_classify_tool_result_error`). In order: a
 * `ReflectAndRetryToolPlugin` answer; the classifier, whose throw or unusable
 * verdict falls back to the built-in rule; a top-level `isError` / `is_error`
 * that is exactly `true`.
 */
export function classifyToolResultError({
  tool,
  toolArgs,
  toolContext,
  result,
  toolResultClassifier = null,
}: {
  tool: BaseTool;
  toolArgs: Record<string, unknown>;
  toolContext: Context;
  result: unknown;
  toolResultClassifier?: ToolResultClassifier | null;
}): string | null {
  const fields = resultFields(result);
  const retryAnswerMessage = applyRule(
    '_retry_answer_error_message',
    retryAnswerErrorMessage,
    fields,
  );
  if (retryAnswerMessage !== null) {
    return retryAnswerMessage;
  }
  if (toolResultClassifier !== null) {
    let classifierFailed = false;
    try {
      const classification: unknown = toolResultClassifier({
        tool,
        toolArgs,
        toolContext,
        result,
      });
      if (isThenable(classification)) {
        if (classification instanceof Promise) {
          void classification.then(undefined, () => undefined);
        }
        logger.warn(
          `tool_result_classifier returned an awaitable for tool ${tool.name}; it must be synchronous. Applying the built-in rule instead.`,
        );
      } else if (classification !== null && classification !== undefined) {
        return classificationErrorMessage(classification);
      }
    } catch {
      classifierFailed = true;
    }
    if (classifierFailed) {
      logger.warn(
        `tool_result_classifier failed or returned an unusable verdict for tool ${tool.name}; applying the built-in rule instead.`,
      );
    }
  }
  return applyRule('_mcp_error_message', mcpErrorMessage, fields);
}

// Per plugin, the tool calls whose failure its onToolErrorCallback recorded. A
// later plugin's answer to that error (ReflectAndRetryToolPlugin) reaches
// afterToolCallback as the call's result and must not be recorded again. Keyed
// by plugin so two plugins never consume each other's mark; weak so a call that
// ends without afterToolCallback is not kept alive.
const recordedToolErrors = new WeakMap<object, WeakSet<object>>();

/**
 * Marks that `plugin` recorded the failure of the tool call `toolContext`
 * belongs to.
 */
export function markToolErrorRecorded(
  plugin: object,
  toolContext: object,
): void {
  const recorded = recordedToolErrors.get(plugin) ?? new WeakSet<object>();
  recorded.add(toolContext);
  recordedToolErrors.set(plugin, recorded);
}

/** Reports, and forgets, whether `plugin` recorded this call's failure. */
export function popToolErrorRecorded(
  plugin: object,
  toolContext: object,
): boolean {
  const recorded = recordedToolErrors.get(plugin);
  if (recorded === undefined || !recorded.has(toolContext)) {
    return false;
  }
  recorded.delete(toolContext);
  return true;
}
