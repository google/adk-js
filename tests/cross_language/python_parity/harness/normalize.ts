/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reduces a saved ADK session to a {@link Trace}.
 *
 * Both CLIs serialise the same `Session` shape with camelCase keys, so one
 * reader covers both. What differs is what each side *populates* — Python
 * carries `nodeInfo`/`modelVersion`/`thoughtSignature` that TS omits — and the
 * trace deliberately drops those: they are metadata, not behaviour.
 */

import type {
  Runtime,
  Trace,
  TraceEvent,
  TraceToolCall,
  TraceToolResponse,
} from './types.ts';

/** Loosely-typed view of a serialised session; both runtimes match it. */
interface RawPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: unknown;
  functionCall?: {name?: string; args?: Record<string, unknown>};
  functionResponse?: {name?: string; response?: unknown};
  inlineData?: unknown;
  fileData?: unknown;
  executableCode?: unknown;
  codeExecutionResult?: unknown;
}

interface RawActions {
  stateDelta?: Record<string, unknown>;
  artifactDelta?: Record<string, unknown>;
  transferToAgent?: string;
  escalate?: boolean;
  skipSummarization?: boolean;
}

interface RawEvent {
  author?: string;
  content?: {role?: string; parts?: RawPart[]};
  actions?: RawActions;
  longRunningToolIds?: string[];
  finishReason?: string;
  errorCode?: string;
  errorMessage?: string;
  partial?: boolean;
  branch?: string;
}

interface RawSession {
  state?: Record<string, unknown>;
  events?: RawEvent[];
}

const PART_KINDS: Array<[keyof RawPart, string]> = [
  ['text', 'text'],
  ['functionCall', 'functionCall'],
  ['functionResponse', 'functionResponse'],
  ['inlineData', 'inlineData'],
  ['fileData', 'fileData'],
  ['executableCode', 'executableCode'],
  ['codeExecutionResult', 'codeExecutionResult'],
];

function partKinds(part: RawPart): string[] {
  const kinds: string[] = [];
  if (part.thought) {
    kinds.push('thought');
  }
  for (const [key, label] of PART_KINDS) {
    if (part[key] !== undefined && part[key] !== null) {
      kinds.push(label);
    }
  }
  return kinds;
}

function toTraceEvent(event: RawEvent): TraceEvent {
  const parts = event.content?.parts ?? [];
  const actions = event.actions ?? {};

  const functionCalls: TraceToolCall[] = [];
  const functionResponses: TraceToolResponse[] = [];
  const kinds: string[] = [];
  let text = '';

  for (const part of parts) {
    kinds.push(...partKinds(part));
    // A thought part's text is model reasoning, not an answer; Python surfaces
    // it and TS does not, so counting it as answer text would diff every case.
    if (part.text && !part.thought) {
      text += part.text;
    }
    if (part.functionCall?.name) {
      functionCalls.push({
        name: part.functionCall.name,
        args: part.functionCall.args ?? {},
      });
    }
    if (part.functionResponse?.name) {
      functionResponses.push({
        name: part.functionResponse.name,
        response: part.functionResponse.response,
      });
    }
  }

  return {
    author: event.author ?? 'unknown',
    partKinds: kinds,
    text,
    functionCalls,
    functionResponses,
    transferTo: actions.transferToAgent,
    escalate: actions.escalate,
    skipSummarization: actions.skipSummarization,
    stateDeltaKeys: Object.keys(actions.stateDelta ?? {}).sort(),
    artifactDeltaKeys: Object.keys(actions.artifactDelta ?? {}).sort(),
    longRunningToolIds: event.longRunningToolIds ?? [],
    finishReason: event.finishReason,
    errorCode: event.errorCode,
    errorMessage: event.errorMessage,
    partial: event.partial,
    branch: event.branch,
  };
}

/** Internal state bookkeeping that is noise for a cross-runtime comparison. */
const IGNORED_STATE_KEYS = new Set(['_time']);

export interface BuildTraceOptions {
  runtime: Runtime;
  session?: RawSession;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  failure?: string;
}

/** Builds the canonical trace for one run. */
export function buildTrace(options: BuildTraceOptions): Trace {
  const {runtime, session, exitCode, durationMs, stdout, stderr} = options;
  const events = (session?.events ?? []).map(toTraceEvent);

  const modelEvents = events.filter((e) => e.author !== 'user');
  const answered = modelEvents.filter((e) => e.text && !e.partial);

  const finalState: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(session?.state ?? {})) {
    if (!IGNORED_STATE_KEYS.has(key)) {
      finalState[key] = value;
    }
  }

  const artifactKeys = new Set<string>();
  for (const event of events) {
    for (const key of event.artifactDeltaKeys) {
      artifactKeys.add(key);
    }
  }

  const authors: string[] = [];
  for (const event of events) {
    if (event.author !== 'user' && !authors.includes(event.author)) {
      authors.push(event.author);
    }
  }

  return {
    runtime,
    failed: options.failure !== undefined || session === undefined,
    failure: options.failure,
    exitCode,
    durationMs,
    stdout,
    stderr,
    events,
    toolSequence: events.flatMap((e) => e.functionCalls.map((c) => c.name)),
    authors,
    transfers: events
      .map((e) => e.transferTo)
      .filter((t): t is string => t !== undefined),
    finalText: answered.at(-1)?.text ?? '',
    allText: answered.map((e) => e.text).join('\n'),
    finalState,
    artifactKeys: [...artifactKeys].sort(),
    hadError: events.some((e) => e.errorCode || e.errorMessage),
  };
}
