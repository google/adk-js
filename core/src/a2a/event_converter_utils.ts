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
import {Part} from '@google/genai';
import {Event, createEvent} from '../events/event.js';
import {EventActions, createEventActions} from '../events/event_actions.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {toA2AParts, toGenAIParts} from './part_converter_utils.js';

type A2AEvent =
  | Task
  | Message
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent;

enum A2AMetadataKeys {
  PARTIAL = 'a2a:partial',
  TASK_ID = 'a2a:task_id',
  CONTEXT_ID = 'a2a:context_id',
  ESCALATE = 'a2a:escalate',
  TRANSFER_TO_AGENT = 'a2a:transfer_to_agent',
  LONG_RUNNING = 'a2a:is_long_running',
  THOUGHT = 'a2a:thought',
}

const ROLE_USER = 'user';
const ROLE_MODEL = 'model';

/**
 * Converts a session Event to an A2A Message.
 */
export function toA2AMessage(event?: Event): Message | undefined {
  if (!event) {
    return undefined;
  }

  return {
    kind: 'message',
    messageId: randomUUID(),
    role: event.author === ROLE_USER ? 'user' : 'agent',
    parts: toA2AParts(event.content?.parts || [], event.longRunningToolIds),
    metadata: {
      ...toActionsMeta(event.actions),
      ...(event.customMetadata || {}),
    },
  };
}

/**
 * Converts an A2A Event to a Session Event.
 */
export function toAdkEvent(
  event: A2AEvent | unknown,
  invocationId: string,
  agentName: string,
): Event | undefined {
  if (isTaskStatusUpdateEvent(event)) {
    if (event.final) {
      return finalTaskStatusUpdateToEvent(event, invocationId, agentName);
    }
    if (!event.status.message) {
      return undefined;
    }
    return messageToEvent(event.status.message, invocationId, agentName, event);
  }

  if (isMessage(event)) {
    return messageToEvent(event, invocationId, agentName);
  }

  if (isTaskArtifactUpdateEvent(event)) {
    return artifactUpdateToEvent(event, invocationId, agentName);
  }

  if (isTask(event)) {
    return taskToEvent(event, invocationId, agentName);
  }

  return undefined;
}

function isTaskStatusUpdateEvent(
  event: unknown,
): event is TaskStatusUpdateEvent {
  return (event as TaskStatusUpdateEvent)?.kind === 'status-update';
}

function isTaskArtifactUpdateEvent(
  event: unknown,
): event is TaskArtifactUpdateEvent {
  return (event as TaskArtifactUpdateEvent)?.kind === 'artifact-update';
}

function isMessage(event: unknown): event is Message {
  return (event as Message)?.kind === 'message';
}

function isTask(event: unknown): event is Task {
  return (event as Task)?.kind === 'task';
}

function messageToEvent(
  msg: Message,
  invocationId: string,
  agentName: string,
  parentEvent?: TaskStatusUpdateEvent,
): Event {
  const parts = toGenAIParts(msg.parts);
  const event = createEvent({
    invocationId,
    author: msg.role === ROLE_USER ? ROLE_USER : agentName,
  });

  if (parts.length > 0) {
    event.content = {
      role: msg.role === ROLE_USER ? ROLE_USER : ROLE_MODEL,
      parts,
    };
  }

  if (parentEvent && !parentEvent.final) {
    event.partial = true;

    for (const part of event.content?.parts || []) {
      (part as Record<string, unknown>)[A2AMetadataKeys.THOUGHT] = true;
    }
  }

  const metaSource = parentEvent || msg;
  processA2AMeta(metaSource, event);

  event.turnComplete = !parentEvent || !!parentEvent.final;
  if (parentEvent && !parentEvent.final) {
    event.turnComplete = false;
  }

  if (msg.role === ROLE_USER) {
    event.turnComplete = true;
  }

  return event;
}

function artifactUpdateToEvent(
  event: TaskArtifactUpdateEvent,
  invocationId: string,
  agentName: string,
): Event | undefined {
  const partsToConvert = event.artifact?.parts || [];
  if (partsToConvert.length === 0) {
    return undefined;
  }

  const parts = toGenAIParts(partsToConvert);

  const sessionEvent = createEvent({
    invocationId,
    author: agentName,
    content: {role: ROLE_MODEL, parts},
  });

  sessionEvent.longRunningToolIds = getLongRunningToolIDs(
    partsToConvert,
    parts,
  );

  processA2AMeta(event, sessionEvent);

  if (event.artifact?.metadata?.[A2AMetadataKeys.PARTIAL]) {
    sessionEvent.partial = true;
  } else {
    sessionEvent.partial = true;
  }

  return sessionEvent;
}

function finalTaskStatusUpdateToEvent(
  update: TaskStatusUpdateEvent,
  invocationId: string,
  agentName: string,
): Event | undefined {
  const event = createEvent({
    invocationId,
    author: agentName,
  });

  let parts: Part[] = [];
  if (update.status.message) {
    parts = toGenAIParts(update.status.message.parts);
  }

  if (update.status.state === 'failed' && parts.length === 1 && parts[0].text) {
    event.errorMessage = parts[0].text;
  } else if (parts.length > 0) {
    event.content = {role: ROLE_MODEL, parts};
  }

  processA2AMeta(update, event);

  if (update.status.message) {
    event.longRunningToolIds = getLongRunningToolIDs(
      update.status.message.parts,
      parts,
    );
  }

  event.turnComplete = true;

  return event;
}

function taskToEvent(
  task: Task,
  invocationId: string,
  agentName: string,
): Event | undefined {
  const event = createEvent({
    invocationId,
    author: agentName,
  });

  let parts: Part[] = [];
  let longRunningToolIds: string[] = [];

  if (task.artifacts) {
    for (const artifact of task.artifacts) {
      if (artifact.parts) {
        const artifactParts = toGenAIParts(artifact.parts);
        parts = [...parts, ...artifactParts];
        longRunningToolIds = [
          ...longRunningToolIds,
          ...getLongRunningToolIDs(artifact.parts, artifactParts),
        ];
      }
    }
  }

  if (task.status?.message) {
    const msgParts = toGenAIParts(task.status.message.parts);

    if (
      task.status.state === 'failed' &&
      msgParts.length === 1 &&
      msgParts[0].text
    ) {
      event.errorMessage = msgParts[0].text;
    } else {
      parts = [...parts, ...msgParts];
    }
    longRunningToolIds = [
      ...longRunningToolIds,
      ...getLongRunningToolIDs(task.status.message.parts, msgParts),
    ];
  }

  const isTerminal =
    task.status?.state === 'completed' ||
    task.status?.state === 'failed' ||
    task.status?.state === 'input-required' ||
    task.status?.state === 'canceled';

  if (parts.length === 0 && !isTerminal) {
    return undefined;
  }

  if (parts.length > 0) {
    event.content = {role: ROLE_MODEL, parts};
  }

  if (task.status?.state === 'input-required') {
    event.longRunningToolIds = longRunningToolIds;
  }

  processA2AMeta(task, event);
  event.turnComplete = isTerminal;

  return event;
}

function processA2AMeta(
  source: {metadata?: Record<string, unknown>},
  event: Event,
) {
  if (!source.metadata) {
    return;
  }

  if (source.metadata[A2AMetadataKeys.ESCALATE]) {
    if (!event.actions) {
      event.actions = createEventActions();
    }

    event.actions.escalate = true;
  }
  if (source.metadata[A2AMetadataKeys.TRANSFER_TO_AGENT]) {
    if (!event.actions) {
      event.actions = createEventActions();
    }

    event.actions.transferToAgent = source.metadata[
      A2AMetadataKeys.TRANSFER_TO_AGENT
    ] as string;
  }

  const taskId = source.metadata[A2AMetadataKeys.TASK_ID] as string;
  const contextId = source.metadata[A2AMetadataKeys.CONTEXT_ID] as string;

  if (taskId || contextId) {
    if (!event.customMetadata) {
      event.customMetadata = {};
    }

    if (taskId) {
      event.customMetadata[A2AMetadataKeys.TASK_ID] = taskId;
    }

    if (contextId) {
      event.customMetadata[A2AMetadataKeys.CONTEXT_ID] = contextId;
    }
  }
}

function toActionsMeta(actions: EventActions): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (actions.escalate) {
    meta[A2AMetadataKeys.ESCALATE] = true;
  }

  if (actions.transferToAgent) {
    meta[A2AMetadataKeys.TRANSFER_TO_AGENT] = actions.transferToAgent;
  }

  return meta;
}

function getLongRunningToolIDs(parts: A2APart[], converted: Part[]): string[] {
  const ids: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.metadata && p.metadata[A2AMetadataKeys.LONG_RUNNING]) {
      const fnCall = converted[i];
      if (fnCall.functionCall && fnCall.functionCall.name) {
        ids.push(fnCall.functionCall.name);
      }
    }
  }

  return ids;
}
