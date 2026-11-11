/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  MAX_TRACKED_INVOCATIONS,
  TraceManager,
} from '../../src/bigquery_analytics/trace_manager.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TraceManager', () => {
  it('keeps parallel tool calls on separate stacks under their branch', () => {
    const traces = new TraceManager();
    const branch = {invocationId: 'inv', branch: 'root'};
    traces.pushSpan({scope: branch, kind: 'agent'});
    const agentSpan = traces.getCurrentSpanId(branch);
    const callA = {...branch, functionCallId: 'a'};
    const callB = {...branch, functionCallId: 'b'};

    const spanA = traces.pushSpan({scope: callA, kind: 'tool'});
    const spanB = traces.pushSpan({scope: callB, kind: 'tool'});
    expect(traces.getCurrentSpanAndParent(callA)).toEqual({
      spanId: spanA,
      parentSpanId: agentSpan,
    });

    expect(traces.popSpan({scope: callA, expectedKind: 'tool'}).spanId).toBe(
      spanA,
    );
    expect(traces.popSpan({scope: callB, expectedKind: 'tool'}).spanId).toBe(
      spanB,
    );
    expect(traces.getCurrentSpanId(branch)).toBe(agentSpan);
  });

  it('lets a nested branch inherit its ancestors without changing them', () => {
    const traces = new TraceManager();
    const root = {invocationId: 'inv', branch: 'root'};
    const nested = {invocationId: 'inv', branch: 'root.par.child'};
    const rootSpan = traces.pushSpan({scope: root, kind: 'agent'});

    expect(traces.getCurrentSpanId(nested)).toBe(rootSpan);
    const childSpan = traces.pushSpan({scope: nested, kind: 'agent'});
    expect(traces.getCurrentSpanAndParent(nested)).toEqual({
      spanId: childSpan,
      parentSpanId: rootSpan,
    });
    expect(traces.getCurrentSpanId(root)).toBe(rootSpan);

    // A pop in the nested branch forks its own copy; the ancestor keeps its
    // span, as a child context's pop does in adk-python.
    expect(traces.popSpan({scope: nested, expectedKind: 'agent'}).spanId).toBe(
      childSpan,
    );
    expect(traces.popSpan({scope: nested, expectedKind: 'agent'}).spanId).toBe(
      rootSpan,
    );
    expect(traces.getCurrentSpanId(nested)).toBeNull();
    expect(traces.getCurrentSpanId(root)).toBe(rootSpan);
  });

  it('pops only a span of the expected kind', () => {
    const traces = new TraceManager();
    const scope = {invocationId: 'inv'};
    traces.pushSpan({scope, kind: 'agent'});
    expect(traces.popSpan({scope, expectedKind: 'tool'})).toEqual({
      spanId: null,
      durationMs: null,
    });
    expect(traces.getCurrentSpanId(scope)).not.toBeNull();
  });

  it('unwinds to the named span through abandoned descendants', () => {
    const traces = new TraceManager();
    const scope = {invocationId: 'inv'};
    const root = traces.pushSpan({scope, kind: 'invocation'});
    const outer = traces.pushSpan({scope, kind: 'agent', name: 'outer'});
    traces.pushSpan({scope, kind: 'agent', name: 'inner'});
    traces.pushSpan({scope, kind: 'llm_request'});

    expect(
      traces.unwindSpan({scope, kind: 'agent', name: 'outer'}).spanId,
    ).toBe(outer);
    expect(traces.getCurrentSpanId(scope)).toBe(root);
  });

  it('leaves the stack alone when no span matches the unwind', () => {
    const traces = new TraceManager();
    const scope = {invocationId: 'inv'};
    traces.pushSpan({scope, kind: 'invocation'});
    const outer = traces.pushSpan({scope, kind: 'agent', name: 'outer'});

    expect(traces.unwindSpan({scope, kind: 'agent', name: 'inner'})).toEqual({
      spanId: null,
      durationMs: null,
    });
    expect(traces.getCurrentSpanId(scope)).toBe(outer);
  });

  it('evicts the least recently used invocation past the cap', () => {
    const traces = new TraceManager();
    for (let index = 0; index < MAX_TRACKED_INVOCATIONS; index += 1) {
      traces.initTrace({
        scope: {invocationId: `inv-${index}`},
        rootAgentName: 'root',
      });
    }
    traces.pushSpan({scope: {invocationId: 'inv-0'}});
    traces.initTrace({scope: {invocationId: 'new'}, rootAgentName: 'root'});

    expect(traces.getRootAgentName('inv-0')).toBe('root');
    expect(traces.getRootAgentName('inv-1')).toBeNull();
    expect(traces.getRootAgentName('new')).toBe('root');
  });

  it('drops invocations untouched for six hours', () => {
    const traces = new TraceManager();
    const start = Date.now();
    traces.initTrace({scope: {invocationId: 'old'}, rootAgentName: 'root'});
    vi.spyOn(Date, 'now').mockReturnValue(start + 6 * 60 * 60 * 1000 + 1);
    traces.initTrace({scope: {invocationId: 'new'}, rootAgentName: 'root'});

    expect(traces.getRootAgentName('old')).toBeNull();
    expect(traces.getRootAgentName('new')).toBe('root');
  });
});
