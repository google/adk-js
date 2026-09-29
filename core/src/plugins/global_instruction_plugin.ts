/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {injectSessionState} from '../agents/instructions.js';
import {InstructionProvider} from '../agents/llm_agent.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {BasePlugin} from './base_plugin.js';

/**
 * Plugin that provides global instructions functionality at the App level.
 *
 * This plugin replaces the deprecated globalInstruction field on LlmAgent.
 * Global instructions are applied to all agents in the application, providing
 * a consistent way to set application-wide instructions, identity, or
 * personality.
 *
 * The plugin operates through the beforeModelCallback, allowing it to modify
 * LLM requests before they are sent to the model.
 */
export class GlobalInstructionPlugin extends BasePlugin {
  private readonly globalInstruction?: string | InstructionProvider;

  /**
   * Initializes the GlobalInstructionPlugin.
   *
   * @param globalInstruction The instruction to apply globally. Can be a string
   *     or an InstructionProvider function that takes ReadonlyContext and
   *     returns a string (sync or async).
   * @param name The name of the plugin (defaults to 'global_instruction').
   */
  constructor(
    globalInstruction?: string | InstructionProvider,
    name = 'global_instruction',
  ) {
    super(name);
    this.globalInstruction = globalInstruction;
  }

  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    if (!this.globalInstruction) {
      return;
    }

    const readonlyContext = new ReadonlyContext(
      params.callbackContext.invocationContext,
    );
    const finalGlobalInstruction =
      await this.resolveGlobalInstruction(readonlyContext);

    if (!finalGlobalInstruction) {
      return;
    }

    if (!params.llmRequest.config) {
      params.llmRequest.config = {};
    }

    const existingInstruction = params.llmRequest.config.systemInstruction;

    if (
      !existingInstruction ||
      (Array.isArray(existingInstruction) && existingInstruction.length === 0)
    ) {
      params.llmRequest.config.systemInstruction = finalGlobalInstruction;
      return;
    }

    if (typeof existingInstruction === 'string') {
      params.llmRequest.config.systemInstruction = `${finalGlobalInstruction}\n\n${existingInstruction}`;
    } else if (Array.isArray(existingInstruction)) {
      params.llmRequest.config.systemInstruction = [
        finalGlobalInstruction,
        ...existingInstruction,
      ];
    } else {
      params.llmRequest.config.systemInstruction = [
        finalGlobalInstruction,
        existingInstruction,
      ] as unknown as string[];
    }

    return;
  }

  private async resolveGlobalInstruction(
    readonlyContext: ReadonlyContext,
  ): Promise<string> {
    if (typeof this.globalInstruction === 'string') {
      return await injectSessionState(this.globalInstruction, readonlyContext);
    }
    return await this.globalInstruction!(readonlyContext);
  }
}
