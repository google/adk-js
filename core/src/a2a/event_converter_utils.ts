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
  CitationMetadata,
  createModelContent,
  createUserContent,
  Part as GenAIPart,
  GroundingMetadata,
  UsageMetadata,
} from '@google/genai';
import {Event as AdkEvent, createEvent} from '../events/event.js';
import {createEventActions} from '../events/event_actions.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {
  A2AEvent,
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
} from './metadata_converter_utils.js';
import {toA2AParts, toGenAIPart, toGenAIParts} from './part_converter_utils.js';

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
  return {
    kind: 'message',
    messageId: randomUUID(),
    role:
      event.author === MessageRole.USER ? MessageRole.USER : MessageRole.AGENT,
    parts: toA2AParts(event.content?.parts || [], event.longRunningToolIds),
    metadata: getA2AEventMetadata(event, {appName, userId, sessionId}),
  };
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
    ...createAdkEventFromMetadata(parentEvent || msg),
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
    ...createAdkEventFromMetadata(a2aEvent),
    invocationId,
    author: agentName,
    content: createModelContent(toGenAIParts(partsToConvert)),
    longRunningToolIds: getLongRunningToolIDs(partsToConvert),
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
    ...createAdkEventFromMetadata(a2aEvent),
    invocationId,
    author: agentName,
    errorMessage: isFailedTask
      ? getFailedTaskStatusUpdateEventError(a2aEvent)
      : undefined,
    content: hasContent ? createModelContent(parts) : undefined,
    longRunningToolIds: getLongRunningToolIDs(partsToConvert),
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
    ...createAdkEventFromMetadata(a2aEvent),
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
        longRunningToolIds.push(...getLongRunningToolIDs(artifact.parts));
      }
    }
  }

  if (a2aTask.status?.message) {
    const a2aParts = a2aTask.status.message.parts;
    const genAIParts = toGenAIParts(a2aParts);

    parts.push(...genAIParts);
    longRunningToolIds.push(...getLongRunningToolIDs(a2aParts));
  }

  const isTerminal =
    isTerminalTaskStatusUpdateEvent(a2aTask) ||
    isInputRequiredTaskStatusUpdateEvent(a2aTask);
  const isFailed = isFailedTaskStatusUpdateEvent(a2aTask);

  if (parts.length === 0 && !isTerminal) {
    return undefined;
  }

  return {
    ...createAdkEventFromMetadata(a2aTask),
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

function createAdkEventFromMetadata(a2aEvent: A2AEvent): AdkEvent {
  const metadata = a2aEvent.metadata || {};

  return createEvent({
    branch: metadata[A2AMetadataKeys.BRANCH] as string,
    author: metadata[A2AMetadataKeys.AUTHOR] as string,
    partial: metadata[A2AMetadataKeys.PARTIAL] as boolean,
    errorCode: metadata[A2AMetadataKeys.ERROR_CODE] as string,
    errorMessage: metadata[A2AMetadataKeys.ERROR_MESSAGE] as string,
    citationMetadata: metadata[
      A2AMetadataKeys.CITATION_METADATA
    ] as CitationMetadata,
    groundingMetadata: metadata[
      A2AMetadataKeys.GROUNDING_METADATA
    ] as GroundingMetadata,
    usageMetadata: metadata[A2AMetadataKeys.USAGE_METADATA] as UsageMetadata,
    customMetadata: metadata[A2AMetadataKeys.CUSTOM_METADATA] as Record<
      string,
      unknown
    >,
    actions: createEventActions({
      escalate: !!metadata[A2AMetadataKeys.ESCALATE],
      transferToAgent: metadata[A2AMetadataKeys.TRANSFER_TO_AGENT] as string,
    }),
  });
}

function getLongRunningToolIDs(parts: A2APart[]): string[] {
  const ids: string[] = [];

  for (const a2aPart of parts) {
    if (a2aPart.metadata && a2aPart.metadata[A2AMetadataKeys.IS_LONG_RUNNING]) {
      const genAIPart = toGenAIPart(a2aPart);
      if (genAIPart.functionCall && genAIPart.functionCall.id) {
        ids.push(genAIPart.functionCall.id);
      }
    }
  }

  return ids;
}
