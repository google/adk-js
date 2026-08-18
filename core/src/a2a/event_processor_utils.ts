/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Task, TaskStatusUpdateEvent} from '@a2a-js/sdk';
import {Content as GenAIContent, Part as GenAIPart} from '@google/genai';
import {Event as AdkEvent} from '../events/event.js';
import {createEventActions} from '../events/event_actions.js';
import {
  createInputMissingErrorEvent,
  createTaskCompletedEvent,
  createTaskFailedEvent,
  createTaskInputRequiredEvent,
  isInputRequiredTaskStatusUpdateEvent,
} from './a2a_event.js';
import {ExecutorContext} from './executor_context.js';
import {
  getA2AEventMetadata,
  getA2AEventMetadataFromActions,
  getA2ASessionMetadata,
} from './metadata_converter_utils.js';
import {toA2AParts, toGenAIParts} from './part_converter_utils.js';

/**
 * Processes a list of ADK events and determines the final task status update event.
 * If any of the ADK events contain an error, a TaskFailedEvent is returned immediately.
 * If there are no errors, it checks for any input required events. If found, it returns a TaskInputRequiredEvent.
 * If there are no input required events, it returns a TaskCompletedEvent.
 *
 * @param adkEvents - The list of ADK events to process.
 * @param context - The executor context containing relevant information for processing the events.
 * @returns A TaskStatusUpdateEvent representing the final status of the task after processing the ADK events.
 */
export function getFinalTaskStatusUpdate(
  adkEvents: AdkEvent[],
  context: ExecutorContext,
): TaskStatusUpdateEvent {
  const finalEventActions = createEventActions();

  for (const adkEvent of adkEvents) {
    if (adkEvent.errorCode || adkEvent.errorMessage) {
      return createTaskFailedEvent({
        taskId: context.requestContext.taskId,
        contextId: context.requestContext.contextId,
        error: new Error(adkEvent.errorMessage || adkEvent.errorCode),
        metadata: {
          ...getA2AEventMetadata(adkEvent, context),
          ...getA2AEventMetadataFromActions(finalEventActions),
        },
      });
    }

    finalEventActions.escalate =
      finalEventActions.escalate || adkEvent.actions?.escalate;

    if (adkEvent.actions?.transferToAgent) {
      finalEventActions.transferToAgent = adkEvent.actions.transferToAgent;
    }
  }

  const inputRequiredEvent = scanForInputRequiredEvents(adkEvents, context);
  if (inputRequiredEvent) {
    return {
      ...inputRequiredEvent,
      metadata: {
        ...inputRequiredEvent.metadata,
        ...getA2AEventMetadataFromActions(finalEventActions),
      },
    };
  }

  return createTaskCompletedEvent({
    taskId: context.requestContext.taskId,
    contextId: context.requestContext.contextId,
    metadata: {
      ...getA2ASessionMetadata(context),
      ...getA2AEventMetadataFromActions(finalEventActions),
    },
  });
}

function scanForInputRequiredEvents(
  adkEvents: AdkEvent[],
  context: ExecutorContext,
): TaskStatusUpdateEvent | undefined {
  const inputRequiredParts: GenAIPart[] = [];
  const inputRequiredFunctionCallIds = new Set<string>();

  for (const adkEvent of adkEvents) {
    if (!adkEvent.content?.parts?.length) {
      continue;
    }

    for (const genAIPart of adkEvent.content.parts) {
      const longRunningFunctionCallId = getLongRunnningFunctionCallId(
        genAIPart,
        adkEvent.longRunningToolIds,
        inputRequiredParts,
      );
      if (!longRunningFunctionCallId) {
        continue;
      }

      const isAlreadyAdded = inputRequiredFunctionCallIds.has(
        longRunningFunctionCallId,
      );
      if (isAlreadyAdded) {
        continue;
      }

      inputRequiredParts.push(genAIPart);
      inputRequiredFunctionCallIds.add(longRunningFunctionCallId);
    }
  }

  if (inputRequiredParts.length > 0) {
    return createTaskInputRequiredEvent({
      taskId: context.requestContext.taskId,
      contextId: context.requestContext.contextId,
      parts: toA2AParts(inputRequiredParts, [...inputRequiredFunctionCallIds]),
      metadata: getA2ASessionMetadata(context),
    });
  }

  return undefined;
}

function getLongRunnningFunctionCallId(
  genAIPart: GenAIPart,
  longRunningToolIds: string[] = [],
  inputRequiredParts: GenAIPart[] = [],
): string | undefined {
  const functionCallId = genAIPart.functionCall?.id;
  const functionResponseId = genAIPart.functionResponse?.id;
  if (!functionCallId && !functionResponseId) {
    return;
  }

  if (functionCallId && longRunningToolIds.includes(functionCallId)) {
    return functionCallId;
  }

  if (functionResponseId && longRunningToolIds.includes(functionResponseId)) {
    return functionResponseId;
  }

  for (const part of inputRequiredParts) {
    if (part.functionCall?.id === functionResponseId) {
      return functionResponseId;
    }
  }

  return;
}

/**
 * Returns an input-required status update when the incoming message leaves a
 * pending request unanswered.
 *
 * A pause belongs to the conversation, not to the task that happened to raise
 * it: the ADK session is keyed by `contextId`, and a client picks its own task
 * ids. Scoping this to `ctx.task` alone let a caller step around an open gate
 * by starting a new task in the same context and going on talking to an agent
 * that is supposed to be waiting on a human. Pending requests are therefore
 * read from the session as well as from the task, and each one has to be
 * answered before the agent runs again.
 */
export function getUnansweredRequestEvent(options: {
  taskId: string;
  contextId: string;
  task?: Task;
  sessionEvents: AdkEvent[];
  genAIContent: GenAIContent;
}): TaskStatusUpdateEvent | undefined {
  const {taskId, contextId, task, sessionEvents, genAIContent} = options;
  const pending = pendingRequestParts(task, sessionEvents);

  const answered = new Set(
    (genAIContent?.parts ?? [])
      .map((part) => part.functionResponse?.id)
      .filter((id): id is string => !!id),
  );
  const missingId = [...pending.keys()].find((id) => !answered.has(id));
  if (!missingId) {
    return undefined;
  }

  return createInputMissingErrorEvent({
    taskId: task?.id ?? taskId,
    contextId: task?.contextId ?? contextId,
    parts: [
      ...toA2AParts([...pending.values()]),
      {
        kind: 'text',
        text: `No input provided for function call id ${missingId}`,
        metadata: {
          validation_error: true,
        },
      },
    ],
  });
}

/**
 * The requests still awaiting an answer, by function call id: the ones the task
 * is showing, plus every long-running call in the session with no response.
 */
function pendingRequestParts(
  task: Task | undefined,
  sessionEvents: AdkEvent[],
): Map<string, GenAIPart> {
  const pending = new Map<string, GenAIPart>();

  if (
    task &&
    isInputRequiredTaskStatusUpdateEvent(task) &&
    task.status.message
  ) {
    for (const part of toGenAIParts(task.status.message.parts)) {
      if (part.functionCall?.id) {
        pending.set(part.functionCall.id, part);
      }
    }
  }

  const answered = new Set<string>();
  for (const event of sessionEvents) {
    for (const part of event.content?.parts ?? []) {
      if (part.functionResponse?.id) {
        answered.add(part.functionResponse.id);
      }
    }
  }

  for (const event of sessionEvents) {
    for (const part of event.content?.parts ?? []) {
      const id = part.functionCall?.id;
      if (id && event.longRunningToolIds?.includes(id)) {
        pending.set(id, part);
      }
    }
  }

  for (const id of answered) {
    pending.delete(id);
  }
  return pending;
}
