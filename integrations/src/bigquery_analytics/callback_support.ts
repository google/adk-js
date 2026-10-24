/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type BaseAgent,
  CallbackContext,
  type Context,
  type Event,
  type InvocationContext,
  logger,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from '@google/adk';
import {type EventData} from './event_row.js';
import {recursiveSmartTruncate, safeGet} from './sanitize.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export const HITL_EVENT_MAP: ReadonlyMap<string, string> = new Map([
  [REQUEST_CREDENTIAL_FUNCTION_CALL_NAME, 'HITL_CREDENTIAL_REQUEST'],
  [REQUEST_CONFIRMATION_FUNCTION_CALL_NAME, 'HITL_CONFIRMATION_REQUEST'],
  [REQUEST_INPUT_FUNCTION_CALL_NAME, 'HITL_INPUT_REQUEST'],
]);

const HITL_PAUSE_KIND_MAP: ReadonlyMap<string, string> = new Map([
  [REQUEST_CREDENTIAL_FUNCTION_CALL_NAME, 'hitl_credential'],
  [REQUEST_CONFIRMATION_FUNCTION_CALL_NAME, 'hitl_confirmation'],
  [REQUEST_INPUT_FUNCTION_CALL_NAME, 'hitl_input'],
]);

/**
 * `GenerateContentConfig` fields logged under `attributes.llm_config`, as
 * adk-python names them.
 */
export const LLM_CONFIG_FIELDS = [
  ['temperature', 'temperature'],
  ['topP', 'top_p'],
  ['topK', 'top_k'],
  ['candidateCount', 'candidate_count'],
  ['maxOutputTokens', 'max_output_tokens'],
  ['stopSequences', 'stop_sequences'],
  ['presencePenalty', 'presence_penalty'],
  ['frequencyPenalty', 'frequency_penalty'],
  ['responseMimeType', 'response_mime_type'],
  ['responseSchema', 'response_schema'],
  ['seed', 'seed'],
  ['responseLogprobs', 'response_logprobs'],
  ['logprobs', 'logprobs'],
] as const;

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function errorTraceback(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? `${error.name}: ${error.message}`)
    : String(error);
}

export function contextOf(invocationContext: InvocationContext): Context {
  return new CallbackContext({invocationContext});
}

/**
 * The part of a tool's context `getToolOrigin` reads: the running agent, absent
 * for a workflow node.
 */
export function toolOriginContext(context: Context): {
  invocationContext: {agent: unknown};
} {
  return {invocationContext: {agent: context.invocationContext.agent}};
}

/**
 * A model name, walking `parentAgent` for a sub-agent that inherits its model
 * (as adk-python does, max 16 hops).
 */
export function resolveModelName(agent: BaseAgent): string | null {
  let current: unknown = 'model' in agent ? agent : null;
  const seen = new Set<unknown>();
  for (
    let hop = 0;
    hop < 16 && isRecord(current) && !seen.has(current);
    hop += 1
  ) {
    seen.add(current);
    const rawModel = safeGet(current, 'model');
    if (typeof rawModel === 'string' && rawModel) {
      return rawModel;
    }
    const nestedModel = isRecord(rawModel)
      ? safeGet(rawModel, 'model')
      : undefined;
    if (typeof nestedModel === 'string' && nestedModel) {
      return nestedModel;
    }
    current = safeGet(current, 'parentAgent');
  }
  return null;
}

export function staticInstructionText(raw: unknown): string | null {
  if (typeof raw === 'string') {
    return raw || null;
  }
  if (raw === undefined || raw === null || typeof raw === 'function') {
    return null;
  }
  const parts: unknown = Array.isArray(raw) ? raw : safeGet(raw, 'parts');
  const texts = (Array.isArray(parts) ? parts : [raw])
    .map((part) => (typeof part === 'string' ? part : safeGet(part, 'text')))
    .filter((text): text is string => typeof text === 'string' && text !== '');
  return texts.length > 0 ? texts.join('\n') : null;
}

/**
 * Snake-cases a genai `Schema`'s own keys as pydantic dumps them, leaving
 * property names as written.
 */
export function snakeCaseSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(snakeCaseSchema);
  }
  if (!isRecord(schema)) {
    return schema;
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      const snakeKey = key.replaceAll(
        /[A-Z]/g,
        (letter) => `_${letter.toLowerCase()}`,
      );
      if (key === 'properties' && isRecord(value)) {
        return [
          snakeKey,
          Object.fromEntries(
            Object.entries(value).map(([name, property]) => [
              name,
              snakeCaseSchema(property),
            ]),
          ),
        ];
      }
      return [snakeKey, snakeCaseSchema(value)];
    }),
  );
}

/** A row a callback logs, before the callback's own context is attached. */
export interface PendingEvent {
  eventType: string;
  rawContent: unknown;
  isTruncated?: boolean;
  eventData: EventData;
}

/**
 * HITL request/completion and TOOL_PAUSED rows for an event's function-call and
 * function-response parts, in part order, then a TOOL_PAUSED row for each
 * long-running id no call part carried.
 */
export function functionPartEvents({
  event,
  maxLen,
}: {
  event: Event;
  maxLen: number;
}): Array<PendingEvent> {
  const pending: Array<PendingEvent> = [];
  const longRunningIds = new Set(event.longRunningToolIds ?? []);
  const pausedIdsEmitted = new Set<string>();
  for (const part of event.content?.parts ?? []) {
    const functionCall = part.functionCall;
    if (functionCall !== undefined) {
      const name = functionCall.name ?? null;
      const hitlEvent = name === null ? undefined : HITL_EVENT_MAP.get(name);
      if (hitlEvent !== undefined) {
        const {value: args, isTruncated} = recursiveSmartTruncate({
          value: functionCall.args ?? {},
          maxLen,
        });
        pending.push({
          eventType: hitlEvent,
          rawContent: {tool: name, args},
          isTruncated,
          eventData: {sourceEvent: event},
        });
      }
      const functionCallId = functionCall.id;
      if (functionCallId !== undefined && longRunningIds.has(functionCallId)) {
        pausedIdsEmitted.add(functionCallId);
        const pauseKind =
          (name === null ? undefined : HITL_PAUSE_KIND_MAP.get(name)) ?? 'tool';
        const {value: args, isTruncated} = recursiveSmartTruncate({
          value: functionCall.args ?? {},
          maxLen,
        });
        pending.push({
          eventType: 'TOOL_PAUSED',
          rawContent: {tool: name, args},
          isTruncated,
          eventData: {
            sourceEvent: event,
            adkExtras: {
              pause_kind: pauseKind,
              function_call_id: functionCallId,
            },
          },
        });
      }
    }
    const functionResponse = part.functionResponse;
    if (functionResponse !== undefined) {
      const name = functionResponse.name ?? null;
      const hitlEvent = name === null ? undefined : HITL_EVENT_MAP.get(name);
      if (hitlEvent !== undefined) {
        const {value: result, isTruncated} = recursiveSmartTruncate({
          value: functionResponse.response ?? {},
          maxLen,
        });
        pending.push({
          eventType: `${hitlEvent}_COMPLETED`,
          rawContent: {tool: name, result},
          isTruncated,
          eventData: {sourceEvent: event},
        });
      }
    }
  }

  for (const orphanPauseId of longRunningIds) {
    if (pausedIdsEmitted.has(orphanPauseId)) {
      continue;
    }
    logger.warn(
      `long_running_tool_id ${orphanPauseId} has no matching function_call part in event ${event.id}; ` +
        "emitting TOOL_PAUSED with pause_kind='tool'.",
    );
    pending.push({
      eventType: 'TOOL_PAUSED',
      rawContent: {tool: null, args: null},
      eventData: {
        sourceEvent: event,
        adkExtras: {pause_kind: 'tool', function_call_id: orphanPauseId},
      },
    });
  }
  return pending;
}
