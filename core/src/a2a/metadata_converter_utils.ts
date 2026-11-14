/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event as AdkEvent} from '../events/event.js';
import {EventActions as AdkEventActions} from '../events/event_actions.js';
import {publicMetadata} from '../events/internal_metadata.js';
import {A2AEvent, isTask} from './a2a_event.js';

const ADK_METADATA_KEY_PREFIX = 'adk_';
/** Prefix of the event custom metadata keys that carry A2A data. */
export const A2A_METADATA_KEY_PREFIX = 'a2a:';

/**
 * First segment of an A2A context id built by {@link toA2AContextId}.
 */
export const ADK_CONTEXT_ID_PREFIX = 'ADK';

/**
 * Separator between the segments of an A2A context id built by
 * {@link toA2AContextId}.
 */
export const ADK_CONTEXT_ID_SEPARATOR = '/';

/**
 * The ADK session fields that an A2A context id carries.
 */
export interface A2AContextIdParts {
  readonly appName: string;
  readonly userId: string;
  readonly sessionId: string;
}

/**
 * Builds an A2A context id of the form `ADK/<appName>/<userId>/<sessionId>`.
 *
 * Each field is percent-encoded, so a field that contains the separator still
 * round-trips through {@link fromA2AContextId}.
 *
 * @param parts - The app name, user ID and session ID. All must be non-empty.
 * @returns The A2A context id.
 * @throws Error if any field is empty.
 */
export function toA2AContextId({
  appName,
  userId,
  sessionId,
}: A2AContextIdParts): string {
  if (!appName || !userId || !sessionId) {
    throw new Error(
      'All parameters (appName, userId, sessionId) must be non-empty',
    );
  }

  return [
    ADK_CONTEXT_ID_PREFIX,
    encodeURIComponent(appName),
    encodeURIComponent(userId),
    encodeURIComponent(sessionId),
  ].join(ADK_CONTEXT_ID_SEPARATOR);
}

/**
 * Parses an A2A context id built by {@link toA2AContextId}.
 *
 * The context id can come from a remote peer, so this never throws: any input
 * that does not match the format, including malformed percent-encoding, gives
 * `undefined`.
 *
 * @param contextId - The A2A context id.
 * @returns The app name, user ID and session ID, or `undefined` if the context
 *   id is missing or not in the expected format.
 */
export function fromA2AContextId(
  contextId?: string,
): A2AContextIdParts | undefined {
  if (!contextId) {
    return undefined;
  }

  const segments = contextId.split(ADK_CONTEXT_ID_SEPARATOR);
  if (segments.length !== 4) {
    return undefined;
  }

  const [prefix, ...fields] = segments;
  if (prefix !== ADK_CONTEXT_ID_PREFIX) {
    return undefined;
  }

  let decoded: string[];
  try {
    decoded = fields.map((field) => decodeURIComponent(field));
  } catch (e) {
    if (e instanceof URIError) {
      return undefined;
    }
    throw e;
  }

  const [appName, userId, sessionId] = decoded;
  if (!appName || !userId || !sessionId) {
    return undefined;
  }

  return {appName, userId, sessionId};
}

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
  VIDEO_METADATA = `${ADK_METADATA_KEY_PREFIX}video_metadata`,
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
 *
 * @param a2aEvent - The A2A event to extract metadata from.
 * @returns A record containing the ADK task ID and context ID keys.
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
 *
 * @param adkEvent - The ADK event to extract metadata from.
 * @param appName - The name of the ADK application.
 * @param userId - The ID of the current user.
 * @param sessionId - The ID of the current session.
 * @returns A record of A2A metadata keys populated from the ADK event.
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
    [A2AMetadataKeys.ERROR_CODE]: adkEvent.errorCode,
    [A2AMetadataKeys.ERROR_MESSAGE]: adkEvent.errorMessage,
    [A2AMetadataKeys.CITATION_METADATA]: adkEvent.citationMetadata,
    [A2AMetadataKeys.GROUNDING_METADATA]: adkEvent.groundingMetadata,
    [A2AMetadataKeys.USAGE_METADATA]: adkEvent.usageMetadata,
    [A2AMetadataKeys.CUSTOM_METADATA]: publicMetadata(adkEvent.customMetadata),
    [A2AMetadataKeys.PARTIAL]: adkEvent.partial,
    [A2AMetadataKeys.IS_LONG_RUNNING]:
      (adkEvent.longRunningToolIds || []).length > 0,
  };
}

/**
 * Creates A2A Session metadata from ADK Event invocation metadata.
 *
 * @param appName - The name of the ADK application.
 * @param userId - The ID of the current user.
 * @param sessionId - The ID of the current session.
 * @returns A record of A2A metadata keys for app name, user ID, and session ID.
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
 *
 * @param actions - The ADK event actions to extract escalation and transfer
 *   metadata from.
 * @returns A record with escalate and transfer-to-agent A2A metadata keys.
 */
export function getA2AEventMetadataFromActions(
  actions: AdkEventActions,
): Record<string, unknown> {
  return {
    [A2AMetadataKeys.ESCALATE]: actions.escalate,
    [A2AMetadataKeys.TRANSFER_TO_AGENT]: actions.transferToAgent,
  };
}
