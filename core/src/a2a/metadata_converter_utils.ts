/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event as AdkEvent, createEvent} from '../events/event.js';
import {
  CitationMetadata,
  GroundingMetadata,
  UsageMetadata,
} from '@google/genai';
import {Artifact} from '@a2a-js/sdk';
import {
  EventActions as AdkEventActions,
  createEventActions,
} from '../events/event_actions.js';
import {A2AEvent, isTask} from './a2a_event.js';

const ADK_METADATA_KEY_PREFIX = 'adk_';
const A2A_METADATA_KEY_PREFIX = 'a2a:';

/**
 * Keys for metadata that will be stored in A2A message metadata and related to ADK events.
 */
export enum A2AMetadataKeys {
  APP_NAME = `${ADK_METADATA_KEY_PREFIX}app_name`,
  USER_ID = `${ADK_METADATA_KEY_PREFIX}user_id`,
  SESSION_ID = `${ADK_METADATA_KEY_PREFIX}session_id`,
  INVOCATION_ID = `${ADK_METADATA_KEY_PREFIX}invocation_id`,
  AUTHOR = `${ADK_METADATA_KEY_PREFIX}author`,
  BRANCH = `${ADK_METADATA_KEY_PREFIX}branch`,
  PARTIAL = `${ADK_METADATA_KEY_PREFIX}partial`,
  ESCALATE = `${ADK_METADATA_KEY_PREFIX}escalate`,
  TRANSFER_TO_AGENT = `${ADK_METADATA_KEY_PREFIX}transfer_to_agent`,
  LONG_RUNNING_TOOL_IDS = `${ADK_METADATA_KEY_PREFIX}long_running_tool_ids`,
  ERROR_CODE = `${ADK_METADATA_KEY_PREFIX}error_code`,
  ERROR_MESSAGE = `${ADK_METADATA_KEY_PREFIX}error_message`,
  CITATION_METADATA = `${ADK_METADATA_KEY_PREFIX}citation_metadata`,
  GROUNDING_METADATA = `${ADK_METADATA_KEY_PREFIX}grounding_metadata`,
  USAGE_METADATA = `${ADK_METADATA_KEY_PREFIX}usage_metadata`,
  CUSTOM_METADATA = `${ADK_METADATA_KEY_PREFIX}custom_metadata`,
}

/**
 * Keys for metadata that will be stored in ADK event metadata and related to A2A messages.
 */
export enum AdkMetadataKeys {
  TASK_ID = `${A2A_METADATA_KEY_PREFIX}task_id`,
  CONTEXT_ID = `${A2A_METADATA_KEY_PREFIX}context_id`,
  REQUEST = `${A2A_METADATA_KEY_PREFIX}request`,
  RESPONSE = `${A2A_METADATA_KEY_PREFIX}response`,
}

/**
 * Creates ADK Event metadata from an A2A Event.
 */
export function getAdkEventMetadata(
  a2aEvent: A2AEvent,
): Record<string, unknown> {
  return {
    ...a2aEvent.metadata,
    [AdkMetadataKeys.TASK_ID]: isTask(a2aEvent) ? a2aEvent.id : a2aEvent.taskId,
    [AdkMetadataKeys.CONTEXT_ID]: a2aEvent.contextId,
  };
}

/**
 * Extracts A2A task metadata from ADK Event custom metadata.
 */
export function getA2ATaskMetadataFromAdkEvent(adkEvent: AdkEvent): {
  taskId?: string;
  contextId?: string;
} {
  const metadata = adkEvent.customMetadata || {};

  return {
    taskId: metadata[AdkMetadataKeys.TASK_ID] as string,
    contextId: metadata[AdkMetadataKeys.CONTEXT_ID] as string,
  };
}

/**
 * Creates an ADK Event from A2A Event metadata.
 */
export function getAdkEventFromMetadata(a2aEvent: A2AEvent): AdkEvent {
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
    actions: createEventActions({
      escalate: !!metadata[A2AMetadataKeys.ESCALATE],
      transferToAgent: metadata[A2AMetadataKeys.TRANSFER_TO_AGENT] as string,
    }),
    longRunningToolIds: getLongRunningToolIds(a2aEvent),
    customMetadata: getAdkEventMetadata(a2aEvent),
  });
}

/**
 * Extracts long running tool IDs from A2A Event metadata.
 */
export function getLongRunningToolIds(event: A2AEvent | Artifact): string[] {
  return (
    (event.metadata?.[A2AMetadataKeys.LONG_RUNNING_TOOL_IDS] as string[]) || []
  );
}

/**
 * Creates A2A Event metadata from an ADK Event.
 */
export function getA2AEventMetadata(
  adkEvent: AdkEvent,
  {
    appName,
    userId,
    sessionId,
  }: {appName: string; userId: string; sessionId: string},
): Record<string, unknown> {
  return {
    ...getA2AEventMetadataFromActions(adkEvent.actions),
    ...getA2ASessionMetadata({
      appName,
      userId,
      sessionId,
    }),
    [A2AMetadataKeys.INVOCATION_ID]: adkEvent.invocationId,
    [A2AMetadataKeys.AUTHOR]: adkEvent.author,
    [A2AMetadataKeys.BRANCH]: adkEvent.branch,
    [A2AMetadataKeys.ERROR_CODE]: adkEvent.errorMessage,
    [A2AMetadataKeys.ERROR_MESSAGE]: adkEvent.errorMessage,
    [A2AMetadataKeys.CITATION_METADATA]: adkEvent.citationMetadata,
    [A2AMetadataKeys.GROUNDING_METADATA]: adkEvent.groundingMetadata,
    [A2AMetadataKeys.USAGE_METADATA]: adkEvent.usageMetadata,
    [A2AMetadataKeys.CUSTOM_METADATA]: adkEvent.customMetadata,
    [A2AMetadataKeys.PARTIAL]: adkEvent.partial,
    [A2AMetadataKeys.LONG_RUNNING_TOOL_IDS]: adkEvent.longRunningToolIds,
  };
}

/**
 * Creates A2A Session metadata from ADK Event invocation metadata.
 */
export function getA2ASessionMetadata({
  appName,
  userId,
  sessionId,
}: {
  appName: string;
  userId: string;
  sessionId: string;
}): Record<string, unknown> {
  return {
    [A2AMetadataKeys.APP_NAME]: appName,
    [A2AMetadataKeys.USER_ID]: userId,
    [A2AMetadataKeys.SESSION_ID]: sessionId,
  };
}

/**
 * Creates A2A Event metadata from ADK Event actions.
 */
export function getA2AEventMetadataFromActions(
  actions: AdkEventActions,
): Record<string, unknown> {
  return {
    [A2AMetadataKeys.ESCALATE]: actions.escalate,
    [A2AMetadataKeys.TRANSFER_TO_AGENT]: actions.transferToAgent,
  };
}
