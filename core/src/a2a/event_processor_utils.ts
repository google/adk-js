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
 * Returns input required task status update events if the provided user request does not contain responses for all function calls in the task status.
 */
export function getTaskInputRequiredEvent(
  task: Task,
  genAIContent: GenAIContent,
): TaskStatusUpdateEvent | undefined {
  if (
    !task ||
    !isInputRequiredTaskStatusUpdateEvent(task) ||
    !task.status.message
  ) {
    return undefined;
  }

  const statusMsg = task.status.message;
  const taskParts = toGenAIParts(statusMsg.parts);

  for (const taskPart of taskParts) {
    const functionCallId = taskPart.functionCall?.id;
    if (!functionCallId) {
      continue;
    }

    const hasMatchingResponse = (genAIContent?.parts || []).some(
      (p) => p.functionResponse?.id === functionCallId,
    );

    if (!hasMatchingResponse) {
      return createInputMissingErrorEvent({
        taskId: task.id,
        contextId: task.contextId,
        parts: [
          ...statusMsg.parts.filter((p) => !p.metadata?.validation_error),
          {
            kind: 'text',
            text: `No input provided for function call id ${functionCallId}`,
            metadata: {
              validation_error: true,
            },
          },
        ],
      });
    }
  }

  return undefined;
}
