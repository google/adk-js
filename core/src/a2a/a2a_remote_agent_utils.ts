/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart} from '@a2a-js/sdk';
import {Part as GenAIPart} from '@google/genai';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event as AdkEvent, createEvent} from '../events/event.js';
import {Session} from '../sessions/session.js';
import {AdkMetadataKeys} from './metadata_converter_utils.js';
import {toA2AParts} from './part_converter_utils.js';

export interface UserFunctionCall {
  response: AdkEvent;
  taskId: string;
  contextId: string;
}

/**
 * Returns a UserFunctionCall when the event at index has a FunctionResponse.
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
 * Returns content parts for all events not present in the remote session
 * and a2a contextId if found in a remote agent event metadata.
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
    if (event.author === ctx.agent.name) {
      lastRemoteResponseIndex = i;
      const metadata = event.customMetadata || {};
      contextId = metadata[AdkMetadataKeys.CONTEXT_ID] as string;
      break;
    }
  }

  const missingParts: A2APart[] = [];

  for (let i = lastRemoteResponseIndex + 1; i < events.length; i++) {
    let event = events[i];
    if (event.author !== 'user' && event.author !== ctx.agent.name) {
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
 * Wraps an agent event as a user message for context.
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
