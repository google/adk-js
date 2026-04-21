/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {isLlmAgent} from '../../agents/llm_agent.js';
import {CodeExecutionLanguage} from '../../code_executors/code_execution_utils.js';
import {experimental} from '../../utils/experimental.js';
import {materializeFiles} from '../../utils/file_utils.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {SkillToolset} from './skill_toolset.js';

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
        errorCode: 'MISSING_SCRIPT_CONTENT',
      };
    }
    if (!language) {
      return {
        error: 'Language is required.',
        errorCode: 'MISSING_LANGUAGE',
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
        errorCode: 'NO_CODE_EXECUTOR',
      };
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
        errorCode: 'EXECUTION_ERROR',
      };
    }
  }
}
