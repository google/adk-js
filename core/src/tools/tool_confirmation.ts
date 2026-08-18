/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Represents a tool confirmation configuration.
 * @experimental  (Experimental, subject to change)
 */
export class ToolConfirmation {
  /** The hint text for why the input is needed. */
  hint: string;

  /** Whether the tool execution is confirmed. */
  confirmed: boolean;

  /**
   * The custom data payload needed from the user to continue the flow.
   * It should be JSON serializable.
   */
  payload?: unknown;

  constructor({
    hint,
    confirmed,
    payload,
  }: {
    hint?: string;
    confirmed: boolean;
    payload?: unknown;
  }) {
    this.hint = hint ?? '';
    this.confirmed = confirmed;
    this.payload = payload;
  }
}

/**
 * Why a confirmation was refused. Each value is one of the checks the resume
 * path makes before it runs a tool call a human approved.
 */
export type IntentMismatchReason =
  /** The `adk_request_confirmation` call was not raised by the agent. */
  | 'untrusted_request'
  /** The `adk_request_confirmation` call carries no usable pinned call. */
  | 'malformed_request'
  /** The pinned call is absent from session history. */
  | 'unknown_original_call'
  /** The pinned call names a tool the agent does not have. */
  | 'unregistered_tool'
  /** The pinned tool does not gate on confirmation, so nothing was approved. */
  | 'confirmation_not_required'
  /** The pinned tool name disagrees with the call in history. */
  | 'tool_name_mismatch'
  /** The pinned arguments disagree with the call in history. */
  | 'arguments_mismatch';

/**
 * Raised when a tool confirmation does not bind to the action it claims to
 * approve — the approval and the action about to run are not the same thing.
 *
 * The framework fails closed on this: a mismatch aborts the invocation rather
 * than running an action no human agreed to. It is worth alerting on, so the
 * message names the reason and the call, and deliberately carries no argument
 * values — a rejected payload is attacker-controlled and does not belong in
 * logs.
 */
export class IntentMismatchError extends Error {
  /** Which binding check refused the confirmation. */
  readonly reason: IntentMismatchReason;

  /** The id of the pinned call, when one was named. */
  readonly functionCallId?: string;

  constructor(options: {
    reason: IntentMismatchReason;
    functionCallId?: string;
  }) {
    const target = options.functionCallId
      ? ` for function call '${options.functionCallId}'`
      : '';
    super(`Tool confirmation rejected${target}: ${options.reason}.`);
    this.name = 'IntentMismatchError';
    this.reason = options.reason;
    this.functionCallId = options.functionCallId;
    // Restore prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, IntentMismatchError.prototype);
  }
}

/**
 * Type guard for {@link IntentMismatchError}.
 *
 * Matches on `name` rather than `instanceof` so it stays correct when the error
 * crosses a package boundary (two copies of adk-js in one runtime would fail an
 * `instanceof` check between them).
 */
export function isIntentMismatchError(e: unknown): e is IntentMismatchError {
  return e instanceof Error && e.name === 'IntentMismatchError';
}
