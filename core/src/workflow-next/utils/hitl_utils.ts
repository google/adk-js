/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utilities for Human-in-the-Loop (HITL) workflows.
 *
 * Ported (subset) from `google/adk-python`
 * `workflow/utils/_workflow_hitl_utils.py`. The auth-credential helpers are
 * added in the Phase 5 auth-gate follow-up.
 */

import {Part} from '@google/genai';
import {z} from 'zod';
import {createEvent, Event} from '../../events/event.js';
import {RequestInput} from '../request_input.js';

/** Function-call name marking a request-for-input interrupt. */
export const REQUEST_INPUT_FUNCTION_CALL_NAME = 'adk_request_input';

/** Function-call name marking a request-for-credential interrupt. */
export const REQUEST_CREDENTIAL_FUNCTION_CALL_NAME = 'adk_request_credential';

/**
 * Creates an interrupt {@link Event} from a {@link RequestInput}. The event
 * carries an `adk_request_input` function call and marks the interrupt id as a
 * long-running tool id.
 */
export function createRequestInputEvent(requestInput: RequestInput): Event {
  const args: Record<string, unknown> = {
    interruptId: requestInput.interruptId,
    payload: requestInput.payload ?? null,
    message: requestInput.message ?? null,
    responseSchema: requestInput.responseSchema
      ? z.toJSONSchema(requestInput.responseSchema)
      : null,
  };

  return createEvent({
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            name: REQUEST_INPUT_FUNCTION_CALL_NAME,
            args,
            id: requestInput.interruptId,
          },
        },
      ],
    },
    longRunningToolIds: [requestInput.interruptId],
  });
}

/** Returns whether an event contains a `request_input` function call. */
export function hasRequestInputFunctionCall(event: Event): boolean {
  return (event.content?.parts ?? []).some(
    (p) => p.functionCall?.name === REQUEST_INPUT_FUNCTION_CALL_NAME,
  );
}

/** Returns whether an event contains an `adk_request_credential` function call. */
export function hasAuthRequestFunctionCall(event: Event): boolean {
  return (event.content?.parts ?? []).some(
    (p) => p.functionCall?.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  );
}

/** Extracts interrupt ids from `request_input` function calls in an event. */
export function getRequestInputInterruptIds(event: Event): string[] {
  const ids: string[] = [];
  for (const part of event.content?.parts ?? []) {
    const fc = part.functionCall;
    if (fc && fc.name === REQUEST_INPUT_FUNCTION_CALL_NAME && fc.id) {
      ids.push(fc.id);
    }
  }
  return ids;
}

/**
 * Creates a `FunctionResponse` part answering a `request_input` interrupt,
 * suitable for appending to a session as the user's resume response.
 */
export function createRequestInputResponse(
  interruptId: string,
  response: Record<string, unknown>,
): Part {
  return {
    functionResponse: {
      id: interruptId,
      name: REQUEST_INPUT_FUNCTION_CALL_NAME,
      response,
    },
  };
}
