/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Represents an error that occurs when an entity is not found.
 */
export class NotFoundError extends Error {
  /**
   * @param message An optional custom message to describe the error.
   */
  constructor(message = 'The requested item was not found.') {
    super(message);
    this.name = 'NotFoundError';
  }
}
