/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Raised when a session cannot be found.
 */
export class SessionNotFoundError extends Error {
  /**
   * @param message An optional custom message to describe the error.
   */
  constructor(message = 'Session not found.') {
    super(message);
    this.name = 'SessionNotFoundError';
  }
}
