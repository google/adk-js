/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isSpanContextValid, type SpanContext, trace} from '@opentelemetry/api';
import {randomUUID} from 'node:crypto';

export type SpanKind =
  'invocation' | 'agent' | 'llm_request' | 'tool' | (string & {});

/**
 * Where a callback runs. adk-python keeps the span stack in a contextvar, so a
 * parallel branch or a concurrently executed tool call sees a copy of its
 * parent's stack. Plugin callbacks in adk-js cannot carry async-local state
 * back to the runner, so the same isolation is keyed explicitly: by invocation,
 * then branch (parallel agents), then function call id (concurrent tool calls).
 */
export interface TraceScope {
  invocationId: string;
  branch?: string | undefined;
  functionCallId?: string | undefined;
}

interface SpanRecord {
  spanId: string;
  traceId: string;
  ownsSpan: boolean;
  startTimeMs: number;
  kind: SpanKind;
  firstTokenTimeMs: number | null;
}

export interface PoppedSpan {
  spanId: string | null;
  durationMs: number | null;
}

export interface CurrentSpan {
  spanId: string | null;
  parentSpanId: string | null;
}

interface InvocationState {
  rootAgentName: string | null;
  stacks: Map<string, ReadonlyArray<SpanRecord>>;
  lastWriteMs: number;
}

/**
 * adk-js runs `afterRunCallback` only when a run ends normally, so an aborted
 * or failed run leaves its state behind. State untouched this long belongs to
 * such a run and is dropped.
 */
const ABANDONED_INVOCATION_MS = 6 * 60 * 60 * 1000;

function hex(length: number): string {
  return randomUUID().replaceAll('-', '').slice(0, length);
}

function ambientSpanContext(): SpanContext | null {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext !== undefined && isSpanContextValid(spanContext)
    ? spanContext
    : null;
}

interface SpanWithParent {
  parentSpanContext?: {spanId?: string};
  parentSpanId?: string;
}

/**
 * Parent span id of the ambient span when the SDK exposes it
 * (`parentSpanContext` in SDK 2, `parentSpanId` in 1).
 */
export function ambientParentSpanId(): string | null {
  // SAFETY: the API's `Span` hides the SDK fields; both are optional here and
  // read only as strings.
  const span = trace.getActiveSpan() as SpanWithParent | undefined;
  const parentId = span?.parentSpanContext?.spanId ?? span?.parentSpanId;
  return parentId === undefined || parentId === '' ? null : parentId;
}

export function ambientIds(): {traceId: string; spanId: string} | null {
  const spanContext = ambientSpanContext();
  return spanContext === null
    ? null
    : {traceId: spanContext.traceId, spanId: spanContext.spanId};
}

function branchKey(scope: TraceScope): string {
  return scope.branch ?? '';
}

function scopeKey(scope: TraceScope): string {
  return scope.functionCallId === undefined
    ? branchKey(scope)
    : `${branchKey(scope)}#${scope.functionCallId}`;
}

/**
 * Keys this scope inherits from, nearest first: the branch for a tool call,
 * then each ancestor branch.
 */
function ancestorKeys(scope: TraceScope): Array<string> {
  const segments = branchKey(scope).split('.');
  const ancestors = segments.map((_, index) =>
    segments.slice(0, segments.length - 1 - index).join('.'),
  );
  return scope.functionCallId === undefined
    ? ancestors
    : [branchKey(scope), ...ancestors];
}

/**
 * Port of adk-python `TraceManager`: the plugin's internal span stack. No
 * OpenTelemetry span is created.
 */
export class TraceManager {
  private readonly invocations = new Map<string, InvocationState>();

  private state(invocationId: string): InvocationState {
    const now = Date.now();
    const existing = this.invocations.get(invocationId);
    if (existing !== undefined) {
      existing.lastWriteMs = now;
      return existing;
    }
    for (const [id, state] of this.invocations) {
      if (now - state.lastWriteMs > ABANDONED_INVOCATION_MS) {
        this.invocations.delete(id);
      }
    }
    const created: InvocationState = {
      rootAgentName: null,
      stacks: new Map(),
      lastWriteMs: now,
    };
    this.invocations.set(invocationId, created);
    return created;
  }

  private records(scope: TraceScope): ReadonlyArray<SpanRecord> {
    const stacks = this.invocations.get(scope.invocationId)?.stacks;
    if (stacks === undefined) {
      return [];
    }
    const own = stacks.get(scopeKey(scope));
    if (own !== undefined) {
      return own;
    }
    for (const key of ancestorKeys(scope)) {
      const inherited = stacks.get(key);
      if (inherited !== undefined) {
        return inherited;
      }
    }
    return [];
  }

  private setRecords(
    scope: TraceScope,
    records: ReadonlyArray<SpanRecord>,
  ): void {
    this.state(scope.invocationId).stacks.set(scopeKey(scope), records);
  }

  private findRecord(
    scope: TraceScope,
    spanId: string,
  ): SpanRecord | undefined {
    return [...this.records(scope)]
      .reverse()
      .find((record) => record.spanId === spanId);
  }

  initTrace({
    scope,
    rootAgentName,
  }: {
    scope: TraceScope;
    rootAgentName: string | null;
  }): void {
    this.state(scope.invocationId).rootAgentName = rootAgentName;
  }

  getTraceId(scope: TraceScope): string {
    const top = this.records(scope).at(-1);
    if (top !== undefined) {
      return top.traceId;
    }
    return ambientIds()?.traceId ?? scope.invocationId;
  }

  pushSpan({
    scope,
    kind = 'adk-span',
  }: {
    scope: TraceScope;
    kind?: SpanKind;
  }): string {
    const records = this.records(scope);
    const traceId = records.at(-1)?.traceId ?? ambientIds()?.traceId ?? hex(32);
    const spanId = hex(16);
    this.setRecords(scope, [
      ...records,
      {
        spanId,
        traceId,
        ownsSpan: true,
        startTimeMs: Date.now(),
        kind,
        firstTokenTimeMs: null,
      },
    ]);
    return spanId;
  }

  /**
   * Records the ambient OpenTelemetry span's ids as the invocation root without
   * owning it.
   */
  attachCurrentSpan(scope: TraceScope): string {
    const ambient = ambientIds();
    const spanId = ambient?.spanId ?? hex(16);
    const traceId = ambient?.traceId ?? hex(32);
    this.setRecords(scope, [
      ...this.records(scope),
      {
        spanId,
        traceId,
        ownsSpan: false,
        startTimeMs: Date.now(),
        kind: 'invocation',
        firstTokenTimeMs: null,
      },
    ]);
    return spanId;
  }

  /**
   * Seeds the invocation root once per invocation so every row of it shares one
   * trace id.
   */
  ensureInvocationSpan(scope: TraceScope): void {
    if (this.records(scope).length > 0) {
      return;
    }
    if (ambientIds() === null) {
      this.pushSpan({scope, kind: 'invocation'});
      return;
    }
    this.attachCurrentSpan(scope);
  }

  /**
   * Pops the top record. With `expectedKind`, pops only a record of that kind,
   * so an error callback never consumes a span another callback pushed.
   */
  popSpan({
    scope,
    expectedKind,
  }: {
    scope: TraceScope;
    expectedKind?: SpanKind;
  }): PoppedSpan {
    const records = this.records(scope);
    const top = records.at(-1);
    if (
      top === undefined ||
      (expectedKind !== undefined && top.kind !== expectedKind)
    ) {
      return {spanId: null, durationMs: null};
    }
    this.setRecords(scope, records.slice(0, -1));
    return {
      spanId: top.spanId,
      durationMs: Math.trunc(Date.now() - top.startTimeMs),
    };
  }

  clearInvocation(invocationId: string): void {
    this.invocations.delete(invocationId);
  }

  clear(): void {
    this.invocations.clear();
  }

  getCurrentSpanAndParent(scope: TraceScope): CurrentSpan {
    const records = this.records(scope);
    const top = records.at(-1);
    if (top === undefined) {
      return {spanId: null, parentSpanId: null};
    }
    const parent = records
      .slice(0, -1)
      .reverse()
      .find((record) => record.spanId !== top.spanId);
    return {spanId: top.spanId, parentSpanId: parent?.spanId ?? null};
  }

  getCurrentSpanId(scope: TraceScope): string | null {
    return this.records(scope).at(-1)?.spanId ?? null;
  }

  getRootAgentName(invocationId: string): string | null {
    return this.invocations.get(invocationId)?.rootAgentName ?? null;
  }

  /** Start time in epoch milliseconds. */
  getStartTime({
    scope,
    spanId,
  }: {
    scope: TraceScope;
    spanId: string;
  }): number | null {
    return this.findRecord(scope, spanId)?.startTimeMs ?? null;
  }

  recordFirstToken({
    scope,
    spanId,
  }: {
    scope: TraceScope;
    spanId: string;
  }): boolean {
    const record = this.findRecord(scope, spanId);
    if (record === undefined || record.firstTokenTimeMs !== null) {
      return false;
    }
    record.firstTokenTimeMs = Date.now();
    return true;
  }

  getFirstTokenTime({
    scope,
    spanId,
  }: {
    scope: TraceScope;
    spanId: string;
  }): number | null {
    return this.findRecord(scope, spanId)?.firstTokenTimeMs ?? null;
  }
}
