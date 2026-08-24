/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Which runtime produced a trace. */
export type Runtime = 'python' | 'ts';

/**
 * Why a case is not compared. A case that cannot run on one side is a finding
 * in its own right, so it is recorded rather than silently skipped.
 */
export type SkipReason =
  | 'no-ts-port' // the TS counterpart has not been written
  | 'unsupported-in-ts' // the feature the sample demonstrates has no TS API
  | 'external-service' // needs MCP/OAuth/BigQuery/a network peer
  | 'non-gemini-model' // needs Anthropic/Ollama/LiteLLM credentials
  | 'interactive' // needs live bidi audio or a real terminal
  | 'requires-streaming' // the sample only works on the streaming API
  | 'nondeterministic'; // output cannot be meaningfully compared

/** One parity case: the same scenario expressed for both runtimes. */
export interface ParityCase {
  /** Stable id, also the run directory name. */
  id: string;
  /** Sample family, taken from the adk-python directory layout. */
  family: string;
  /** Path under `contributing/samples`, e.g. "core/hello_world". */
  pySample: string;
  /** TS counterpart, relative to `agents/ts`. Absent when not ported. */
  tsAgent?: string;
  /** Session state the replay file seeds. */
  state?: Record<string, unknown>;
  /** User turns, run in order against one session. */
  queries: string[];
  /** Set when the case is knowingly not runnable; it is reported, not run. */
  skip?: SkipReason;
  /** Free-text note carried into the report. */
  note?: string;
  /**
   * Tools whose call order the model is free to choose. Their sequence is
   * compared as a multiset instead of a list, so a parallel-call sample does
   * not fail on ordering the model never promised.
   */
  unorderedTools?: boolean;
  /** State keys whose values are expected to differ (timestamps, dice rolls). */
  volatileStateKeys?: string[];
}

/** A single function call as the comparator sees it. */
export interface TraceToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** A function response as the comparator sees it. */
export interface TraceToolResponse {
  name: string;
  /** Stringified for comparison; the raw value is kept for the report. */
  response: unknown;
}

/** One event, reduced to the fields that carry behaviour. */
export interface TraceEvent {
  author: string;
  /** Part kinds present, in order: text, functionCall, thought, ... */
  partKinds: string[];
  text: string;
  functionCalls: TraceToolCall[];
  functionResponses: TraceToolResponse[];
  transferTo?: string;
  escalate?: boolean;
  skipSummarization?: boolean;
  stateDeltaKeys: string[];
  artifactDeltaKeys: string[];
  longRunningToolIds: string[];
  finishReason?: string;
  errorCode?: string;
  errorMessage?: string;
  partial?: boolean;
  branch?: string;
}

/** The canonical, runtime-independent view of one run. */
export interface Trace {
  runtime: Runtime;
  /** True when the CLI exited non-zero or never produced a session. */
  failed: boolean;
  failure?: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;

  events: TraceEvent[];
  /** Ordered tool-call names across the whole run. */
  toolSequence: string[];
  /** Distinct event authors, in first-seen order. */
  authors: string[];
  /** Ordered agent-transfer targets. */
  transfers: string[];
  /** Text of the last non-partial model event. */
  finalText: string;
  /** All model text, joined — used for semantic comparison. */
  allText: string;
  /** Session state at the end of the run. */
  finalState: Record<string, unknown>;
  artifactKeys: string[];
  /** True when any event reported an error. */
  hadError: boolean;
}

/**
 * How badly two traces disagree on one dimension.
 *
 * `infrastructure` is not a parity verdict: it means the comparison could not
 * be made because a model call failed in a way that says nothing about either
 * framework (a 429, a 503, an empty completion). Keeping it out of
 * `structural` is what stops a bad minute at the API from being reported as a
 * runtime difference.
 */
export type DiffSeverity =
  | 'blocked'
  | 'structural'
  | 'cosmetic'
  | 'infrastructure';

/** One disagreement between the two runtimes. */
export interface Difference {
  severity: DiffSeverity;
  dimension: string;
  python: string;
  ts: string;
  detail?: string;
}

/**
 * Why a run could not be trusted, when it could not.
 *
 * `transient` is retried and never scored. A deterministic 4xx is left alone:
 * a 400 that only one runtime provokes is exactly the kind of finding this
 * harness exists to catch (adk-python inlining an `image/bmp` artifact that
 * Vertex rejects, say), so it must not be swept up with the flaky ones.
 */
export type InfraFailureKind = 'transient' | 'deterministic-4xx';

/** The verdict for one case, over one or more repeats. */
export interface CaseResult {
  case: ParityCase;
  skipped?: SkipReason;
  python?: Trace;
  ts?: Trace;
  /** Consensus differences: those seen in a majority of repeats. */
  differences: Difference[];
  /** No structural or blocking differences in the consensus. */
  match: boolean;
  /** Rough lexical overlap of the two final answers, 0..1. */
  textSimilarity?: number;

  /** How many times the case was compared. */
  repeats?: number;
  /**
   * Share of repeats whose verdict disagreed with the consensus, 0..1. Above
   * zero means the case is not reproducible and its result is a lead, not a
   * finding.
   */
  flipRate?: number;
  /**
   * Dimensions that appeared in at least one repeat but not in a majority —
   * reported so the noise is visible, but not counted as divergence.
   */
  unstableDimensions?: string[];
  /** Transient failures that were retried away, for the report's footnote. */
  retries?: number;
}
