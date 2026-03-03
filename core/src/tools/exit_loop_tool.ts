/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';

import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/**
 * Tool for exiting execution of a {@link LoopAgent}.
 *
 * When called by an LLM agent inside a LoopAgent, this tool sets the
 * `escalate` and `skipSummarization` flags on the event actions,
 * causing the LoopAgent to stop iterating and exit the loop.
 *
 */

export class ExitLoopTool extends BaseTool {
  constructor() {
    super({
      name: 'exit_loop',
      description:
        'Exits the loop.\n\nCall this function only when you are instructed to do so.',
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
    };
  }

  override async runAsync({
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    toolContext.actions.escalate = true;
    toolContext.actions.skipSummarization = true;
    return '';
  }
}

/**
 * A global instance of {@link ExitLoopTool}.
 */
export const EXIT_LOOP = new ExitLoopTool();
