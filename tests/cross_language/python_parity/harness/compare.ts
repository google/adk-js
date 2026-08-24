/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Compares two traces of the same scenario.
 *
 * The model is not deterministic, so wording is never a failure. What must
 * agree is everything the framework decides: which tools ran, which agents
 * ran, what got written to state, whether the run errored. Those are reported
 * as `structural`. Differences in how events are packaged — text split across
 * two events, a thought part present on one side — are real but expected, and
 * are reported as `cosmetic` so they inform without failing the suite.
 */

import type {
  CaseResult,
  Difference,
  ParityCase,
  Trace,
  TraceToolCall,
} from './types.ts';

function fmt(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length ? value.join(' → ') : '(none)';
  }
  if (typeof value === 'string') {
    return value || '(empty)';
  }
  return JSON.stringify(value) ?? String(value);
}

function multisetEqual(a: string[], b: string[]): boolean {
  const count = (xs: string[]) =>
    xs.reduce<Record<string, number>>((acc, x) => {
      acc[x] = (acc[x] ?? 0) + 1;
      return acc;
    }, {});
  const ca = count(a);
  const cb = count(b);
  const keys = new Set([...Object.keys(ca), ...Object.keys(cb)]);
  return [...keys].every((k) => ca[k] === cb[k]);
}

/** Token overlap (Jaccard), a cheap stand-in for "do these say the same thing". */
export function textSimilarity(a: string, b: string): number {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 2),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  const intersection = [...ta].filter((t) => tb.has(t)).length;
  return intersection / (ta.size + tb.size - intersection);
}

/** Compares the argument names each tool was called with, ignoring values. */
function argShapes(calls: TraceToolCall[]): string[] {
  return calls.map((c) => `${c.name}(${Object.keys(c.args).sort().join(',')})`);
}

function allCalls(trace: Trace): TraceToolCall[] {
  return trace.events.flatMap((e) => e.functionCalls);
}

export function compareTraces(
  parityCase: ParityCase,
  python: Trace,
  ts: Trace,
): CaseResult {
  const differences: Difference[] = [];
  const add = (d: Difference) => differences.push(d);

  // A side that did not run cannot be compared on anything else.
  if (python.failed || ts.failed) {
    add({
      severity: 'blocked',
      dimension: 'run',
      python: python.failed
        ? `FAILED: ${python.failure ?? 'no session'}`
        : 'ok',
      ts: ts.failed ? `FAILED: ${ts.failure ?? 'no session'}` : 'ok',
      detail: (python.failure ?? '') + (ts.failure ?? ''),
    });
    return {
      case: parityCase,
      python,
      ts,
      differences,
      match: false,
      textSimilarity: 0,
    };
  }

  // --- Structural: what the framework decided. -----------------------------

  const orderMatters = !parityCase.unorderedTools;
  const sequenceEqual = orderMatters
    ? fmt(python.toolSequence) === fmt(ts.toolSequence)
    : multisetEqual(python.toolSequence, ts.toolSequence);

  if (!sequenceEqual) {
    const sameSet = multisetEqual(python.toolSequence, ts.toolSequence);
    add({
      severity: sameSet ? 'cosmetic' : 'structural',
      dimension: sameSet ? 'tool call order' : 'tool calls',
      python: fmt(python.toolSequence),
      ts: fmt(ts.toolSequence),
      detail: sameSet
        ? 'Same calls, different order — usually model choice, not framework.'
        : undefined,
    });
  }

  const pyArgs = argShapes(allCalls(python));
  const tsArgs = argShapes(allCalls(ts));
  if (sequenceEqual && fmt(pyArgs) !== fmt(tsArgs)) {
    add({
      severity: 'structural',
      dimension: 'tool argument names',
      python: fmt(pyArgs),
      ts: fmt(tsArgs),
      detail: 'The two runtimes advertised different parameter names.',
    });
  }

  if (fmt(python.authors) !== fmt(ts.authors)) {
    // Same agents in a different order is the model picking an order it was
    // never constrained to; a different *set* means the runtimes disagree on
    // who runs, or on who an event is attributed to.
    const sameAgents = multisetEqual(python.authors, ts.authors);
    add({
      severity: sameAgents ? 'cosmetic' : 'structural',
      dimension: sameAgents
        ? 'agent event order'
        : 'agents that produced events',
      python: fmt(python.authors),
      ts: fmt(ts.authors),
      detail: sameAgents
        ? 'Same agents, different order \u2014 model choice, not framework.'
        : undefined,
    });
  }

  if (fmt(python.transfers) !== fmt(ts.transfers)) {
    add({
      severity: 'structural',
      dimension: 'agent transfers',
      python: fmt(python.transfers),
      ts: fmt(ts.transfers),
    });
  }

  const volatile = new Set(parityCase.volatileStateKeys ?? []);
  const pyStateKeys = Object.keys(python.finalState).sort();
  const tsStateKeys = Object.keys(ts.finalState).sort();
  if (fmt(pyStateKeys) !== fmt(tsStateKeys)) {
    add({
      severity: 'structural',
      dimension: 'session state keys',
      python: fmt(pyStateKeys),
      ts: fmt(tsStateKeys),
    });
  } else {
    for (const key of pyStateKeys) {
      if (volatile.has(key)) continue;
      const pv = JSON.stringify(python.finalState[key]);
      const tv = JSON.stringify(ts.finalState[key]);
      if (pv !== tv) {
        add({
          severity: 'structural',
          dimension: `state value: ${key}`,
          python: pv ?? 'undefined',
          ts: tv ?? 'undefined',
        });
      }
    }
  }

  if (fmt(python.artifactKeys) !== fmt(ts.artifactKeys)) {
    add({
      severity: 'structural',
      dimension: 'artifacts written',
      python: fmt(python.artifactKeys),
      ts: fmt(ts.artifactKeys),
    });
  }

  if (python.hadError !== ts.hadError) {
    add({
      severity: 'structural',
      dimension: 'error events',
      python: python.hadError ? 'errored' : 'clean',
      ts: ts.hadError ? 'errored' : 'clean',
    });
  }

  const pyEscalate = python.events.some((e) => e.escalate);
  const tsEscalate = ts.events.some((e) => e.escalate);
  if (pyEscalate !== tsEscalate) {
    add({
      severity: 'structural',
      dimension: 'escalation',
      python: String(pyEscalate),
      ts: String(tsEscalate),
    });
  }

  const pyLro = python.events.flatMap((e) => e.longRunningToolIds).length > 0;
  const tsLro = ts.events.flatMap((e) => e.longRunningToolIds).length > 0;
  if (pyLro !== tsLro) {
    add({
      severity: 'structural',
      dimension: 'long-running tool signalled',
      python: String(pyLro),
      ts: String(tsLro),
    });
  }

  const pyAnswered = python.finalText.trim().length > 0;
  const tsAnswered = ts.finalText.trim().length > 0;
  if (pyAnswered !== tsAnswered) {
    add({
      severity: 'structural',
      dimension: 'produced a final answer',
      python: String(pyAnswered),
      ts: String(tsAnswered),
    });
  }

  // --- Cosmetic: packaging, not behaviour. ---------------------------------

  if (python.events.length !== ts.events.length) {
    add({
      severity: 'cosmetic',
      dimension: 'event count',
      python: String(python.events.length),
      ts: String(ts.events.length),
      detail: 'Differs when one side splits text across events.',
    });
  }

  const pyThoughts = python.events.some((e) => e.partKinds.includes('thought'));
  const tsThoughts = ts.events.some((e) => e.partKinds.includes('thought'));
  if (pyThoughts !== tsThoughts) {
    add({
      severity: 'cosmetic',
      dimension: 'thought parts surfaced',
      python: String(pyThoughts),
      ts: String(tsThoughts),
    });
  }

  const similarity = textSimilarity(python.allText, ts.allText);

  return {
    case: parityCase,
    python,
    ts,
    differences,
    match: !differences.some(
      (d) => d.severity === 'structural' || d.severity === 'blocked',
    ),
    textSimilarity: similarity,
  };
}
