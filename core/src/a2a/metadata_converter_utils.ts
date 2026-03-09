/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event as AdkEvent} from '../events/event.js';
import {EventActions as AdkEventActions} from '../events/event_actions.js';
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
  DATA_PART_TYPE = `${ADK_METADATA_KEY_PREFIX}type`,
  PARTIAL = `${ADK_METADATA_KEY_PREFIX}partial`,
  ESCALATE = `${ADK_METADATA_KEY_PREFIX}escalate`,
  TRANSFER_TO_AGENT = `${ADK_METADATA_KEY_PREFIX}transfer_to_agent`,
  IS_LONG_RUNNING = `${ADK_METADATA_KEY_PREFIX}is_long_running`,
  THOUGHT = `${ADK_METADATA_KEY_PREFIX}thought`,
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
}

/**
 * Creates ADK Event metadata from an A2A Event.
 */
export function getAdkEventMetadata(
  a2aEvent: A2AEvent,
): Record<string, unknown> {
  return {
    [AdkMetadataKeys.TASK_ID]: isTask(a2aEvent) ? a2aEvent.id : a2aEvent.taskId,
    [AdkMetadataKeys.CONTEXT_ID]: a2aEvent.contextId,
  };
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
    [A2AMetadataKeys.IS_LONG_RUNNING]:
      (adkEvent.longRunningToolIds || []).length > 0,
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
