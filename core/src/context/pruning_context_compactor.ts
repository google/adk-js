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
import {PruningOptions, PruningRule} from './pruners/base_pruner.js';

export type PruningContextCompactorOptions = PruningOptions;

export class PruningContextCompactor implements BaseContextCompactor {
  constructor(private readonly options: PruningContextCompactorOptions) {}

  shouldCompact(invocationContext: InvocationContext): boolean {
    return invocationContext.session.events.some(
      (event) => this.getPrunableResponses(event).length > 0,
    );
  }

  async compact(invocationContext: InvocationContext): Promise<void> {
    for (const event of invocationContext.session.events) {
      for (const {response, rule} of this.getPrunableResponses(event)) {
        response.response = rule.pruner.prune(response.response);
      }
    }
  }

  private getPrunableResponses(
    event: Event,
  ): Array<{response: FunctionResponse; rule: PruningRule}> {
    return (
      event.content?.parts?.flatMap((part) => {
        const r = part.functionResponse;
        const rule =
          r && this.options.rules.find((rule) => rule.toolName === r.name);
        return rule &&
          r &&
          getResponseSize(r.response) > (this.options.sizeThreshold ?? 0)
          ? [{response: r, rule}]
          : [];
      }) ?? []
    );
  }
}
