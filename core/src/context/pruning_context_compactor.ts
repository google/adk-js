/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionResponse} from '@google/genai';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {getResponseSize} from '../utils/size_utils.js';
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
    return events.some((event) => this.getPrunableResponses(event).length > 0);
  }

  compact(invocationContext: InvocationContext): Promise<void> {
    for (const event of invocationContext.session.events) {
      for (const {response, rule} of this.getPrunableResponses(event)) {
        response.response = rule.pruner.prune(response.response);
      }
    }
    return Promise.resolve();
  }

  private getPrunableResponses(
    event: Event,
  ): Array<{response: FunctionResponse; rule: PruningRule}> {
    return (
      event.content?.parts?.flatMap((part) => {
        const r = part.functionResponse;
        if (!r) {
          return [];
        }
        const rule = this.options.rules.find(
          (rule) => rule.toolName === r.name,
        );
        return rule &&
          getResponseSize(r.response) > (this.options.sizeThreshold ?? 0)
          ? [{response: r, rule}]
          : [];
      }) ?? []
    );
  }
}
