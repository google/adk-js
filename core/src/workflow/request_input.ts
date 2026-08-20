/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from '../utils/env_aware_utils.js';
import type {SchemaLike} from '../utils/schema.js';

/**
 * A unique symbol branding {@link RequestInput} instances.
 *
 * {@link isRequestInput} matches on this brand rather than `instanceof` so a
 * request built by another copy of adk-js in the same runtime is still
 * recognised (an `instanceof` check fails across package copies). This matters
 * because the guard gates the HITL interrupt path in `BaseNode.run`: a missed
 * match would silently stringify the request into a text part instead of
 * pausing the workflow. Mirrors the `Symbol.for('google.adk.*')` brands used
 * across ADK.
 */
const REQUEST_INPUT_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.workflow.requestInput',
);

/** Parameters for constructing a {@link RequestInput}. */
export interface RequestInputParams {
  /** The interrupt id (usually a function-call id). Auto-generated if omitted. */
  interruptId?: string;
  /** Custom payload provided for resuming. */
  payload?: unknown;
  /** A message to display to the user when requesting input. */
  message?: string;
  /**
   * The expected shape of the reply (Zod v3/v4 or genai `Schema`).
   *
   * It tells a client what to collect — the dev UI renders a form from it —
   * and a *structured* reply is checked against it on resume. Nothing coerces
   * a human's answer into the shape: a plain-text reply is routed to the
   * interrupt as-is and is not checked, so put an agent node after the pause
   * if you need free text normalized.
   */
  responseSchema?: SchemaLike;
}

/**
 * A request for input from the user, yielded/returned by a node to pause a
 * workflow (Human-in-the-Loop). The framework converts it to an interrupt
 * event; the workflow surfaces the interrupt id to the caller, which later
 * resumes by providing `resumeInputs[interruptId]`.
 *
 * A client answers in one of two ways:
 *
 * - **Plain text.** A text turn is routed to every pending interrupt as-is.
 *   This is what the interactive CLI sends, and the dev UI whenever it has no
 *   schema to build a form from.
 * - **A `functionResponse`** named `adk_request_input`, carrying the interrupt
 *   id. Wrap a bare value as `{result: <value>}` — that envelope is unwrapped
 *   for you, and what it holds counts as plain text. Any other object is
 *   delivered to the node unchanged, so it must already match
 *   {@link RequestInputParams.responseSchema} when one is set.
 *
 * Ported from `google/adk-python` `events/request_input.py`.
 */
export class RequestInput {
  /** Brand identifying this object as a {@link RequestInput} (see {@link isRequestInput}). */
  readonly [REQUEST_INPUT_SIGNATURE_SYMBOL] = true;

  readonly interruptId: string;
  readonly payload?: unknown;
  readonly message?: string;
  readonly responseSchema?: SchemaLike;

  constructor(params: RequestInputParams = {}) {
    this.interruptId = params.interruptId ?? randomUUID();
    this.payload = params.payload;
    this.message = params.message;
    this.responseSchema = params.responseSchema;
  }
}

/**
 * Type guard for {@link RequestInput}.
 *
 * Matches on the `REQUEST_INPUT_SIGNATURE_SYMBOL` brand rather than
 * `instanceof` so it stays correct across package copies (see the brand's doc).
 */
export function isRequestInput(value: unknown): value is RequestInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    REQUEST_INPUT_SIGNATURE_SYMBOL in value &&
    value[REQUEST_INPUT_SIGNATURE_SYMBOL] === true
  );
}
