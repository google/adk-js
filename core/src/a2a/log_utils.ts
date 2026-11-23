/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FilePart,
  Message,
  MessageSendConfiguration,
  MessageSendParams,
  Part,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {REQUEST_CREDENTIAL_FUNCTION_CALL_NAME} from '../agents/framework_function_calls.js';
import {
  A2AEvent,
  isMessage,
  isTask,
  isTaskArtifactUpdateEvent,
  isTaskStatusUpdateEvent,
} from './a2a_event.js';

const MAX_LOGGED_LENGTH = 100;
const SEPARATOR = '-----------------------------------------------------------';
const REDACTED = '<redacted>';
const UNSERIALIZABLE = '<unserializable>';
const UNAVAILABLE = '<log unavailable>';

/**
 * Metadata as a peer can send it: other A2A implementations serialize an absent
 * map as `null`.
 */
type LoggedMetadata = Record<string, unknown> | null | undefined;

/**
 * The fields of a credential request or response that can hold a secret.
 */
const CREDENTIAL_FIELDS: ReadonlySet<string> = new Set(['args', 'response']);

/**
 * Builds the log text for one A2A message part.
 *
 * Text is cut at 100 characters and large data values are summarized. File
 * bytes and the content of a credential request or response are never
 * included.
 */
export function buildMessagePartLog(part: Part): string {
  return buildGuardedLog(() => buildPartLog(part));
}

/**
 * Builds the log text for an outgoing A2A message send request.
 *
 * Never throws: a request that cannot be formatted prints a placeholder.
 */
export function buildA2ARequestLog(params: MessageSendParams): string {
  return buildGuardedLog(() => buildRequestLog(params));
}

/**
 * Builds the log text for one A2A response: a task, a message, or a task
 * status or artifact update.
 *
 * Never throws: a response that cannot be formatted prints a placeholder.
 */
export function buildA2AResponseLog(response: A2AEvent): string {
  return buildGuardedLog(() => buildResponseLog(response));
}

/**
 * Runs a log builder and returns a placeholder when it throws. A peer or a
 * request callback can leave a payload in a shape its type does not allow, and
 * a log must not make the request fail.
 */
function buildGuardedLog(build: () => string): string {
  try {
    return build();
  } catch {
    return UNAVAILABLE;
  }
}

function buildPartLog(part: Part): string {
  return `${buildPartContentLog(part)}${
    hasEntries(part.metadata)
      ? `\n    Part Metadata: ${indent(toJson(part.metadata), 4)}`
      : ''
  }`;
}

function buildRequestLog(params: MessageSendParams): string {
  return `
A2A Send Message Request:
${SEPARATOR}
Message:
${indentAll(buildMessageLog(params.message), 2)}
${SEPARATOR}
Configuration:
${buildConfigurationLog(params.configuration)}
${SEPARATOR}
Metadata:
${hasEntries(params.metadata) ? toJson(params.metadata) : 'No metadata'}
${SEPARATOR}
`;
}

function buildResponseLog(response: A2AEvent): string {
  if (isTask(response)) {
    return buildResultLog('Task', buildTaskLog(response));
  }

  if (isMessage(response)) {
    return buildResultLog('Message', buildMessageLog(response));
  }

  if (isTaskStatusUpdateEvent(response)) {
    return buildResultLog('TaskStatusUpdateEvent', buildStatusLog(response));
  }

  if (isTaskArtifactUpdateEvent(response)) {
    return buildResultLog(
      'TaskArtifactUpdateEvent',
      buildArtifactLog(response),
    );
  }

  return buildResultLog('Unknown', 'No details');
}

function buildResultLog(resultType: string, details: string): string {
  return `
A2A Response:
${SEPARATOR}
Result Type: ${resultType}
${SEPARATOR}
${details}
${SEPARATOR}
`;
}

function buildTaskLog(task: Task): string {
  const history = task.history ?? [];
  return [
    `Task ID: ${task.id}`,
    `Context ID: ${task.contextId}`,
    `Status State: ${task.status.state}`,
    ...buildOptionalLine('Status Timestamp', task.status.timestamp),
    `History Length: ${history.length}`,
    `Artifacts Count: ${task.artifacts?.length ?? 0}`,
    ...buildMetadataLines('Task Metadata', task.metadata),
    SEPARATOR,
    'Status Message:',
    buildStatusMessageLog(task.status.message),
    SEPARATOR,
    'History:',
    history.length === 0
      ? 'No history'
      : history
          .map(
            (message, index) =>
              `Message ${index + 1}:\n${indentAll(buildMessageLog(message), 2)}`,
          )
          .join('\n'),
  ].join('\n');
}

function buildStatusLog(event: TaskStatusUpdateEvent): string {
  return [
    `Task ID: ${event.taskId}`,
    `Context ID: ${event.contextId}`,
    `Status State: ${event.status.state}`,
    `Final: ${event.final}`,
    SEPARATOR,
    'Status Message:',
    buildStatusMessageLog(event.status.message),
  ].join('\n');
}

function buildArtifactLog(event: TaskArtifactUpdateEvent): string {
  return [
    `Task ID: ${event.taskId}`,
    `Context ID: ${event.contextId}`,
    `Artifact ID: ${event.artifact.artifactId}`,
    `Parts Count: ${event.artifact.parts?.length ?? 0}`,
    `Append: ${event.append ?? false}`,
    `Last Chunk: ${event.lastChunk ?? false}`,
  ].join('\n');
}

function buildStatusMessageLog(message: Message | undefined): string {
  return message ? buildMessageLog(message) : 'No status message';
}

function buildMessageLog(message: Message): string {
  const parts = message.parts ?? [];
  return [
    `ID: ${message.messageId}`,
    `Role: ${message.role}`,
    ...buildOptionalLine('Task ID', message.taskId),
    ...buildOptionalLine('Context ID', message.contextId),
    'Message Parts:',
    ...(parts.length === 0
      ? ['No parts']
      : parts.map(
          (part, index) => `Part ${index}: ${indent(buildPartLog(part), 2)}`,
        )),
    ...buildMetadataLines('Metadata', message.metadata),
  ].join('\n');
}

function buildConfigurationLog(
  configuration: MessageSendConfiguration | undefined,
): string {
  if (!configuration) {
    return 'No configuration';
  }

  return toJson({
    acceptedOutputModes: configuration.acceptedOutputModes,
    blocking: configuration.blocking,
    historyLength: configuration.historyLength,
    pushNotificationConfig: configuration.pushNotificationConfig !== undefined,
  });
}

function buildPartContentLog(part: Part): string {
  switch (part.kind) {
    case 'text':
      return `TextPart: ${truncate(part.text)}`;
    case 'data':
      return `DataPart: ${toJson(summarizeData(part.data ?? {}))}`;
    case 'file':
      return `FilePart: ${toJson(summarizeFile(part.file ?? {}))}`;
    default:
      return 'UnknownPart';
  }
}

function summarizeData(data: Record<string, unknown>): Record<string, unknown> {
  const isCredentialRequest =
    data['name'] === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME;

  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      isCredentialRequest && CREDENTIAL_FIELDS.has(key)
        ? REDACTED
        : summarizeValue(value),
    ]),
  );
}

function summarizeValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  if (toJson(value, 0).length <= MAX_LOGGED_LENGTH) {
    return value;
  }

  return Array.isArray(value) ? '<array>' : '<object>';
}

function summarizeFile(
  file: Partial<FilePart['file']>,
): Record<string, unknown> {
  return {
    name: file.name,
    mimeType: file.mimeType,
    ...('uri' in file && typeof file.uri === 'string'
      ? {uri: truncate(file.uri)}
      : {}),
  };
}

/**
 * Returns the line for an optional field, or no line when the field is absent.
 */
function buildOptionalLine(
  label: string,
  value: string | null | undefined,
): string[] {
  return value === undefined || value === null ? [] : [`${label}: ${value}`];
}

function buildMetadataLines(title: string, metadata: LoggedMetadata): string[] {
  return hasEntries(metadata) ? [`${title}:`, toJson(metadata)] : [];
}

function hasEntries(
  metadata: LoggedMetadata,
): metadata is Record<string, unknown> {
  return (
    metadata !== undefined &&
    metadata !== null &&
    Object.keys(metadata).length > 0
  );
}

/**
 * Cuts the text at the logged length limit. A peer can send `null` where the
 * type requires a string, so a value that is not a string prints as empty.
 */
function truncate(text: string | null | undefined): string {
  const value = typeof text === 'string' ? text : '';

  return value.length > MAX_LOGGED_LENGTH
    ? `${value.slice(0, MAX_LOGGED_LENGTH)}...`
    : value;
}

/**
 * Serializes a value for a log line. A value that JSON cannot represent must
 * not make the request fail, so it prints a placeholder.
 */
function toJson(value: unknown, space = 2): string {
  try {
    return JSON.stringify(value, null, space) ?? UNSERIALIZABLE;
  } catch {
    return UNSERIALIZABLE;
  }
}

/**
 * Indents every line of the text but the first.
 */
function indent(text: string, width: number): string {
  return text.replaceAll('\n', `\n${' '.repeat(width)}`);
}

/**
 * Indents every line of the text.
 */
function indentAll(text: string, width: number): string {
  return `${' '.repeat(width)}${indent(text, width)}`;
}
