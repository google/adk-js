/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';

import {CodeExecutionInput, CodeExecutionResult} from './code_execution_utils.js';

/**
 * The parameters for executing code.
 * */
export interface ExecuteCodeParams {
  /** The invocation context of the code execution. */
  invocationContext: InvocationContext;
  /** The input of the code execution. */
  codeExecutionInput: CodeExecutionInput;
}

/**
 * A unique symbol to identify BaseCodeExecutor classes.
 * Defined once and shared by all BaseCodeExecutor instances.
 */
const BASE_CODE_EXECUTOR_SIGNATURE_SYMBOL = Symbol.for('google.adk.baseCodeExecutor');

/**
 * Type guard to check if an object is an instance of BaseCodeExecutor.
 * @param obj The object to check.
 * @returns True if the object is an instance of BaseCodeExecutor, false otherwise.
 */
export function isBaseCodeExecutor(obj: unknown): obj is BaseCodeExecutor {
  return typeof obj === 'object' && obj !== null &&
      BASE_CODE_EXECUTOR_SIGNATURE_SYMBOL in obj &&
      obj[BASE_CODE_EXECUTOR_SIGNATURE_SYMBOL] === true;
}

/**
 * The code executor allows the agent to execute code blocks from model
 * responses and incorporate the execution results into the final response.
 */
export abstract class BaseCodeExecutor {
  /** A unique symbol to identify BaseCodeExecutor class. */
  readonly [BASE_CODE_EXECUTOR_SIGNATURE_SYMBOL] = true;
  /**
   * If true, extract and process data files from the model request
   * and attach them to the code executor.
   *
   * Supported data file MimeTypes are [text/csv].
   * Default to false.
   */
  optimizeDataFile = false;

  /**
   * Whether the code executor is stateful. Default to false.
   */
  stateful = false;

  /**
   * The number of attempts to retry on consecutive code execution errors.
   * Default to 2.
   */
  errorRetryAttempts = 2;

  /**
   * The list of the enclosing delimiters to identify the code blocks.
   * For example, the delimiter('```python\\n', '\\n```') can be  used to
   * identify code blocks with the following format::
   *
   * ```python
   *  print("hello")
   * ```
   */
  codeBlockDelimiters: Array<[string, string]> = [
    ['```tool_code\n', '\n```'],
    ['```python\n', '\n```'],
  ];

  /**
   * The delimiters to format the code execution result.
   */
  executionResultDelimiters: [string, string] = ['```tool_output\n', '\n```'];

  /**
   * Executes code and return the code execution result.
   *
   * @param params The parameters for executing code.
   * @return The result of the code execution.
   */
  abstract executeCode(params: ExecuteCodeParams): Promise<CodeExecutionResult>;
}
