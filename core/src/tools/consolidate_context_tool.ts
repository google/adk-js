/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';

import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/**
 * Tool for requesting context consolidation (compaction).
 *
 * When called by an LLM agent, this tool sets the state flags
 * `temp:consolidate_context` and optionally `temp:consolidate_context_detail`,
 * signalling the context compactor to trigger compaction.
 */
export class ConsolidateContextTool extends BaseTool {
  constructor() {
    super({
      name: 'consolidate_context',
      description:
        'Requests context consolidation (compaction) to manage history size. ' +
        'Use this when a subtask is complete and you want to summarize progress ' +
        'and clear detailed history.',
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          detail: {
            type: Type.STRING,
            description:
              'Optional description of what has been accomplished so far. ' +
              'This detail will be used to guide the summarization of the history.',
          },
        },
      },
    };
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    toolContext.state.set('temp:consolidate_context', true);
    if (args['detail'] !== undefined) {
      toolContext.state.set(
        'temp:consolidate_context_detail',
        args['detail'] as string,
      );
    }
    return {
      status: 'success',
      message: 'Context consolidation requested.',
    };
  }
}
