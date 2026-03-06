/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {BaseContextCompactor} from './base_context_compactor.js';

/**
 * A context compactor that uses an LLM to generate a compacted representation
 * of existing events.
 */
export class LlmContextCompactor implements BaseContextCompactor {
  // TODO: Add LLM related configuration properties here as this implementation expands.

  shouldCompact(
    _invocationContext: InvocationContext,
  ): boolean | Promise<boolean> {
    // Basic placeholder implementation.
    return false;
  }

  compact(_invocationContext: InvocationContext): void | Promise<void> {
    // Basic placeholder implementation.
    return Promise.resolve();
  }
}
