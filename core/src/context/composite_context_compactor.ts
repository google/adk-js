/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {BaseContextCompactor} from './base_context_compactor.js';

export class CompositeContextCompactor implements BaseContextCompactor {
  constructor(private readonly compactors: BaseContextCompactor[]) {}

  async shouldCompact(invocationContext: InvocationContext): Promise<boolean> {
    for (const compactor of this.compactors) {
      if (await compactor.shouldCompact(invocationContext)) {
        return true;
      }
    }
    return false;
  }

  async compact(invocationContext: InvocationContext): Promise<void> {
    for (const compactor of this.compactors) {
      if (await compactor.shouldCompact(invocationContext)) {
        await compactor.compact(invocationContext);
      }
    }
  }
}
