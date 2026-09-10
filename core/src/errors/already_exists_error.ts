/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Represents an error that occurs when an entity already exists.
 */
export class AlreadyExistsError extends Error {
  /**
   * @param message An optional custom message to describe the error.
   */
  constructor(message = 'The resource already exists.') {
    super(message);
    this.name = 'AlreadyExistsError';
  }
}
