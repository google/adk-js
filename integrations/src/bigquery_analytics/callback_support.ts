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
import {randomUUID} from 'node:crypto';
import {isDurableNodeError} from './callback_helpers.js';
import {type EventData, nodeRunIds} from './event_row.js';
import {recursiveSmartTruncate, safeGet} from './sanitize.js';
import {camelToSnake} from './snake_case.js';
import {SCHEMA_VERBATIM_FIELDS} from './tool_origin.js';

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
  let current: unknown = agent;
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

// Values under these keywords are user data (literals, property names, named
// definitions), so their keys keep their spelling.
const SCHEMA_VALUE_KEYWORDS: ReadonlySet<string> = new Set([
  ...SCHEMA_VERBATIM_FIELDS,
  '$defs',
  'definitions',
]);

/**
 * Snake-cases a genai `Schema`'s own keys as pydantic dumps them, leaving
 * property names and value-bearing keywords as written.
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
      const snakeKey = camelToSnake(key);
      if (SCHEMA_VALUE_KEYWORDS.has(key)) {
        return [snakeKey, value];
      }
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

/**
 * Most workflow observation segments kept. A runner call that never ends
 * normally leaves its segment open; past this many the oldest is dropped.
 */
const MAX_IN_FLIGHT_WORKFLOW_SEGMENTS = 4096;
/**
 * Bounds overflow path deduplication per segment, so truncated node counts are
 * exact up to this many paths and a lower bound beyond it.
 */
const MAX_OBSERVED_NODE_PATHS_PER_SEGMENT = 4096;

interface WorkflowNodeObservation {
  nodePath: string;
  firstSourceEventId: string;
  lastSourceEventId: string;
  firstSourceEventTimestamp: number | null;
  lastSourceEventTimestamp: number | null;
  observedEventCount: number;
  nodeInterruptObserved: boolean;
  descendantInterruptObserved: boolean;
  nodeErrorObservedCount: number;
}

interface WorkflowSegment {
  segmentId: string;
  nodes: Map<string, WorkflowNodeObservation>;
  overflowNodePaths: Set<string>;
  untrackedPathEvents: number;
  interruptedAncestorPaths: Set<string>;
}

/** The first observation of a node path in a segment, for its row. */
export interface FirstObservation {
  segmentId: string;
  sourceEventTimestamp: number | null;
}

/** Summary rows of a segment, and how many node paths they leave out. */
export interface SegmentSummaries {
  adkExtras: Array<Record<string, unknown>>;
  truncatedNodeCount: number;
  totalObservedPaths: number;
}

/** A node path's strict ancestors, from the root to the parent. */
export function strictAncestorNodePaths(nodePath: string): Array<string> {
  const ancestors: Array<string> = [];
  for (const match of nodePath.matchAll(/[./]/g)) {
    ancestors.push(nodePath.slice(0, match.index));
  }
  return ancestors;
}

/** Event timestamps are epoch milliseconds; rows carry epoch seconds. */
function eventSeconds(event: Event): number | null {
  const timestamp: unknown = event.timestamp;
  return typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? timestamp / 1000
    : null;
}

/**
 * Port of adk-python's workflow node observation windows: per runner call, the
 * workflow node paths its events came from, summarized when the call ends.
 */
export class WorkflowObservations {
  private readonly segments = new Map<string, WorkflowSegment>();

  constructor(private readonly summaryCap: number) {}

  /**
   * Opens a runner call's segment. A resumed invocation reuses its id, so its
   * segment is reopened as the newest instead of evicting another call's.
   */
  open(invocationId: string): void {
    this.segments.delete(invocationId);
    for (const id of this.segments.keys()) {
      if (this.segments.size < MAX_IN_FLIGHT_WORKFLOW_SEGMENTS) {
        break;
      }
      this.segments.delete(id);
    }
    this.segments.set(invocationId, {
      segmentId: randomUUID(),
      nodes: new Map(),
      overflowNodePaths: new Set(),
      untrackedPathEvents: 0,
      interruptedAncestorPaths: new Set(),
    });
  }

  close(invocationId: string): void {
    this.segments.delete(invocationId);
  }

  clear(): void {
    this.segments.clear();
  }

  /**
   * Records a path-bearing event in its runner call's segment; the result is
   * set only for the first event of a node path.
   */
  record(event: Event, invocationId: string): FirstObservation | null {
    const nodePath = event.nodeInfo?.path;
    if (typeof nodePath !== 'string' || nodePath === '') {
      return null;
    }
    const segment = this.segments.get(invocationId);
    if (segment === undefined) {
      return null;
    }
    const eventId = typeof event.id === 'string' ? event.id : '';
    const timestamp = eventSeconds(event);
    const interrupted = (event.longRunningToolIds ?? []).length > 0;
    const first = {
      segmentId: segment.segmentId,
      sourceEventTimestamp: timestamp,
    };

    let observation = segment.nodes.get(nodePath);
    let isFirst = false;
    if (observation === undefined) {
      if (segment.nodes.size >= this.summaryCap) {
        if (interrupted) {
          this.markAncestorsInterrupted(segment, nodePath);
        }
        if (segment.overflowNodePaths.has(nodePath)) {
          return null;
        }
        const maxTrackedPaths = Math.max(
          this.summaryCap,
          MAX_OBSERVED_NODE_PATHS_PER_SEGMENT,
        );
        if (
          segment.nodes.size + segment.overflowNodePaths.size <
          maxTrackedPaths
        ) {
          segment.overflowNodePaths.add(nodePath);
          return first;
        }
        segment.untrackedPathEvents += 1;
        return null;
      }
      isFirst = true;
      observation = {
        nodePath,
        firstSourceEventId: eventId,
        lastSourceEventId: eventId,
        firstSourceEventTimestamp: timestamp,
        lastSourceEventTimestamp: timestamp,
        observedEventCount: 1,
        nodeInterruptObserved: false,
        descendantInterruptObserved: false,
        nodeErrorObservedCount: 0,
      };
      segment.nodes.set(nodePath, observation);
    } else {
      observation.lastSourceEventId = eventId;
      if (timestamp !== null) {
        observation.firstSourceEventTimestamp ??= timestamp;
        observation.lastSourceEventTimestamp = timestamp;
      }
      observation.observedEventCount += 1;
    }

    if (interrupted) {
      observation.nodeInterruptObserved = true;
      for (const ancestor of strictAncestorNodePaths(nodePath)) {
        segment.interruptedAncestorPaths.add(ancestor);
      }
      this.markAncestorsInterrupted(segment, nodePath);
    }
    if (segment.interruptedAncestorPaths.has(nodePath)) {
      observation.descendantInterruptObserved = true;
    }
    if (isDurableNodeError(event)) {
      observation.nodeErrorObservedCount += 1;
    }
    return isFirst ? first : null;
  }

  private markAncestorsInterrupted(
    segment: WorkflowSegment,
    nodePath: string,
  ): void {
    for (const ancestor of strictAncestorNodePaths(nodePath)) {
      const observation = segment.nodes.get(ancestor);
      if (observation !== undefined) {
        observation.descendantInterruptObserved = true;
      }
    }
  }

  /**
   * The `attributes.adk` fields of a segment's summary rows, at most
   * `summaryCap` of them in first-observed order; null when the call has no
   * open segment.
   */
  summarize(
    invocationId: string,
    drainCallback: string,
  ): SegmentSummaries | null {
    const segment = this.segments.get(invocationId);
    if (segment === undefined) {
      return null;
    }
    const observations = [...segment.nodes.values()];
    const kept = observations.slice(0, this.summaryCap);
    const truncatedNodeCount =
      observations.length - kept.length + segment.overflowNodePaths.size;
    const adkExtras = kept.map((observation, index) => {
      const first = observation.firstSourceEventTimestamp;
      const last = observation.lastSourceEventTimestamp;
      const extras: Record<string, unknown> = {
        workflow_segment_id: segment.segmentId,
        node: {path: observation.nodePath, ...nodeRunIds(observation.nodePath)},
        first_source_event_id: observation.firstSourceEventId,
        last_source_event_id: observation.lastSourceEventId,
        first_source_event_timestamp: first,
        last_source_event_timestamp: last,
        source_event_span_ms:
          first !== null && last !== null ? (last - first) * 1000 : null,
        observed_event_count: observation.observedEventCount,
        node_interrupt_observed: observation.nodeInterruptObserved,
        descendant_interrupt_observed: observation.descendantInterruptObserved,
        node_error_observed_count: observation.nodeErrorObservedCount,
        drain_callback: drainCallback,
        boundary_basis: 'event_observation',
      };
      if (index === kept.length - 1) {
        if (truncatedNodeCount > 0) {
          extras.truncated_node_count = truncatedNodeCount;
        }
        if (segment.untrackedPathEvents > 0) {
          extras.untracked_overflow_event_count = segment.untrackedPathEvents;
        }
      }
      return extras;
    });
    return {
      adkExtras,
      truncatedNodeCount,
      totalObservedPaths: kept.length + truncatedNodeCount,
    };
  }
}
