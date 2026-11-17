/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Part as A2APart,
  Message,
  Role,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {randomUUID} from '../utils/env_aware_utils.js';

export {Role, TaskState};

/**
 * A2A event: one of the payloads an A2A v1.0 stream carries.
 *
 * A2A v1.0 drops the `kind` discriminator of 0.3: a stream response wraps its
 * payload in a `oneof` instead, and the SDK unwraps a `SendMessage` result into
 * `Message | Task`. The guards below tell the payloads apart by their fields.
 */
export type A2AEvent =
  Task | Message | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks if the event is an A2A TaskStatusUpdateEvent.
 */
export function isTaskStatusUpdateEvent(
  event: unknown,
): event is TaskStatusUpdateEvent {
  return (
    isRecord(event) &&
    typeof event['taskId'] === 'string' &&
    'status' in event &&
    !('artifact' in event) &&
    !('messageId' in event)
  );
}

/**
 * Checks if the event is an A2A TaskArtifactUpdateEvent.
 */
export function isTaskArtifactUpdateEvent(
  event: unknown,
): event is TaskArtifactUpdateEvent {
  return (
    isRecord(event) &&
    typeof event['taskId'] === 'string' &&
    'artifact' in event
  );
}

/**
 * Checks if the event is an A2A Message.
 */
export function isMessage(event: unknown): event is Message {
  return (
    isRecord(event) &&
    typeof event['messageId'] === 'string' &&
    'role' in event &&
    !('status' in event)
  );
}

/**
 * Checks if the event is an A2A Task.
 */
export function isTask(event: unknown): event is Task {
  return (
    isRecord(event) &&
    typeof event['id'] === 'string' &&
    'status' in event &&
    !('taskId' in event)
  );
}

/**
 * Converts an A2A event to its A2A v1.0 JSON form, for example to keep it in
 * the custom metadata of an ADK event, which must stay JSON-serializable.
 */
export function a2aEventToJson(event: A2AEvent): unknown {
  if (isTask(event)) {
    return Task.toJSON(event);
  }
  if (isMessage(event)) {
    return Message.toJSON(event);
  }
  if (isTaskArtifactUpdateEvent(event)) {
    return TaskArtifactUpdateEvent.toJSON(event);
  }
  if (isTaskStatusUpdateEvent(event)) {
    return TaskStatusUpdateEvent.toJSON(event);
  }
  return event;
}

/**
 * Gets the metadata from an A2A event.
 */
export function getEventMetadata(event: A2AEvent): Record<string, unknown> {
  if (isTaskArtifactUpdateEvent(event)) {
    return event.artifact?.metadata || {};
  }

  if (isTaskStatusUpdateEvent(event) || isTask(event) || isMessage(event)) {
    return event.metadata || {};
  }

  return {};
}

const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

function getTaskState(event: unknown): TaskState | undefined {
  if (isTaskStatusUpdateEvent(event) || isTask(event)) {
    return event.status?.state;
  }
  return undefined;
}

/**
 * Checks if the event is a failed task status update event.
 */
export function isFailedTaskStatusUpdateEvent(event: unknown): boolean {
  return getTaskState(event) === TaskState.TASK_STATE_FAILED;
}

/**
 * Checks if the event is a terminal task status update event.
 */
export function isTerminalTaskStatusUpdateEvent(event: unknown): boolean {
  const state = getTaskState(event);
  return state !== undefined && TERMINAL_TASK_STATES.has(state);
}

/**
 * Checks if the event is an input required task status update event.
 */
export function isInputRequiredTaskStatusUpdateEvent(event: unknown): boolean {
  return getTaskState(event) === TaskState.TASK_STATE_INPUT_REQUIRED;
}

/**
 * Checks if the event is an auth required task status update event.
 */
export function isAuthRequiredTaskStatusUpdateEvent(event: unknown): boolean {
  return getTaskState(event) === TaskState.TASK_STATE_AUTH_REQUIRED;
}

/**
 * Checks if a task or task status update is in a state that ends a turn: a
 * terminal state, or a pause for input or a credential.
 */
export function isTurnEndingTaskState(event: unknown): boolean {
  return (
    isTerminalTaskStatusUpdateEvent(event) ||
    isInputRequiredTaskStatusUpdateEvent(event) ||
    isAuthRequiredTaskStatusUpdateEvent(event)
  );
}

/**
 * Checks if the event is the last status update of a turn: a terminal state,
 * or a pause for input or a credential.
 *
 * A2A v1.0 has no `final` flag on a status update: a stream ends when the task
 * reaches a terminal or an interrupted state.
 */
export function isFinalTaskStatusUpdateEvent(event: unknown): boolean {
  return isTaskStatusUpdateEvent(event) && isTurnEndingTaskState(event);
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

  const parts = event.status?.message?.parts || [];
  if (parts.length === 0) {
    return undefined;
  }

  const content = parts[0].content;
  if (content?.$case !== 'text') {
    return undefined;
  }

  return content.value;
}

/**
 * Creates an A2A text part.
 */
export function createTextPart(
  text: string,
  metadata?: Record<string, unknown>,
): A2APart {
  return {
    content: {$case: 'text', value: text},
    metadata,
    filename: '',
    mediaType: '',
  };
}

/**
 * Creates an A2A message, filling the fields it does not set with their
 * defaults.
 */
export function createMessage({
  role,
  parts,
  messageId,
  taskId,
  contextId,
  metadata,
}: {
  role: Role;
  parts: A2APart[];
  messageId?: string;
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}): Message {
  return {
    messageId: messageId || randomUUID(),
    contextId: contextId ?? '',
    taskId: taskId ?? '',
    role,
    parts,
    metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

function createStatusUpdate({
  taskId,
  contextId,
  state,
  message,
  metadata,
}: {
  taskId: string;
  contextId: string;
  state: TaskState;
  message?: Message;
  metadata?: Record<string, unknown>;
}): TaskStatusUpdateEvent {
  return {
    taskId,
    contextId,
    status: {
      state,
      message,
      timestamp: new Date().toISOString(),
    },
    metadata,
  };
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
  return createStatusUpdate({
    taskId,
    contextId,
    state: TaskState.TASK_STATE_SUBMITTED,
    message,
    metadata,
  });
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
    id: taskId || randomUUID(),
    contextId,
    history: [message],
    artifacts: [],
    status: {
      state: TaskState.TASK_STATE_SUBMITTED,
      message: undefined,
      timestamp: new Date().toISOString(),
    },
    metadata,
  };
}

/**
 * Creates a snapshot of an existing task that carries only its id, context and
 * state.
 *
 * An A2A v1.0 stream must open with a `Task` (or a `Message`), so a request
 * that continues an existing task opens its stream with this snapshot. It has
 * no history, artifacts or status message: the task store of `@a2a-js/sdk`
 * merges it into the task it already holds, which keeps its history and
 * artifacts.
 */
export function createTaskSnapshot({
  taskId,
  contextId,
  state,
  metadata,
}: {
  taskId: string;
  contextId: string;
  state: TaskState;
  metadata?: Record<string, unknown>;
}): Task {
  return {
    id: taskId,
    contextId,
    history: [],
    artifacts: [],
    status: {
      state,
      message: undefined,
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
  return createStatusUpdate({
    taskId,
    contextId,
    state: TaskState.TASK_STATE_WORKING,
    message,
    metadata,
  });
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
  return createStatusUpdate({
    taskId,
    contextId,
    state: TaskState.TASK_STATE_COMPLETED,
    metadata,
  });
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
    taskId,
    contextId,
    append: !!append,
    lastChunk: !!lastChunk,
    artifact: {
      artifactId: artifactId || randomUUID(),
      name: '',
      description: '',
      parts,
      metadata: undefined,
      extensions: [],
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
  return createStatusUpdate({
    taskId,
    contextId,
    state: TaskState.TASK_STATE_FAILED,
    message: createMessage({
      role: Role.ROLE_AGENT,
      taskId,
      contextId,
      parts: [createTextPart(error.message)],
    }),
    metadata,
  });
}

/**
 * The options that describe a paused task.
 */
interface TaskPausedEventOptions {
  taskId: string;
  contextId: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

/**
 * Creates an input-required status update.
 *
 * Every reason an agent can pause for input from a human produces this status
 * update: a long-running tool asking for input, and a client message that left
 * an earlier request unanswered. What separates them travels in `parts` — a
 * validation failure carries a text part marked `validation_error` — not in the
 * shape of the event, so both go through here. A run that ends on a pending
 * credential request uses {@link createTaskAuthRequiredEvent} instead.
 */
export function createTaskInputRequiredEvent(
  options: TaskPausedEventOptions,
): TaskStatusUpdateEvent {
  return createTaskPausedEvent(TaskState.TASK_STATE_INPUT_REQUIRED, options);
}

/**
 * Creates an auth-required status update, for a task that waits on a
 * credential.
 */
export function createTaskAuthRequiredEvent(
  options: TaskPausedEventOptions,
): TaskStatusUpdateEvent {
  return createTaskPausedEvent(TaskState.TASK_STATE_AUTH_REQUIRED, options);
}

function createTaskPausedEvent(
  state:
    TaskState.TASK_STATE_INPUT_REQUIRED | TaskState.TASK_STATE_AUTH_REQUIRED,
  {taskId, contextId, parts, metadata}: TaskPausedEventOptions,
): TaskStatusUpdateEvent {
  return createStatusUpdate({
    taskId,
    contextId,
    state,
    message: createMessage({
      role: Role.ROLE_AGENT,
      taskId,
      contextId,
      parts,
    }),
    metadata,
  });
}
