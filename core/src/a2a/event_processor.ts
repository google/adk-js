/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {TaskStatusUpdateEvent} from '@a2a-js/sdk';
import {Part as GenAIPart} from '@google/genai';
import {Event as AdkEvent} from '../events/event.js';
import {createEventActions} from '../events/event_actions.js';
import {
  createTaskCompletedEvent,
  createTaskFailedEvent,
  createTaskInputRequiredEvent,
} from './a2a_event.js';
import {ExecutorContext} from './executor_context.js';
import {
  getA2AEventMetadata,
  getA2AEventMetadataFromActions,
} from './metadata_converter_utils.js';
import {toA2AParts} from './part_converter_utils.js';

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
        metadata: getA2AEventMetadata(adkEvent, {
          appName: context.agentName,
          userId: context.userId,
          sessionId: context.sessionId,
        }),
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
      metadata: getA2AEventMetadataFromActions(finalEventActions),
    };
  }

  return createTaskCompletedEvent({
    taskId: context.requestContext.taskId,
    contextId: context.requestContext.contextId,
    metadata: getA2AEventMetadataFromActions(finalEventActions),
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
      parts: toA2AParts(inputRequiredParts),
    });
  }

  return undefined;
}

function getLongRunnningFunctionCallId(
  genAIPart: GenAIPart,
  longRunningToolIds: string[] = [],
  functionParts: GenAIPart[] = [],
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

  for (const part of functionParts) {
    if (part.functionCall?.id === functionResponseId) {
      return functionResponseId;
    }
  }

  return;
}

// /**
//  * EventProcessor processes ADK events and converts them to A2A events.
//  */
// export class EventProcessor {
//   private readonly inputRequiredProcessor: InputRequiredProcessor;
//   private terminalActions = createEventActions();
//   private failedEvent?: TaskStatusUpdateEvent;
//   private agentPartialArtifactIdsMap: Record<string, string> = {};

//   constructor(private readonly context: ExecutorContext) {
//     this.inputRequiredProcessor = new InputRequiredProcessor(
//       context.requestContext,
//     );
//   }

//   /**
//    * Processes an ADK event and returns an A2A TaskArtifactUpdateEvent if applicable.
//    */
//   process(adkEvent?: AdkEvent): TaskArtifactUpdateEvent | undefined {
//     if (!adkEvent) {
//       return undefined;
//     }

//     this.updateTerminalActions(adkEvent);

//     if (adkEvent.errorCode || adkEvent.errorMessage) {
//       if (!this.failedEvent) {
//         this.failedEvent = createTaskFailedEvent({
//           taskId: this.context.requestContext.taskId,
//           contextId: this.context.requestContext.contextId,
//           error: new Error(adkEvent.errorMessage || adkEvent.errorCode),
//           metadata: getA2AEventMetadataFromActions(this.terminalActions),
//         });
//       }
//     }

//     this.inputRequiredProcessor.process(adkEvent);

//     const parts = toA2AParts(adkEvent.content?.parts);
//     if (parts.length === 0) {
//       return undefined;
//     }

//     const artifactId =
//       this.agentPartialArtifactIdsMap[adkEvent.author!] || randomUUID();

//     const a2aEvent = createTaskArtifactUpdateEvent({
//       taskId: this.context.requestContext.taskId,
//       contextId: this.context.requestContext.contextId,
//       artifactId,
//       parts,
//       metadata: getA2AEventMetadata(adkEvent, {
//         appName: this.context.agentName,
//         userId: this.context.userId,
//         sessionId: this.context.sessionId,
//       }),
//       append: adkEvent.partial,
//       lastChunk: !adkEvent.partial,
//     });

//     if (adkEvent.partial) {
//       this.agentPartialArtifactIdsMap[adkEvent.author!] = artifactId;
//     } else {
//       delete this.agentPartialArtifactIdsMap[adkEvent.author!];
//     }

//     return a2aEvent;
//   }

//   makeFinalStatusUpdate(): TaskStatusUpdateEvent {
//     if (this.failedEvent) {
//       return {
//         ...this.failedEvent,
//         metadata: getA2AEventMetadataFromActions(this.terminalActions),
//       };
//     }

//     if (this.inputRequiredProcessor.event) {
//       return {
//         ...this.inputRequiredProcessor.event,
//         metadata: getA2AEventMetadataFromActions(this.terminalActions),
//       };
//     }

//     return createTaskCompletedEvent({
//       taskId: this.context.requestContext.taskId,
//       contextId: this.context.requestContext.contextId,
//       metadata: getA2AEventMetadataFromActions(this.terminalActions),
//     });
//   }

//   private updateTerminalActions(event: AdkEvent) {
//     this.terminalActions.escalate =
//       this.terminalActions.escalate || event.actions?.escalate;
//     if (event.actions?.transferToAgent) {
//       this.terminalActions.transferToAgent = event.actions.transferToAgent;
//     }
//   }
// }
