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
  InfraFailureKind,
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

/**
 * Errors that say nothing about either framework: the API was busy, the model
 * returned nothing, the call timed out. Retried, never scored.
 */
const TRANSIENT_PATTERNS = [
  /\b429\b/,
  /\b(500|502|503|504)\b/,
  /RESOURCE_EXHAUSTED/,
  /UNAVAILABLE/,
  /DEADLINE_EXCEEDED/,
  /INTERNAL/,
  /MODEL_RETURNED_NO_CONTENT/,
  /timed out/i,
  /ECONNRESET|ETIMEDOUT|socket hang up/i,
];

/**
 * A 400 is the model refusing the request as malformed. That is reproducible
 * and attributable, so it stays a finding rather than being retried away.
 */
const DETERMINISTIC_4XX = /\b400\b|INVALID_ARGUMENT|FAILED_PRECONDITION/;

/** The distinct error codes a run reported, for the report table. */
function describeErrors(trace: Trace): string {
  const codes = [
    ...new Set(
      trace.events
        .filter((e) => e.errorCode || e.errorMessage)
        .map((e) => e.errorCode ?? (e.errorMessage ?? '').slice(0, 40)),
    ),
  ];
  return codes.length ? `errored (${codes.join(', ')})` : 'errored';
}

/** Everything a trace can tell us about why it went wrong. */
function errorText(trace: Trace): string {
  const events = trace.events
    .filter((e) => e.errorCode || e.errorMessage)
    .map((e) => `${e.errorCode ?? ''} ${e.errorMessage ?? ''}`)
    .join(' ');
  return `${trace.failure ?? ''} ${events}`.trim();
}

/**
 * Classifies a trace's failure, if it had one. `undefined` means the run is
 * usable for comparison.
 */
export function classifyFailure(trace: Trace): InfraFailureKind | undefined {
  const text = errorText(trace);
  if (!text) {
    return undefined;
  }
  // Deterministic first: a 400 mentioning a timeout is still a 400.
  if (DETERMINISTIC_4XX.test(text)) {
    return 'deterministic-4xx';
  }
  if (TRANSIENT_PATTERNS.some((p) => p.test(text))) {
    return 'transient';
  }
  return trace.failed ? 'deterministic-4xx' : undefined;
}

/** True when a repeat should be thrown away and re-run rather than scored. */
export function isTransient(python: Trace, ts: Trace): boolean {
  return (
    classifyFailure(python) === 'transient' ||
    classifyFailure(ts) === 'transient'
  );
}

export function compareTraces(
  parityCase: ParityCase,
  python: Trace,
  ts: Trace,
): CaseResult {
  const differences: Difference[] = [];
  const add = (d: Difference) => differences.push(d);

  const pyFailure = classifyFailure(python);
  const tsFailure = classifyFailure(ts);

  // A side that did not run cannot be compared on anything else.
  if (python.failed || ts.failed) {
    // Both sides broken the same way is the environment, not the runtimes.
    const bothTransient =
      pyFailure === 'transient' && tsFailure === 'transient';
    const eitherTransient =
      pyFailure === 'transient' || tsFailure === 'transient';
    add({
      severity: bothTransient || eitherTransient ? 'infrastructure' : 'blocked',
      dimension: 'run',
      python: python.failed
        ? `FAILED: ${python.failure ?? 'no session'}`
        : 'ok',
      ts: ts.failed ? `FAILED: ${ts.failure ?? 'no session'}` : 'ok',
      detail: eitherTransient
        ? 'Transient API failure — retried, and not counted as divergence.'
        : undefined,
    });
    return {
      case: parityCase,
      python,
      ts,
      differences,
      match: !!(bothTransient || eitherTransient),
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
    // Only one side errored. If that error was transient the comparison is
    // void, not damning — a MODEL_RETURNED_NO_CONTENT on one side used to be
    // reported as a runtime difference. A deterministic 4xx that only one
    // runtime provokes stays structural: that is a real finding about how the
    // two build their requests.
    const erroring = python.hadError ? python : ts;
    const kind = classifyFailure(erroring);
    add({
      severity: kind === 'transient' ? 'infrastructure' : 'structural',
      dimension: 'error events',
      python: python.hadError ? describeErrors(python) : 'clean',
      ts: ts.hadError ? describeErrors(ts) : 'clean',
      detail:
        kind === 'transient'
          ? 'Transient model/API error on one side — not counted as divergence.'
          : 'Only one runtime provoked this error.',
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

/**
 * Reduces several repeats of the same case to one verdict.
 *
 * A single run of an LLM-backed case is not reproducible: measured across two
 * full suite runs, 18% of cases changed verdict without a line of either
 * framework changing. So a difference is only reported when a majority of
 * repeats saw it; anything seen but not carried is recorded as *unstable*,
 * which keeps the noise visible without letting it masquerade as a finding.
 *
 * The last repeat supplies the traces, so the report's transcripts and
 * durations come from a real run rather than a synthesised average.
 */
export function consensusOf(repeats: CaseResult[]): CaseResult {
  if (repeats.length === 1) {
    return {...repeats[0], repeats: 1, flipRate: 0, unstableDimensions: []};
  }

  const majority = Math.floor(repeats.length / 2) + 1;
  const seen = new Map<string, {count: number; example: Difference}>();

  for (const repeat of repeats) {
    // Within one repeat a dimension is counted once, however it was worded.
    const unique = new Map<string, Difference>();
    for (const d of repeat.differences) {
      unique.set(d.dimension, d);
    }
    for (const [dimension, example] of unique) {
      const entry = seen.get(dimension) ?? {count: 0, example};
      entry.count += 1;
      seen.set(dimension, entry);
    }
  }

  const differences: Difference[] = [];
  const unstableDimensions: string[] = [];
  for (const [dimension, {count, example}] of seen) {
    if (count >= majority) {
      differences.push(example);
    } else {
      unstableDimensions.push(`${dimension} (${count}/${repeats.length})`);
    }
  }

  const match = !differences.some(
    (d) => d.severity === 'structural' || d.severity === 'blocked',
  );
  const disagreeing = repeats.filter((r) => r.match !== match).length;
  const last = repeats[repeats.length - 1];

  return {
    case: last.case,
    python: last.python,
    ts: last.ts,
    differences,
    match,
    textSimilarity:
      repeats.reduce((sum, r) => sum + (r.textSimilarity ?? 0), 0) /
      repeats.length,
    repeats: repeats.length,
    flipRate: disagreeing / repeats.length,
    unstableDimensions: unstableDimensions.sort(),
  };
}
