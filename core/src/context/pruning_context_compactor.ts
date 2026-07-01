/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {BaseContextCompactor} from './base_context_compactor.js';
import {BasePruner} from './pruners/base_pruner.js';

export interface PruningRule {
  toolName: string;
  pruner: BasePruner;
}

export interface PruningContextCompactorOptions {
  rules: PruningRule[];
  sizeThreshold?: number;
}

export class PruningContextCompactor implements BaseContextCompactor {
  constructor(private readonly options: PruningContextCompactorOptions) {}

  shouldCompact(invocationContext: InvocationContext): boolean {
    const events = invocationContext.session.events;
    return events.some((event) => this.hasPrunableResponse(event));
  }

  compact(invocationContext: InvocationContext): Promise<void> {
    const events = invocationContext.session.events;
    for (const event of events) {
      if (this.hasPrunableResponse(event)) {
        this.pruneEvent(event);
      }
    }
    return Promise.resolve();
  }

  private hasPrunableResponse(event: Event): boolean {
    if (!event.content?.parts) {
      return false;
    }

    for (const part of event.content.parts) {
      if (part.functionResponse) {
        const response = part.functionResponse;
        const rule = this.options.rules.find(
          (r) => r.toolName === response.name,
        );
        if (rule) {
          const size = this.getResponseSize(response.response);
          const threshold = this.options.sizeThreshold ?? 0;
          if (size > threshold) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private pruneEvent(event: Event): void {
    if (!event.content?.parts) {
      return;
    }

    for (const part of event.content.parts) {
      if (part.functionResponse) {
        const response = part.functionResponse;
        const rule = this.options.rules.find(
          (r) => r.toolName === response.name,
        );
        if (rule) {
          const size = this.getResponseSize(response.response);
          const threshold = this.options.sizeThreshold ?? 0;
          if (size > threshold) {
            response.response = rule.pruner.prune(response.response);
          }
        }
      }
    }
  }

  private getResponseSize(response: unknown): number {
    if (typeof response === 'string') {
      return response.length;
    }
    try {
      return JSON.stringify(response).length;
    } catch {
      return 0;
    }
  }
}
