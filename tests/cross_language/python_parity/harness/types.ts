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

/** How badly two traces disagree on one dimension. */
export type DiffSeverity = 'blocked' | 'structural' | 'cosmetic';

/** One disagreement between the two runtimes. */
export interface Difference {
  severity: DiffSeverity;
  dimension: string;
  python: string;
  ts: string;
  detail?: string;
}

/** The verdict for one case. */
export interface CaseResult {
  case: ParityCase;
  skipped?: SkipReason;
  python?: Trace;
  ts?: Trace;
  differences: Difference[];
  /** No structural or blocking differences. */
  match: boolean;
  /** Rough lexical overlap of the two final answers, 0..1. */
  textSimilarity?: number;
}
