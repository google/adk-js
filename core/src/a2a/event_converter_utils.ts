/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Part as A2APart,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {
  createModelContent,
  createUserContent,
  Part as GenAIPart,
} from '@google/genai';
import {Event as AdkEvent} from '../events/event.js';
import {
  A2AEvent,
  createMessage,
  getEventMetadata,
  getFailedTaskStatusUpdateEventError,
  isFailedTaskStatusUpdateEvent,
  isInputRequiredTaskStatusUpdateEvent,
  isMessage,
  isTask,
  isTaskArtifactUpdateEvent,
  isTaskStatusUpdateEvent,
  isTerminalTaskStatusUpdateEvent,
  MessageRole,
} from './a2a_event.js';
import {
  A2AMetadataKeys,
  getA2AEventMetadata,
  getAdkEventFromMetadata,
} from './metadata_converter_utils.js';
import {
  toA2AParts,
  toGenAIPart,
  toGenAIParts,
  A2APartMetadataKeys,
} from './part_converter_utils.js';

/**
 * Converts a session Event to an A2A Message.
 */
export function toA2AMessage(
  event: AdkEvent,
  {
    appName,
    userId,
    sessionId,
  }: {appName: string; userId: string; sessionId: string},
): Message {
  return createMessage({
    role:
      event.author === MessageRole.USER ? MessageRole.USER : MessageRole.AGENT,
    parts: toA2AParts(event.content?.parts, event.longRunningToolIds),
    metadata: getA2AEventMetadata(event, {appName, userId, sessionId}),
  });
}

/**
 * Converts an A2A Event to a Session Event.
 */
export function toAdkEvent(
  event: A2AEvent,
  invocationId: string,
  agentName: string,
): AdkEvent | undefined {
  if (isMessage(event)) {
    return messageToAdkEvent(event, invocationId, agentName);
  }

  if (isTask(event)) {
    return taskToAdkEvent(event, invocationId, agentName);
  }

  if (isTaskArtifactUpdateEvent(event)) {
    return artifactUpdateToAdkEvent(event, invocationId, agentName);
  }

  if (isTaskStatusUpdateEvent(event)) {
    return event.final
      ? finalTaskStatusUpdateToAdkEvent(event, invocationId, agentName)
      : taskStatusUpdateToAdkEvent(event, invocationId, agentName);
  }

  return undefined;
}

function messageToAdkEvent(
  msg: Message,
  invocationId: string,
  agentName: string,
  parentEvent?: TaskStatusUpdateEvent,
): AdkEvent {
  const parts = toGenAIParts(msg.parts);

  return {
    ...getAdkEventFromMetadata(parentEvent || msg),
    invocationId,
    author: msg.role === MessageRole.USER ? MessageRole.USER : agentName,
    content:
      msg.role === MessageRole.USER
        ? createUserContent(parts)
        : createModelContent(parts),
    turnComplete: true,
    partial: false,
  };
}

function artifactUpdateToAdkEvent(
  a2aEvent: TaskArtifactUpdateEvent,
  invocationId: string,
  agentName: string,
): AdkEvent | undefined {
  const partsToConvert = a2aEvent.artifact?.parts || [];
  if (partsToConvert.length === 0) {
    return undefined;
  }

  const partial =
    !!getEventMetadata(a2aEvent)[A2AMetadataKeys.PARTIAL] ||
    a2aEvent.append ||
    !a2aEvent.lastChunk;

  return {
    ...getAdkEventFromMetadata(a2aEvent),
    invocationId,
    author: agentName,
    content: createModelContent(toGenAIParts(partsToConvert)),
    longRunningToolIds: getLongRunningToolIds(partsToConvert),
    partial,
  };
}

function finalTaskStatusUpdateToAdkEvent(
  a2aEvent: TaskStatusUpdateEvent,
  invocationId: string,
  agentName: string,
): AdkEvent | undefined {
  const partsToConvert = a2aEvent.status.message?.parts || [];
  if (partsToConvert.length === 0) {
    return undefined;
  }

  const parts = toGenAIParts(partsToConvert);
  const isFailedTask = isFailedTaskStatusUpdateEvent(a2aEvent);
  const hasContent = !isFailedTask && parts.length > 0;

  return {
    ...getAdkEventFromMetadata(a2aEvent),
    invocationId,
    author: agentName,
    errorMessage: isFailedTask
      ? getFailedTaskStatusUpdateEventError(a2aEvent)
      : undefined,
    content: hasContent ? createModelContent(parts) : undefined,
    turnComplete: true,
  };
}

function taskStatusUpdateToAdkEvent(
  a2aEvent: TaskStatusUpdateEvent,
  invocationId: string,
  agentName: string,
): AdkEvent | undefined {
  const msg = a2aEvent.status.message;
  if (!msg) {
    return undefined;
  }

  const parts = toGenAIParts(msg.parts);

  return {
    ...getAdkEventFromMetadata(a2aEvent),
    invocationId,
    author: agentName,
    content: createModelContent(parts),
    turnComplete: false,
    partial: true,
  };
}

function taskToAdkEvent(
  a2aTask: Task,
  invocationId: string,
  agentName: string,
): AdkEvent | undefined {
  const parts: GenAIPart[] = [];
  const longRunningToolIds: string[] = [];

  if (a2aTask.artifacts) {
    for (const artifact of a2aTask.artifacts) {
      if (artifact.parts?.length > 0) {
        const artifactParts = toGenAIParts(artifact.parts);
        parts.push(...artifactParts);
        longRunningToolIds.push(...getLongRunningToolIds(artifact.parts));
      }
    }
  }

  if (a2aTask.status?.message) {
    const a2aParts = a2aTask.status.message.parts;
    const genAIParts = toGenAIParts(a2aParts);

    parts.push(...genAIParts);
    longRunningToolIds.push(...getLongRunningToolIds(a2aParts));
  }

  const isTerminal =
    isTerminalTaskStatusUpdateEvent(a2aTask) ||
    isInputRequiredTaskStatusUpdateEvent(a2aTask);
  const isFailed = isFailedTaskStatusUpdateEvent(a2aTask);

  if (parts.length === 0 && !isTerminal) {
    return undefined;
  }

  return {
    ...getAdkEventFromMetadata(a2aTask),
    invocationId,
    author: agentName,
    content: isFailed ? undefined : createModelContent(parts),
    errorMessage: isFailed
      ? getFailedTaskStatusUpdateEventError(a2aTask)
      : undefined,
    longRunningToolIds,
    turnComplete: isTerminal,
  };
}

function getLongRunningToolIds(parts: A2APart[]): string[] {
  const ids: string[] = [];

  for (const a2aPart of parts) {
    if (
      a2aPart.metadata &&
      a2aPart.metadata[A2APartMetadataKeys.IS_LONG_RUNNING]
    ) {
      const genAIPart = toGenAIPart(a2aPart);
      if (genAIPart.functionCall && genAIPart.functionCall.id) {
        ids.push(genAIPart.functionCall.id);
      }
    }
  }

  return ids;
}
