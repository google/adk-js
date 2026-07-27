/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {Context} from '../../agents/context.js';
import {isLlmAgent} from '../../agents/llm_agent.js';
import {CodeExecutionLanguage} from '../../code_executors/code_execution_utils.js';
import {experimental} from '../../utils/experimental.js';
import {materializeFiles} from '../../utils/file_utils.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {SkillToolset} from './skill_toolset.js';

/**
 * Error codes returned by {@link RunSkillInlineScriptTool} when a call cannot
 * be completed. The string values are part of the tool's response contract and
 * must remain stable.
 */
export enum RunSkillInlineScriptErrorCode {
  MISSING_SCRIPT_CONTENT = 'MISSING_SCRIPT_CONTENT',
  MISSING_LANGUAGE = 'MISSING_LANGUAGE',
  NO_CODE_EXECUTOR = 'NO_CODE_EXECUTOR',
  EXECUTION_ERROR = 'EXECUTION_ERROR',
  CONFIRMATION_REJECTED = 'CONFIRMATION_REJECTED',
}

/**
 * Message returned while the tool call is paused waiting for the client to
 * confirm (or reject) execution of the model-provided inline script. Mirrors
 * the intermediate message used by the tool-confirmation flow elsewhere in the
 * codebase (see `SecurityPlugin`).
 */
const REQUIRE_CONFIRMATION_MESSAGE =
  'This tool call needs external confirmation before completion.';

@experimental
export class RunSkillInlineScriptTool extends BaseTool {
  constructor(private toolset: SkillToolset) {
    super({
      name: 'run_skill_inline_script',
      description:
        'Executes an inline script provided directly in the request.',
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          script_content: {
            type: Type.STRING,
            description: 'The content of the script to execute.',
          },
          language: {
            type: Type.STRING,
            description: 'The language/type of the script.',
            enum: Object.values(CodeExecutionLanguage).filter(
              (l) => l !== CodeExecutionLanguage.UNSPECIFIED,
            ),
          },
          args: {
            anyOf: [
              {type: Type.OBJECT},
              {type: Type.ARRAY, items: {type: Type.STRING}},
            ],
            description:
              'Optional arguments to pass to the script as key-value pairs or an array of strings.',
          },
        },
        required: ['script_content', 'language'],
      },
    };
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const inlineScriptContent = args['script_content'] as string;
    const language = args['language'] as string;
    const scriptArgs = args['args'] as
      | string[]
      | Record<string, string | number | boolean>
      | undefined;

    if (!inlineScriptContent) {
      return {
        error: 'Script content is required.',
        errorCode: RunSkillInlineScriptErrorCode.MISSING_SCRIPT_CONTENT,
      };
    }
    if (!language) {
      return {
        error: 'Language is required.',
        errorCode: RunSkillInlineScriptErrorCode.MISSING_LANGUAGE,
      };
    }

    let codeExecutor = this.toolset?.codeExecutor;
    if (!codeExecutor) {
      const agent = toolContext.invocationContext.agent;
      if (isLlmAgent(agent)) {
        codeExecutor = agent.codeExecutor;
      }
    }

    if (!codeExecutor) {
      return {
        error: 'No code executor configured.',
        errorCode: RunSkillInlineScriptErrorCode.NO_CODE_EXECUTOR,
      };
    }

    // Security gate: executing model-provided script content is equivalent to
    // arbitrary code execution in the code executor's context. Require an
    // explicit, server-enforced confirmation before dispatching so that a
    // prompt-injection cannot silently run code.
    const confirmationResult = this.enforceConfirmation(
      toolContext,
      inlineScriptContent,
      language,
    );
    if (confirmationResult) {
      return confirmationResult;
    }

    try {
      const result = await codeExecutor.executeCode({
        invocationContext: toolContext.invocationContext,
        codeExecutionInput: {
          code: inlineScriptContent,
          inputFiles: [],
          language: language as CodeExecutionLanguage,
          args: scriptArgs,
        },
      });

      // Final filename could be different if there was a collision, so update the result.
      result.outputFiles = await materializeFiles(result.outputFiles);

      return result;
    } catch (e: unknown) {
      return {
        error: `Failed to execute inline script: ${(e as Error).message}`,
        errorCode: RunSkillInlineScriptErrorCode.EXECUTION_ERROR,
      };
    }
  }

  /**
   * Enforces a human-in-the-loop confirmation gate before executing an inline
   * script, using the repo's standard tool-confirmation mechanism.
   *
   * - When no confirmation has been provided yet, a confirmation is requested
   *   (surfacing the language and script that would run) and an intermediate
   *   result is returned so the tool call pauses until the client responds.
   * - When a confirmation exists but was not confirmed, a rejection error is
   *   returned and execution is refused.
   * - When the confirmation is confirmed, `undefined` is returned to allow the
   *   caller to proceed with execution.
   */
  private enforceConfirmation(
    toolContext: Context,
    scriptContent: string,
    language: string,
  ):
    | {partial: string}
    | {error: string; errorCode: RunSkillInlineScriptErrorCode}
    | undefined {
    const confirmation = toolContext.toolConfirmation;

    if (!confirmation) {
      toolContext.requestConfirmation({
        hint:
          'Confirmation is required before executing an inline skill script. ' +
          `The agent requested to run the following ${language} script in the ` +
          'code executor. Only approve if you trust its contents:\n\n' +
          scriptContent,
        payload: {language, scriptContent},
      });
      return {partial: REQUIRE_CONFIRMATION_MESSAGE};
    }

    if (!confirmation.confirmed) {
      return {
        error: 'Inline script execution was not confirmed and was rejected.',
        errorCode: RunSkillInlineScriptErrorCode.CONFIRMATION_REJECTED,
      };
    }

    return undefined;
  }
}
