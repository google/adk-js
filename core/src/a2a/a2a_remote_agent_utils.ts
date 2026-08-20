/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart} from '@a2a-js/sdk';
import {Content, Part as GenAIPart} from '@google/genai';
import {REQUEST_CREDENTIAL_FUNCTION_CALL_NAME} from '../agents/functions.js';
import {InvocationContext, requireAgent} from '../agents/invocation_context.js';
import {Event as AdkEvent, createEvent} from '../events/event.js';
import {Session} from '../sessions/session.js';
import {AdkMetadataKeys} from './metadata_converter_utils.js';
import {toA2AParts} from './part_converter_utils.js';

// Top-level keys of a serialized AuthConfig, the shape an
// adk_request_credential call's arguments (one level down, under
// `authConfig`) and its response (flat) both carry.
const AUTH_CONFIG_KEYS: ReadonlyArray<string> = ['authScheme', 'credentialKey'];

/** Whether `payload` looks like a serialized AuthConfig (fail closed). */
function payloadIsAuthConfig(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const keys = new Set(Object.keys(payload as Record<string, unknown>));
  return AUTH_CONFIG_KEYS.every((key) => keys.has(key));
}

/** Whether a function_call carries credential material (fail closed). */
function isCredentialFunctionCall(functionCall: {
  name?: string;
  args?: unknown;
}): boolean {
  if (functionCall.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME) {
    return true;
  }
  // A request wraps the AuthConfig in an AuthToolArguments envelope, so the
  // shape has to be read one level down, under `authConfig`.
  const args = functionCall.args;
  if (!args || typeof args !== 'object') {
    return false;
  }
  const authConfig = (args as Record<string, unknown>)['authConfig'];
  return payloadIsAuthConfig(authConfig);
}

/** Whether a function_response carries credential material (fail closed). */
function isCredentialFunctionResponse(functionResponse: {
  name?: string;
  response?: unknown;
}): boolean {
  if (functionResponse.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME) {
    return true;
  }
  return payloadIsAuthConfig(functionResponse.response);
}

/**
 * Returns `content` with any credential-bearing function_call or
 * function_response part removed.
 *
 * An adk_request_credential call carries a serialized AuthConfig in its
 * arguments -- including rawAuthCredential, an OAuth2 client secret or a
 * service account key -- and its response carries one back. Forwarding
 * either to a remote A2A peer would leak that credential material outside
 * the trust boundary it was issued within.
 */
function withoutCredentialParts(
  content: Content | undefined,
): Content | undefined {
  if (!content || !content.parts) {
    return content;
  }
  const hasCredentialPart = content.parts.some(
    (part) =>
      (part.functionCall && isCredentialFunctionCall(part.functionCall)) ||
      (part.functionResponse &&
        isCredentialFunctionResponse(part.functionResponse)),
  );
  if (!hasCredentialPart) {
    return content;
  }
  return {
    ...content,
    parts: content.parts.filter(
      (part) =>
        !(part.functionCall && isCredentialFunctionCall(part.functionCall)) &&
        !(
          part.functionResponse &&
          isCredentialFunctionResponse(part.functionResponse)
        ),
    ),
  };
}

export interface UserFunctionCall {
  response: AdkEvent;
  taskId: string;
  contextId: string;
}

/**
 * Returns a UserFunctionCall when the event at `index` contains a
 * FunctionResponse that can be traced back to a preceding FunctionCall event.
 *
 * @param session - The session whose event history to inspect.
 * @param index - Index of the candidate event to examine.
 * @returns The matching `UserFunctionCall`, or `undefined` if the event at
 *   `index` is not a user function-response event or has no preceding call.
 */
export function getUserFunctionCallAt(
  session: Session,
  index: number,
): UserFunctionCall | undefined {
  const events = session.events;
  if (index < 0 || index >= events.length) {
    return undefined;
  }

  const candidate = events[index];
  if (candidate.author !== 'user') {
    return undefined;
  }

  const fnCallId = getFunctionResponseCallId(candidate);
  if (!fnCallId) {
    return undefined;
  }

  for (let i = index - 1; i >= 0; i--) {
    const request = events[i];
    if (!isFunctionCallEvent(request, fnCallId)) {
      continue;
    }

    const metadata = request.customMetadata || {};
    const taskId = (metadata[AdkMetadataKeys.TASK_ID] as string) || '';
    const contextId = (metadata[AdkMetadataKeys.CONTEXT_ID] as string) || '';

    return {
      response: candidate,
      taskId,
      contextId,
    };
  }

  return undefined;
}

/**
 * Checks if an event contains a function call with the given ID.
 *
 * @param event - The event to inspect.
 * @param callId - The function call ID to look for.
 * @returns `true` if a part in the event has a matching `functionCall.id`.
 */
export function isFunctionCallEvent(event: AdkEvent, callId: string): boolean {
  if (!event || !event.content || !event.content.parts) {
    return false;
  }

  return event.content.parts.some(
    (part: GenAIPart) => part.functionCall && part.functionCall.id === callId,
  );
}

/**
 * Finds the first part with a FunctionResponse and returns the call ID.
 *
 * @param event - The event to inspect.
 * @returns The `id` of the first FunctionResponse part, or `undefined` if
 *   none is found.
 */
export function getFunctionResponseCallId(event: AdkEvent): string | undefined {
  if (!event || !event.content || !event.content.parts) {
    return undefined;
  }

  const responsePart = event.content.parts.find(
    (part: GenAIPart) => part.functionResponse,
  );

  return responsePart?.functionResponse?.id;
}

/**
 * Returns A2A content parts for all events not yet seen by the remote agent,
 * along with the A2A context ID found in the most recent remote agent event.
 *
 * @param ctx - The current invocation context, used to identify the remote
 *   agent's authored events.
 * @param session - The local session whose event history to diff.
 * @returns An object with the missing `parts` and an optional `contextId`.
 */
export function toMissingRemoteSessionParts(
  ctx: InvocationContext,
  session: Session,
): {parts: A2APart[]; contextId?: string} {
  const events = session.events;
  let contextId: string | undefined = undefined;
  let lastRemoteResponseIndex = -1;

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author === requireAgent(ctx).name) {
      lastRemoteResponseIndex = i;
      const metadata = event.customMetadata || {};
      contextId = metadata[AdkMetadataKeys.CONTEXT_ID] as string;
      break;
    }
  }

  const missingParts: A2APart[] = [];

  for (let i = lastRemoteResponseIndex + 1; i < events.length; i++) {
    let event = events[i];
    // Drop credential material before anything else looks at the event.
    // presentAsUserMessage renders a function_call as text with its
    // arguments inlined, so scrubbing after it would be too late.
    const scrubbedContent = withoutCredentialParts(event.content);
    if (scrubbedContent !== event.content) {
      event = {...event, content: scrubbedContent};
    }

    if (event.author !== 'user' && event.author !== requireAgent(ctx).name) {
      event = presentAsUserMessage(ctx, event);
    }

    if (
      !event.content ||
      !event.content.parts ||
      event.content.parts.length === 0
    ) {
      continue;
    }

    const parts = toA2AParts(event.content.parts, event.longRunningToolIds);
    missingParts.push(...parts);
  }

  return {
    parts: missingParts,
    contextId,
  };
}

/**
 * Wraps an agent event as a user message so it can be sent as context to a
 * remote agent that only accepts user-role messages.
 *
 * @param ctx - The current invocation context.
 * @param agentEvent - The agent-authored event to reframe as a user message.
 * @returns A new event with `author: 'user'` whose parts summarise the
 *   original agent event's text, function calls, and function responses.
 */
export function presentAsUserMessage(
  ctx: InvocationContext,
  agentEvent: AdkEvent,
): AdkEvent {
  const event = createEvent({
    author: 'user',
    invocationId: ctx.invocationId,
  });

  if (!agentEvent.content || !agentEvent.content.parts) {
    return event;
  }

  const parts: GenAIPart[] = [{text: 'For context:'}];

  for (const part of agentEvent.content.parts) {
    if (part.thought) {
      continue;
    }

    if (part.text) {
      parts.push({
        text: `[${agentEvent.author}] said: ${part.text}`,
      });
    } else if (part.functionCall) {
      const call = part.functionCall;
      parts.push({
        text: `[${agentEvent.author}] called tool ${call.name} with parameters: ${JSON.stringify(call.args)}`,
      });
    } else if (part.functionResponse) {
      const resp = part.functionResponse;
      parts.push({
        text: `[${agentEvent.author}] ${resp.name} tool returned result: ${JSON.stringify(resp.response)}`,
      });
    } else {
      parts.push(part);
    }
  }

  if (parts.length > 1) {
    event.content = {
      role: 'user',
      parts,
    };
  }

  return event;
}
