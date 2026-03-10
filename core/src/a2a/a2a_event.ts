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
import {randomUUID} from '../utils/env_aware_utils.js';

/**
 * Message roles.
 */
export enum MessageRole {
  USER = 'user',
  AGENT = 'agent',
}

/**
 * Task states.
 */
export enum TaskState {
  SUBMITTED = 'submitted',
  WORKING = 'working',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELED = 'canceled',
  REJECTED = 'rejected',
  INPUT_REQUIRED = 'input-required',
}

/**
 * A2A event.
 */
export type A2AEvent =
  | Task
  | Message
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent;

/**
 * Checks if the event is an A2A TaskStatusUpdateEvent.
 */
export function isTaskStatusUpdateEvent(
  event: unknown,
): event is TaskStatusUpdateEvent {
  return (event as TaskStatusUpdateEvent)?.kind === 'status-update';
}

/**
 * Checks if the event is an A2A TaskArtifactUpdateEvent.
 */
export function isTaskArtifactUpdateEvent(
  event: unknown,
): event is TaskArtifactUpdateEvent {
  return (event as TaskArtifactUpdateEvent)?.kind === 'artifact-update';
}

/**
 * Checks if the event is an A2A Message.
 */
export function isMessage(event: unknown): event is Message {
  return (event as Message)?.kind === 'message';
}

/**
 * Checks if the event is an A2A Task.
 */
export function isTask(event: unknown): event is Task {
  return (event as Task)?.kind === 'task';
}

/**
 * Gets the metadata from an A2A event.
 */
export function getEventMetadata(event: A2AEvent): Record<string, unknown> {
  if (isTaskArtifactUpdateEvent(event)) {
    return event.artifact.metadata || {};
  }

  if (isTaskStatusUpdateEvent(event) || isTask(event) || isMessage(event)) {
    return event.metadata || {};
  }

  return {};
}

/**
 * Checks if the event is a failed task status update event.
 */
export function isFailedTaskStatusUpdateEvent(event: unknown): boolean {
  return (
    (isTaskStatusUpdateEvent(event) || isTask(event)) &&
    event.status.state === TaskState.FAILED
  );
}

/**
 * Checks if the event is a terminal task status update event.
 */
export function isTerminalTaskStatusUpdateEvent(event: unknown): boolean {
  return (
    (isTaskStatusUpdateEvent(event) || isTask(event)) &&
    [
      TaskState.COMPLETED,
      TaskState.FAILED,
      TaskState.CANCELED,
      TaskState.REJECTED,
    ].includes(event.status.state as TaskState)
  );
}

/**
 * Checks if the event is an input required task status update event.
 */
export function isInputRequiredTaskStatusUpdateEvent(event: unknown): boolean {
  return (
    (isTaskStatusUpdateEvent(event) || isTask(event)) &&
    event.status.state === TaskState.INPUT_REQUIRED
  );
}

/**
 * Gets the error message from a failed task status update event.
 */
export function getFailedTaskStatusUpdateEventError(
  event: TaskStatusUpdateEvent | Task,
): string | undefined {
  if (!isFailedTaskStatusUpdateEvent(event)) {
    return undefined;
  }

  const parts = event.status.message?.parts || [];
  if (parts.length === 0) {
    return undefined;
  }

  if (parts[0].kind !== 'text') {
    return undefined;
  }

  return parts[0].text;
}

/**
 * Creates a task submitted event.
 */
export function createTaskSubmittedEvent({
  taskId,
  contextId,
  message,
  metadata,
}: {
  taskId: string;
  contextId: string;
  message: Message;
  metadata?: Record<string, unknown>;
}): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    final: false,
    status: {
      state: TaskState.SUBMITTED,
      message,
      timestamp: new Date().toISOString(),
    },
    metadata,
  };
}

/**
 * Creates a task with submitted status.
 */
export function createTask({
  contextId,
  message,
  taskId,
  metadata,
}: {
  taskId: string;
  contextId: string;
  message: Message;
  metadata?: Record<string, unknown>;
}): Task {
  return {
    kind: 'task',
    id: taskId || randomUUID(),
    contextId,
    history: [message],
    status: {
      state: TaskState.SUBMITTED,
      timestamp: new Date().toISOString(),
    },
    metadata,
  };
}

/**
 * Creates a task working event.
 */
export function createTaskWorkingEvent({
  taskId,
  contextId,
  message,
  metadata,
}: {
  taskId: string;
  contextId: string;
  message?: Message;
  metadata?: Record<string, unknown>;
}): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    final: false,
    status: {
      state: TaskState.WORKING,
      message,
      timestamp: new Date().toISOString(),
    },
    metadata,
  };
}

/**
 * Creates a task completed event.
 */
export function createTaskCompletedEvent({
  taskId,
  contextId,
  metadata,
}: {
  taskId: string;
  contextId: string;
  metadata?: Record<string, unknown>;
}): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    final: true,
    status: {
      state: TaskState.COMPLETED,
      timestamp: new Date().toISOString(),
    },
    metadata,
  };
}

/**
 * Creates an artifact update event.
 */
export function createTaskArtifactUpdateEvent({
  taskId,
  contextId,
  artifactId,
  parts = [],
  metadata,
  append,
  lastChunk,
}: {
  taskId: string;
  contextId: string;
  artifactId?: string;
  parts?: A2APart[];
  metadata?: Record<string, unknown>;
  append?: boolean;
  lastChunk?: boolean;
}): TaskArtifactUpdateEvent {
  return {
    kind: 'artifact-update',
    taskId,
    contextId,
    append,
    lastChunk,
    artifact: {
      artifactId: artifactId || randomUUID(),
      parts,
    },
    metadata,
  };
}

/**
 * Creates an error message for task execution failure.
 */
export function createTaskFailedEvent({
  taskId,
  contextId,
  error,
  metadata,
}: {
  taskId: string;
  contextId: string;
  error: Error;
  metadata?: Record<string, unknown>;
}): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    final: true,
    status: {
      state: TaskState.FAILED,
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'agent',
        taskId,
        contextId,
        parts: [
          {
            kind: 'text',
            text: error.message,
          },
        ],
      },
      timestamp: new Date().toISOString(),
    },
    metadata,
  };
}

/**
 * Creates an input required event.
 */
export function createTaskInputRequiredEvent({
  taskId,
  contextId,
  parts,
  metadata,
}: {
  taskId: string;
  contextId: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    final: true,
    status: {
      state: TaskState.INPUT_REQUIRED,
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'agent',
        taskId,
        contextId,
        parts,
      },
      timestamp: new Date().toISOString(),
    },
    metadata,
  };
}

/**
 * Creates an error message for missing input for a function call.
 */
export function createInputMissingErrorEvent({
  taskId,
  contextId,
  parts,
  metadata,
}: {
  parts: A2APart[];
  taskId: string;
  contextId: string;
  metadata?: Record<string, unknown>;
}): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    final: true,
    status: {
      state: TaskState.INPUT_REQUIRED,
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'agent',
        taskId,
        contextId,
        parts,
      },
      timestamp: new Date().toISOString(),
    },
    metadata,
  };
}
