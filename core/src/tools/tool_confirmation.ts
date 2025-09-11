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

  /** Whether the tool excution is confirmed. */
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
    hint?: string, confirmed: boolean,
    payload?: unknown,
  }) {
    this.hint = hint ?? '';
    this.confirmed = confirmed;
    this.payload = payload;
  }
}