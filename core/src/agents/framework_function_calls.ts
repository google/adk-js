/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

/**
 * The function call the framework emits to ask a human to approve a pending
 * tool call.
 */
export const REQUEST_CONFIRMATION_FUNCTION_CALL_NAME =
  'adk_request_confirmation';

/** The function call the framework emits to ask a client for credentials. */
export const REQUEST_CREDENTIAL_FUNCTION_CALL_NAME = 'adk_request_credential';

/** The function call the framework emits to ask a client for input. */
export const REQUEST_INPUT_FUNCTION_CALL_NAME = 'adk_request_input';

/**
 * Names reserved for the framework's own control-plane calls.
 *
 * These are questions the framework asks — approve this, authenticate that,
 * answer this — raised into agent-authored events. A client answers one with a
 * function *response*; a client that writes the *call* is writing the question
 * itself.
 */
const RESERVED_FUNCTION_CALL_NAMES: ReadonlySet<string> = new Set([
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
]);

/**
 * The first reserved function call in `content`, if it carries one.
 *
 * Used to keep client input out of the framework's own control plane. Function
 * responses are untouched: answering a pending request is exactly what a client
 * is supposed to do.
 *
 * @param content The content to inspect.
 * @return The reserved call's name, or undefined when there is none.
 */
export function reservedFunctionCallName(
  content: Content | undefined,
): string | undefined {
  for (const part of content?.parts ?? []) {
    const name = part.functionCall?.name;
    if (name && RESERVED_FUNCTION_CALL_NAMES.has(name)) {
      return name;
    }
  }
  return undefined;
}
