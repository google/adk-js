/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inspection helpers for the "paused, waiting on a human" state.
 *
 * A pause is not visible in an event's text: it is carried in a `functionCall`
 * part named `adk_request_*`, with the prompt buried in that call's `args`. A
 * client that renders only text parts therefore shows the user nothing while
 * the run sits blocked. These helpers flatten the three encodings into one
 * shape so a caller need not know how each kind stores its id and prompt.
 */

import {AuthConfig} from '../auth/auth_tool.js';
import {Event} from '../events/event.js';
import {camelCaseKeys} from '../utils/case_utils.js';
import {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from './functions.js';

/**
 * What a paused run is waiting for.
 *
 * - `input`: free-form or structured data (`RequestInput`).
 * - `credential`: an auth credential, e.g. an API key or an OAuth flow.
 * - `confirmation`: approval to run a tool guarded by `requireConfirmation`.
 */
export type UserInputKind = 'input' | 'credential' | 'confirmation';

/** A single request for user input carried by an event. */
export interface UserInputRequest {
  kind: UserInputKind;

  /**
   * The id that answers this request: reply with a `functionResponse` carrying
   * this same id (and {@link functionCallName}).
   */
  interruptId: string;

  /** The name to answer with, alongside {@link interruptId}. */
  functionCallName: string;

  /** The node or agent that raised the request. */
  author?: string;

  /**
   * Human-readable prompt for the user. Populated for every kind: the
   * `RequestInput` message, the credential prompt, or the tool-confirmation
   * hint. Absent when the raiser supplied none.
   */
  message?: string;

  /** Structured data attached to the request (`RequestInput.payload`). */
  payload?: unknown;

  /** JSON schema the reply is expected to satisfy, when declared. */
  responseSchema?: unknown;

  /** `confirmation` only: the tool awaiting approval. */
  toolName?: string;

  /** `credential` only: the auth config to complete. */
  authConfig?: AuthConfig;
}

/**
 * Returns every user-input request carried by a single event, in part order.
 *
 * This reports what the event *asks for*; it does not know whether the request
 * was later answered. Use {@link getPendingUserInputRequests} over a session's
 * events to get only the ones still outstanding.
 */
export function getUserInputRequests(event: Event): UserInputRequest[] {
  const requests: UserInputRequest[] = [];

  for (const part of event.content?.parts ?? []) {
    const functionCall = part.functionCall;
    if (!functionCall?.name) {
      continue;
    }

    const args = normalizeArgs(functionCall.name, functionCall.args);
    // Every interrupt kind stashes its id somewhere slightly different.
    const interruptId =
      functionCall.id ??
      asString(args['interruptId']) ??
      asString(args['functionCallId']);
    if (!interruptId) {
      continue;
    }

    const base = {
      interruptId,
      functionCallName: functionCall.name,
      author: event.author,
    };

    switch (functionCall.name) {
      case REQUEST_INPUT_FUNCTION_CALL_NAME:
        requests.push({
          ...base,
          kind: 'input',
          message: asString(args['message']),
          payload: args['payload'] ?? undefined,
          responseSchema: args['response_schema'] ?? undefined,
        });
        break;

      case REQUEST_CREDENTIAL_FUNCTION_CALL_NAME:
        requests.push({
          ...base,
          kind: 'credential',
          message: asString(args['message']),
          authConfig: (args['authConfig'] as AuthConfig) ?? undefined,
        });
        break;

      case REQUEST_CONFIRMATION_FUNCTION_CALL_NAME: {
        const confirmation = args['toolConfirmation'] as
          | {hint?: unknown; payload?: unknown}
          | undefined;
        const originalCall = args['originalFunctionCall'] as
          | {name?: unknown}
          | undefined;
        requests.push({
          ...base,
          kind: 'confirmation',
          // Surfaced as `message` so callers can render any kind uniformly.
          message: asNonEmptyString(confirmation?.hint),
          payload: confirmation?.payload ?? undefined,
          toolName: asString(originalCall?.name),
        });
        break;
      }

      default:
        break;
    }
  }

  return requests;
}

/** Whether this event asks the user for something. */
export function requiresUserInput(event: Event): boolean {
  return getUserInputRequests(event).length > 0;
}

/**
 * Returns the requests across a sequence of events that have not been answered
 * yet, in the order they were raised.
 *
 * A request is answered by a later `functionResponse` part carrying the same
 * id, which is how a resumed session records the user's reply. Pass a session's
 * events to answer "is this session waiting on the user right now, and for
 * what?".
 */
export function getPendingUserInputRequests(
  events: readonly Event[],
): UserInputRequest[] {
  const answeredIds = new Set<string>();
  for (const event of events) {
    for (const part of event.content?.parts ?? []) {
      const id = part.functionResponse?.id;
      if (id) {
        answeredIds.add(id);
      }
    }
  }

  const pending: UserInputRequest[] = [];
  const seenIds = new Set<string>();
  for (const event of events) {
    for (const request of getUserInputRequests(event)) {
      // A re-run node can raise the same interrupt id more than once; the user
      // still only owes one answer.
      if (
        answeredIds.has(request.interruptId) ||
        seenIds.has(request.interruptId)
      ) {
        continue;
      }
      seenIds.add(request.interruptId);
      pending.push(request);
    }
  }

  return pending;
}

/**
 * The two producers of an `adk_request_credential` call disagree on casing:
 * the agent/tool auth flow writes snake_case (`functions.ts` `generateAuthEvent`
 * -> `function_call_id`, `auth_config`) while the workflow auth gate writes
 * camelCase (`hitl_utils.ts` `createAuthRequestEvent`). Normalize that kind the
 * same way `auth_preprocessor` does, so both render.
 *
 * Only credential args are rewritten: the other kinds carry a caller-supplied
 * `payload` whose own keys must survive untouched.
 */
function normalizeArgs(
  functionCallName: string,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!args) {
    return {};
  }
  return functionCallName === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME
    ? (camelCaseKeys(args) as Record<string, unknown>)
    : args;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
