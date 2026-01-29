/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {LlmRequest} from '../models/llm_request.js';
import {isGemini2OrAbove} from '../utils/model_name.js';

import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {CodeExecutionResult} from './code_execution_utils.js';

/**
 * A unique symbol to identify BuiltInCodeExecutor classes.
 * Defined once and shared by all BuiltInCodeExecutor instances.
 */
const BUILT_IN_CODE_EXECUTOR_SIGNATURE_SYMBOL = Symbol.for('google.adk.builtInCodeExecutor');

/**
 * Type guard to check if an object is an instance of BuiltInCodeExecutor.
 * @param obj The object to check.
 * @returns True if the object is an instance of BuiltInCodeExecutor, false otherwise.
 */
export function isBuiltInCodeExecutor(obj: unknown): obj is BuiltInCodeExecutor {
  return typeof obj === 'object' && obj !== null &&
      BUILT_IN_CODE_EXECUTOR_SIGNATURE_SYMBOL in obj &&
      obj[BUILT_IN_CODE_EXECUTOR_SIGNATURE_SYMBOL] === true;
}

/**
 * A code executor that uses the Model's built-in code executor.
 *
 * Currently only supports Gemini 2.0+ models, but will be expanded to
 * other models.
 */
export class BuiltInCodeExecutor extends BaseCodeExecutor {
  /** A unique symbol to identify BuiltInCodeExecutor class. */
  readonly [BUILT_IN_CODE_EXECUTOR_SIGNATURE_SYMBOL] = true;

  executeCode(params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    return Promise.resolve({
      stdout: '',
      stderr: '',
      outputFiles: [],
    });
  }

  processLlmRequest(llmRequest: LlmRequest) {
    if (llmRequest.model && isGemini2OrAbove(llmRequest.model)) {
      llmRequest.config = llmRequest.config || {};
      llmRequest.config.tools = llmRequest.config.tools || [];
      llmRequest.config.tools.push({codeExecution: {}});

      return;
    }

    throw new Error(`Gemini code execution tool is not supported for model ${
        llmRequest.model}`);
  }
}
