/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {cloneDeep} from 'lodash-es';

import {State} from '../sessions/state.js';

import {File} from './code_execution_utils.js';

const CONTEXT_KEY = '_code_execution_context';
const SESSION_ID_KEY = 'execution_session_id';
const PROCESSED_FILE_NAMES_KEY = 'processed_input_files';
const INPUT_FILE_KEY = '_code_executor_input_files';
const ERROR_COUNT_KEY = '_code_executor_error_counts';
const CODE_EXECUTION_RESULTS_KEY = '_code_execution_results';

interface CodeExecutionResult {
  code: string;
  resultStdout: string;
  resultStderr: string;
  timestamp: number;
}

/**
 * The parameters for updating the code execution result.
 * */
export interface UpdateCodeExecutionResultParams {
  invocationId: string;
  code: string;
  resultStdout: string;
  resultStderr: string;
}

/**
 * The persistent context used to configure the code executor.
 */
export class CodeExecutorContext {
  private readonly context:
      {[SESSION_ID_KEY]?: string;[PROCESSED_FILE_NAMES_KEY]?: string[];};

  constructor(private readonly sessionState: State) {
    this.context = sessionState.get(CONTEXT_KEY) ?? {};
    this.sessionState = sessionState;
  }

  /**
   * Gets the state delta to update in the persistent session state.
   * @return The state delta to update in the persistent session state.
   */
  getStateDelta(): Record<string, unknown> {
    return {
      [CONTEXT_KEY]: cloneDeep(this.context),
    };
  }

  /**
   * Gets the execution ID for the code executor.
   * @return The execution ID for the code executor.
   */
  getExecutionId(): string|undefined {
    if (!(SESSION_ID_KEY in this.context)) {
      return undefined;
    }

    return this.context[SESSION_ID_KEY];
  }

  /**
   * Sets the execution ID for the code executor.
   * @param executionId The execution ID to set.
   */
  setExecutionId(executionId: string) {
    this.context[SESSION_ID_KEY] = executionId;
  }

  /**
   * Gets the processed file names from the session state.
   * @return A list of processed file names in the code executor context.
   */
  getProcessedFileNames(): string[] {
    if (!(PROCESSED_FILE_NAMES_KEY in this.context)) {
      return [];
    }

    return this.context[PROCESSED_FILE_NAMES_KEY]!;
  }

  /**
   * Adds the processed file names to the session state.
   * @param fileNames The file names to add to the session state.
   */
  addProcessedFileNames(fileNames: string[]) {
    if (!(PROCESSED_FILE_NAMES_KEY in this.context)) {
      this.context[PROCESSED_FILE_NAMES_KEY] = [];
    }

    this.context[PROCESSED_FILE_NAMES_KEY]!.push(...fileNames);
  }

  /**
   * Gets the input files from the session state.
   * @return A list of input files in the code executor context.
   */
  getInputFiles(): File[] {
    if (!(INPUT_FILE_KEY in this.sessionState)) {
      return [];
    }

    return this.sessionState.get(INPUT_FILE_KEY) as File[];
  }

  /**
   * Adds the input files to the session state.
   * @param inputFiles The input files to add to the session state.
   */
  addInputFiles(inputFiles: File[]) {
    if (!(INPUT_FILE_KEY in this.sessionState)) {
      this.sessionState.set(INPUT_FILE_KEY, []);
    }

    (this.sessionState.get(INPUT_FILE_KEY) as File[]).push(...inputFiles);
  }

  clearInputFiles() {
    if (INPUT_FILE_KEY in this.sessionState) {
      this.sessionState.set(INPUT_FILE_KEY, []);
    }

    if (PROCESSED_FILE_NAMES_KEY in this.context) {
      this.context[PROCESSED_FILE_NAMES_KEY] = [];
    }
  }

  /**
   * Gets the error count from the session state.
   * @param invocationId The invocation ID to get the error count for.
   * @return The error count for the given invocation ID.
   */
  getErrorCount(invocationId: string): number {
    if (!(ERROR_COUNT_KEY in this.sessionState)) {
      return 0;
    }

    return (this.sessionState.get(ERROR_COUNT_KEY) as
            Record<string, number>)[invocationId] as number ||
        0;
  }

  /**
   * Increments the error count from the session state.
   * @param invocationId The invocation ID to increment the error count for.
   */
  incrementErrorCount(invocationId: string) {
    if (!(ERROR_COUNT_KEY in this.sessionState)) {
      this.sessionState.set(ERROR_COUNT_KEY, {});
    }

    (this.sessionState.get(ERROR_COUNT_KEY) as
     Record<string, number>)[invocationId] =
        (this.getErrorCount(invocationId) + 1);
  }

  /**
   * Resets the error count from the session state.
   * @param invocationId The invocation ID to reset the error count for.
   */
  resetErrorCount(invocationId: string) {
    if (!(ERROR_COUNT_KEY in this.sessionState)) {
      return;
    }

    const errorCounts =
        this.sessionState.get(ERROR_COUNT_KEY) as Record<string, number>;

    if (invocationId in errorCounts) {
      delete errorCounts[invocationId];
    }
  }

  /**
   * Updates the code execution result.
   * @param invocationId The invocation ID to update the code execution result
   *     for.
   * @param code The code to execute.
   * @param resultStdout The standard output of the code execution.
   * @param resultStderr The standard error of the code execution.
   */
  updateCodeExecutionResult({
    invocationId,
    code,
    resultStdout,
    resultStderr,
  }: UpdateCodeExecutionResultParams) {
    if (!(CODE_EXECUTION_RESULTS_KEY in this.sessionState)) {
      this.sessionState.set(CODE_EXECUTION_RESULTS_KEY, {});
    }

    const codeExecutionResults =
        this.sessionState.get(CODE_EXECUTION_RESULTS_KEY) as
        Record<string, CodeExecutionResult[]>;

    if (!(invocationId in codeExecutionResults)) {
      codeExecutionResults[invocationId] = [];
    }

    codeExecutionResults[invocationId].push({
      code,
      resultStdout,
      resultStderr,
      timestamp: Date.now(),
    });
  }

  /**
   * Gets the code executor context from the session state.
   * @param invocationId The session state to get the code executor context
   *     from.
   * @return The code execution context for the given invocation ID.
   */
  getCodeExecutionContext(invocationId: string): Record<string, unknown> {
    return this.sessionState.get(CONTEXT_KEY) || {};
  }
}