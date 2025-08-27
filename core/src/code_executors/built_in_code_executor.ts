/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {GenerateContentConfig} from '@google/genai'

import {InvocationContext} from '../agents/invocation_context.js';
import {LlmRequest} from '../models/llm_request.js';
import {isGemini2Model} from '../utils/model_name.js';

import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {CodeExecutionInput, CodeExecutionResult} from './code_execution_utils.js';

/**
 * A code executor that uses the Model's built-in code executor.
 *
 * Currently only supports Gemini 2.0+ models, but will be expanded to
 * other models.
 */
export class BuiltInCodeExecutor extends BaseCodeExecutor {
  executeCode(params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    return Promise.resolve({
      stdout: '',
      stderr: '',
      outputFiles: [],
    });
  }

  processLlmRequest(llmRequest: LlmRequest) {
    if (llmRequest.model && isGemini2Model(llmRequest.model)) {
      llmRequest.config = llmRequest.config || {};
      llmRequest.config.tools = llmRequest.config.tools || [];
      llmRequest.config.tools.push({codeExecution: {}});

      return;
    }

    throw new Error(`Gemini code execution tool is not supported for model ${
        llmRequest.model}`);
  }
}
