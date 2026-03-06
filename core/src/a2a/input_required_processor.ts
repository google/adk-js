/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Task, TaskStatusUpdateEvent} from '@a2a-js/sdk';
import {Content as GenAIContent} from '@google/genai';
import {
  createInputMissingErrorEvent,
  isInputRequiredTaskStatusUpdateEvent,
} from './a2a_event.js';
import {toGenAIParts} from './part_converter_utils.js';

// export function scanForInputRequiredEvents(
//   adkEvents: AdkEvent[],
//   reqCtx: RequestContext,
// ): TaskStatusUpdateEvent | undefined {
//   const inputRequiredParts: GenAIPart[] = [];
//   const inputRequiredFunctionCallIds = new Set<string>();

//   for (const adkEvent of adkEvents) {
//     if (!adkEvent.content?.parts?.length) {
//       continue;
//     }

//     for (const genAIPart of adkEvent.content.parts) {
//       const longRunningFunctionCallId = getLongRunnningFunctionCallId(
//         genAIPart,
//         adkEvent.longRunningToolIds,
//         inputRequiredParts,
//       );
//       if (!longRunningFunctionCallId) {
//         continue;
//       }

//       const isAlreadyAdded = inputRequiredFunctionCallIds.has(
//         longRunningFunctionCallId,
//       );
//       if (isAlreadyAdded) {
//         continue;
//       }

//       inputRequiredParts.push(genAIPart);
//       inputRequiredFunctionCallIds.add(longRunningFunctionCallId);
//     }
//   }

//   if (inputRequiredParts.length > 0) {
//     return createTaskInputRequiredEvent({
//       taskId: reqCtx.taskId,
//       contextId: reqCtx.contextId,
//       parts: toA2AParts(inputRequiredParts),
//     });
//   }

//   return undefined;
// }

// function getLongRunnningFunctionCallId(
//   genAIPart: GenAIPart,
//   longRunningToolIds: string[] = [],
//   functionParts: GenAIPart[] = [],
// ): string | undefined {
//   const functionCallId = genAIPart.functionCall?.id;
//   const functionResponseId = genAIPart.functionResponse?.id;
//   if (!functionCallId && !functionResponseId) {
//     return;
//   }

//   if (functionCallId && longRunningToolIds.includes(functionCallId)) {
//     return functionCallId;
//   }

//   if (functionResponseId && longRunningToolIds.includes(functionResponseId)) {
//     return functionResponseId;
//   }

//   for (const part of functionParts) {
//     if (part.functionCall?.id === functionResponseId) {
//       return functionResponseId;
//     }
//   }

//   return;
// }

// /**
//  * InputRequiredProcessor handles long-running function tool calls by accumulating them.
//  */
// export class InputRequiredProcessor {
//   event?: TaskStatusUpdateEvent;
//   private addedParts: GenAIPart[] = [];

//   constructor(private readonly requestContext: RequestContext) {}

//   /**
//    * Processes the event to handle long-running tool calls.
//    */
//   process(adkEvent: AdkEvent): AdkEvent {
//     if (!adkEvent.content?.parts?.length) {
//       return adkEvent;
//     }

//     const longRunningCallIDs: string[] = [];
//     const inputRequiredParts: GenAIPart[] = [];
//     const remainingParts: GenAIPart[] = [];

//     for (const genAIPart of adkEvent.content.parts) {
//       let functionCallId: string | undefined;
//       if (
//         genAIPart.functionCall?.id &&
//         adkEvent.longRunningToolIds?.includes(genAIPart.functionCall.id)
//       ) {
//         functionCallId = genAIPart.functionCall.id;
//       } else if (isLongRunningResponse(adkEvent, this.event, genAIPart)) {
//         functionCallId = genAIPart.functionResponse?.id || '';
//       }

//       if (!functionCallId) {
//         remainingParts.push(genAIPart);
//         continue;
//       }

//       const isAlreadyAdded = this.addedParts.some((p) => {
//         if (
//           genAIPart.functionCall &&
//           p.functionCall &&
//           genAIPart.functionCall.id === p.functionCall.id
//         ) {
//           return true;
//         }
//         return !!(
//           genAIPart.functionResponse &&
//           p.functionResponse &&
//           genAIPart.functionResponse.id === p.functionResponse.id
//         );
//       });

//       if (isAlreadyAdded) {
//         continue;
//       }

//       this.addedParts.push(genAIPart);
//       inputRequiredParts.push(genAIPart);
//       longRunningCallIDs.push(functionCallId);
//     }

//     if (inputRequiredParts.length > 0) {
//       const a2aParts = toA2AParts(inputRequiredParts);

//       if (this.event && this.event.status.message) {
//         this.event.status.message.parts.push(...a2aParts);
//       } else {
//         this.event = createTaskInputRequiredEvent({
//           taskId: this.requestContext.taskId,
//           contextId: this.requestContext.contextId,
//           parts: a2aParts,
//         });
//       }
//     }

//     if (remainingParts.length === adkEvent.content.parts.length) {
//       return adkEvent;
//     }

//     // Clone event and update content parts
//     const modifiedEvent = cloneDeep(adkEvent);
//     if (modifiedEvent.content) {
//       modifiedEvent.content = {...modifiedEvent.content, parts: remainingParts};
//     }

//     return modifiedEvent;
//   }
// }

// function isLongRunningResponse(
//   adkEvent: AdkEvent,
//   a2aEvent: TaskStatusUpdateEvent | undefined,
//   part: GenAIPart,
// ): boolean {
//   if (!part.functionResponse?.id) {
//     return false;
//   }
//   const id = part.functionResponse.id;
//   if (adkEvent.longRunningToolIds?.includes(id)) {
//     return true;
//   }

//   if (!a2aEvent || !a2aEvent.status.message) {
//     return false;
//   }

//   for (const part of a2aEvent.status.message.parts) {
//     const genAIPart = toGenAIPart(part);

//     if (genAIPart.functionCall?.id === id) {
//       return true;
//     }
//   }

//   return false;
// }

/**
 * Handles input required task status update events.
 */
export function handleInputRequired(
  task: Task,
  userRequest: GenAIContent,
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

    const hasMatchingResponse = (userRequest?.parts || []).some(
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
