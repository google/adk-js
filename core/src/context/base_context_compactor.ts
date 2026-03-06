/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';

/**
 * Interface for compacting the context history in an agent session.
 */
export interface BaseContextCompactor {
  /**
   * Determines whether the context should be compacted.
   *
   * @param invocationContext The current invocation context.
   * @returns A boolean or a promise resolving to a boolean indicating if compaction should occur.
   */
  shouldCompact(
    invocationContext: InvocationContext,
  ): boolean | Promise<boolean>;

  /**
   * Compacts the context in place.
   *
   * @param invocationContext The current invocation context.
   */
  compact(invocationContext: InvocationContext): void | Promise<void>;
}
