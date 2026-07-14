/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {BaseContextCompactor} from './base_context_compactor.js';

/**
 * A context compactor that strictly purges all events from the session history,
 * guaranteeing a completely ephemeral interaction session.
 */
export class NullContextCompactor implements BaseContextCompactor {
  shouldCompact(invocationContext: InvocationContext): boolean {
    return invocationContext.session.events.length > 0;
  }

  compact(invocationContext: InvocationContext): void {
    const events = invocationContext.session.events;
    events.length = 0;
  }
}
