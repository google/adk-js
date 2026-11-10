/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Context, InvocationContext} from '@google/adk';
import {isSpanContextValid, trace} from '@opentelemetry/api';
import {randomBytes} from 'node:crypto';

interface SpanRecord {
  readonly spanId: string;
  readonly traceId: string;
  readonly ownsSpan: boolean;
  readonly startTimeNs: bigint;
  readonly kind: string;
  firstTokenTime?: number;
}

export interface EventDataOverrides {
  readonly traceIdOverride?: string | null;
  readonly spanIdOverride?: string | null;
  readonly parentSpanIdOverride?: string | null;
}

export interface ResolvedIds {
  readonly traceId: string;
  readonly spanId: string | null;
  readonly parentSpanId: string | null;
}

export interface PopSpanResult {
  readonly spanId?: string;
  readonly durationMs?: number;
  readonly startTime?: number;
  readonly firstTokenTime?: number;
}

const MAX_TRACKED_INVOCATIONS = 1000;

function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

function extractInvocationAndBranch(ctx: InvocationContext | Context): {
  invocationId: string;
  branch: string;
} {
  if ('invocationContext' in ctx && ctx.invocationContext) {
    return {
      invocationId: ctx.invocationContext.invocationId,
      branch: ctx.invocationContext.branch ?? '',
    };
  }
  const inv = ctx as InvocationContext;
  return {
    invocationId: inv.invocationId,
    branch: inv.branch ?? '',
  };
}

/**
 * Manages plugin-internal execution tree spans and correlates them with ambient OpenTelemetry traces.
 */
export class TraceManager {
  private readonly stacks = new Map<string, SpanRecord[]>();
  private readonly invocationOrder: string[] = [];
  private readonly invocationKeys = new Map<string, Set<string>>();
  private readonly invocationTraceIds = new Map<string, string>();

  private getStackKey(invocationId: string, branch: string): string {
    return `${invocationId}:${branch}`;
  }

  private getOrCreateStack(invocationId: string, branch: string): SpanRecord[] {
    const key = this.getStackKey(invocationId, branch);
    let stack = this.stacks.get(key);
    if (stack) {
      return stack;
    }

    // Track invocation for bounded eviction
    if (!this.invocationKeys.has(invocationId)) {
      if (this.invocationOrder.length >= MAX_TRACKED_INVOCATIONS) {
        const oldest = this.invocationOrder.shift();
        if (oldest) {
          this.clearInvocation(oldest);
        }
      }
      this.invocationOrder.push(invocationId);
      this.invocationKeys.set(invocationId, new Set<string>());
    }
    this.invocationKeys.get(invocationId)?.add(key);

    // If branch has ancestors, clone the nearest ancestor's stack
    if (branch) {
      let currentBranch = branch;
      while (currentBranch.includes('.')) {
        const lastDot = currentBranch.lastIndexOf('.');
        currentBranch = currentBranch.slice(0, lastDot);
        const ancestorKey = this.getStackKey(invocationId, currentBranch);
        const ancestorStack = this.stacks.get(ancestorKey);
        if (ancestorStack) {
          stack = [...ancestorStack];
          break;
        }
      }
      if (!stack) {
        const rootKey = this.getStackKey(invocationId, '');
        const rootStack = this.stacks.get(rootKey);
        if (rootStack) {
          stack = [...rootStack];
        }
      }
    }

    if (!stack) {
      stack = [];
    }
    this.stacks.set(key, stack);
    return stack;
  }

  /**
   * Ensures an invocation root span exists for the current invocation.
   */
  ensureInvocationSpan(ctx: InvocationContext | Context): void {
    const invInfo = extractInvocationAndBranch(ctx);
    const invocationId = invInfo.invocationId;
    const branch = invInfo.branch;
    const stack = this.getOrCreateStack(invocationId, branch);
    if (stack.some((r) => r.kind === 'invocation')) {
      return;
    }

    const ambientSpan = trace.getActiveSpan();
    const ambientCtx = ambientSpan?.spanContext();
    const traceId =
      ambientCtx && isSpanContextValid(ambientCtx)
        ? ambientCtx.traceId
        : generateTraceId();

    this.invocationTraceIds.set(invocationId, traceId);

    if (ambientCtx && isSpanContextValid(ambientCtx)) {
      stack.push({
        spanId: ambientCtx.spanId,
        traceId,
        ownsSpan: false,
        startTimeNs: process.hrtime.bigint(),
        kind: 'invocation',
      });
      return;
    }

    stack.push({
      spanId: generateSpanId(),
      traceId,
      ownsSpan: true,
      startTimeNs: process.hrtime.bigint(),
      kind: 'invocation',
    });
  }

  /**
   * Pushes a new span record with the given kind onto the current branch stack.
   */
  pushSpan(ctx: InvocationContext | Context, kind: string): string {
    const invInfo = extractInvocationAndBranch(ctx);
    const invocationId = invInfo.invocationId;
    const branch = invInfo.branch;
    const stack = this.getOrCreateStack(invocationId, branch);

    let traceId: string;
    if (stack.length > 0) {
      traceId = stack[stack.length - 1].traceId;
    } else if (this.invocationTraceIds.has(invocationId)) {
      traceId = this.invocationTraceIds.get(invocationId) ?? generateTraceId();
    } else {
      const ambientSpan = trace.getActiveSpan();
      const ambientCtx = ambientSpan?.spanContext();
      if (ambientCtx && isSpanContextValid(ambientCtx)) {
        traceId = ambientCtx.traceId;
      } else {
        traceId = generateTraceId();
      }
    }
    this.invocationTraceIds.set(invocationId, traceId);

    const spanId = generateSpanId();
    stack.push({
      spanId,
      traceId,
      ownsSpan: true,
      startTimeNs: process.hrtime.bigint(),
      kind,
    });
    return spanId;
  }

  /**
   * Pops the top span record from the stack if the kind matches (or if expectedKind is omitted).
   */
  popSpan(
    expectedKind?: string,
    ctx?: InvocationContext | Context,
  ): PopSpanResult {
    let stack: SpanRecord[] | undefined;
    if (ctx) {
      const invInfo = extractInvocationAndBranch(ctx);
      const invocationId = invInfo.invocationId;
      const branch = invInfo.branch;
      stack = this.stacks.get(this.getStackKey(invocationId, branch));
    } else {
      // Find the most recently active stack with elements
      for (let i = this.invocationOrder.length - 1; i >= 0; i--) {
        const invId = this.invocationOrder[i];
        const keys = this.invocationKeys.get(invId);
        if (keys) {
          for (const key of keys) {
            const candidate = this.stacks.get(key);
            if (candidate && candidate.length > 0) {
              stack = candidate;
              break;
            }
          }
        }
        if (stack && stack.length > 0) {
          break;
        }
      }
    }

    if (!stack || stack.length === 0) {
      return {};
    }

    const top = stack[stack.length - 1];
    if (expectedKind !== undefined && top.kind !== expectedKind) {
      return {};
    }

    stack.pop();
    const durationMs = Number(
      (process.hrtime.bigint() - top.startTimeNs) / BigInt(1000000),
    );
    const startTime = Number(top.startTimeNs) / 1e9;
    return {
      spanId: top.spanId,
      durationMs,
      startTime,
      firstTokenTime: top.firstTokenTime,
    };
  }

  /**
   * Returns current span ID and parent span ID for the current context.
   */
  currentSpanAndParent(ctx: InvocationContext | Context): {
    spanId: string | null;
    parentSpanId: string | null;
  } {
    const invInfo = extractInvocationAndBranch(ctx);
    const invocationId = invInfo.invocationId;
    const branch = invInfo.branch;
    const stack = this.stacks.get(this.getStackKey(invocationId, branch));
    if (!stack || stack.length === 0) {
      return {spanId: null, parentSpanId: null};
    }

    const currentSpanId = stack[stack.length - 1].spanId;
    let parentSpanId: string | null = null;
    for (let i = stack.length - 2; i >= 0; i--) {
      if (stack[i].spanId !== currentSpanId) {
        parentSpanId = stack[i].spanId;
        break;
      }
    }
    return {spanId: currentSpanId, parentSpanId};
  }

  /**
   * Returns current active span ID.
   */
  currentSpanId(ctx?: InvocationContext | Context): string | null {
    if (ctx) {
      const invInfo = extractInvocationAndBranch(ctx);
      const invocationId = invInfo.invocationId;
      const branch = invInfo.branch;
      const stack = this.stacks.get(this.getStackKey(invocationId, branch));
      if (stack && stack.length > 0) {
        return stack[stack.length - 1].spanId;
      }
      return null;
    }
    for (let i = this.invocationOrder.length - 1; i >= 0; i--) {
      const invId = this.invocationOrder[i];
      const keys = this.invocationKeys.get(invId);
      if (keys) {
        for (const key of keys) {
          const stack = this.stacks.get(key);
          if (stack && stack.length > 0) {
            return stack[stack.length - 1].spanId;
          }
        }
      }
    }
    return null;
  }

  /**
   * Records first token arrival time on the span.
   */
  recordFirstToken(spanId: string, ctx?: InvocationContext | Context): boolean {
    const searchStacks: SpanRecord[][] = [];
    if (ctx) {
      const invInfo = extractInvocationAndBranch(ctx);
      const invocationId = invInfo.invocationId;
      const branch = invInfo.branch;
      const stack = this.stacks.get(this.getStackKey(invocationId, branch));
      if (stack) {
        searchStacks.push(stack);
      }
    } else {
      for (const stack of this.stacks.values()) {
        searchStacks.push(stack);
      }
    }

    for (const stack of searchStacks) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].spanId === spanId) {
          if (stack[i].firstTokenTime === undefined) {
            stack[i].firstTokenTime = Date.now() / 1000;
            return true;
          }
          return false;
        }
      }
    }
    return false;
  }

  /**
   * Returns current trace ID for the context or invocation.
   */
  traceId(ctx: InvocationContext | Context): string {
    const invInfo = extractInvocationAndBranch(ctx);
    const invocationId = invInfo.invocationId;
    const branch = invInfo.branch;
    const stack = this.stacks.get(this.getStackKey(invocationId, branch));
    if (stack && stack.length > 0) {
      return stack[stack.length - 1].traceId;
    }
    const tracked = this.invocationTraceIds.get(invocationId);
    if (tracked) {
      return tracked;
    }
    const ambientSpan = trace.getActiveSpan();
    const ambientCtx = ambientSpan?.spanContext();
    if (ambientCtx && isSpanContextValid(ambientCtx)) {
      return ambientCtx.traceId;
    }
    return invocationId;
  }

  /**
   * Resolves trace_id, span_id, and parent_span_id for an event row.
   */
  resolveIds(
    eventData: EventDataOverrides,
    ctx: InvocationContext | Context,
  ): ResolvedIds {
    const spanInfo = this.currentSpanAndParent(ctx);
    const pluginSpanId = spanInfo.spanId;
    const pluginParentSpanId = spanInfo.parentSpanId;

    let spanId: string | null = pluginSpanId;
    let parentSpanId: string | null = pluginParentSpanId;

    // Trace ID: Ambient OTel trace id wins
    let traceId = this.traceId(ctx);

    const ambientSpan = trace.getActiveSpan();
    const ambientCtx = ambientSpan?.spanContext();
    if (ambientCtx && isSpanContextValid(ambientCtx)) {
      traceId = ambientCtx.traceId;
      if (spanId === null) {
        spanId = ambientCtx.spanId;
        parentSpanId = null;
      }
    }

    // Explicit overrides win
    if (
      eventData.traceIdOverride !== undefined &&
      eventData.traceIdOverride !== null
    ) {
      traceId = eventData.traceIdOverride;
    }
    if (
      eventData.spanIdOverride !== undefined &&
      eventData.spanIdOverride !== null
    ) {
      spanId = eventData.spanIdOverride;
    }
    if (
      eventData.parentSpanIdOverride !== undefined &&
      eventData.parentSpanIdOverride !== null
    ) {
      parentSpanId = eventData.parentSpanIdOverride;
    }

    return {traceId, spanId, parentSpanId};
  }

  /**
   * Cleans up all branch stacks associated with an invocation ID.
   */
  clearInvocation(invocationId: string): void {
    this.invocationTraceIds.delete(invocationId);
    const keys = this.invocationKeys.get(invocationId);
    if (keys) {
      for (const key of keys) {
        this.stacks.delete(key);
      }
      this.invocationKeys.delete(invocationId);
    }
    const idx = this.invocationOrder.indexOf(invocationId);
    if (idx !== -1) {
      this.invocationOrder.splice(idx, 1);
    }
  }
}
