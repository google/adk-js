/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';

import {appendInstructions} from '../models/llm_request.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';

/** The name of the finish_task tool. */
export const FINISH_TASK_TOOL_NAME = 'finish_task';

/**
 * The result returned by {@link FinishTaskTool.runAsync} when validation passes.
 * The task-mode wrapper uses this to distinguish a successful completion from a
 * validation-error retry signal.
 */
export const FINISH_TASK_SUCCESS_RESULT = 'Task completed.';

/** The default output schema when the task agent declares none. */
const DEFAULT_TASK_OUTPUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    result: {
      type: Type.STRING,
      description: 'A brief summary of what the agent accomplished.',
    },
  },
  required: ['result'],
};

/**
 * Tool for signaling that a task-mode {@link LlmAgent} has completed its task.
 *
 * The tool's parameters mirror the agent's `outputSchema` (or a default single
 * `result` string). The task-mode wrapper sniffs the `finish_task` function call
 * and, on a successful function response, promotes the call's arguments to the
 * node's output.
 *
 * Ported from `google/adk-python`
 * `agents/llm/task/_finish_task_tool.py::FinishTaskTool`.
 */
export class FinishTaskTool extends BaseTool {
  /** The schema describing the expected task output. */
  private readonly outputSchema: Schema;
  /**
   * When the output schema is a non-object (primitive/array), the value is
   * wrapped under this key (the GenAI API requires object-typed parameters).
   * `undefined` for object schemas (the value lives at the top level of args).
   */
  readonly wrapperKey?: string;

  constructor(outputSchema?: Schema) {
    const schema = outputSchema ?? DEFAULT_TASK_OUTPUT_SCHEMA;
    let description =
      'Signal that this agent has completed its delegated task. Call this' +
      ' when you have finished your delegated task.';
    if (outputSchema) {
      description += ' Pass the required output data in the parameters.';
    }
    super({name: FINISH_TASK_TOOL_NAME, description});
    this.outputSchema = schema;
    this.wrapperKey = schema.type === Type.OBJECT ? undefined : 'result';
  }

  override _getDeclaration(): FunctionDeclaration {
    const parameters: Schema = this.wrapperKey
      ? {
          type: Type.OBJECT,
          properties: {[this.wrapperKey]: this.outputSchema},
          required: [this.wrapperKey],
        }
      : this.outputSchema;
    return {name: this.name, description: this.description, parameters};
  }

  override async processLlmRequest(
    request: ToolProcessLlmRequest,
  ): Promise<void> {
    await super.processLlmRequest(request);
    // Tell the model when to call finish_task (mirrors Python's tool
    // instruction), so it completes the task deliberately.
    appendInstructions(request.llmRequest, [
      'Do NOT call `finish_task` prematurely. Use your available tools to fully' +
        ' complete every aspect of the task first. If the task is unclear, ask' +
        ' the user for clarification before proceeding. Once the task is fully' +
        ' complete, call `finish_task` by itself with no accompanying text' +
        ' output.',
    ]);
  }

  /**
   * Extracts the task output from a `finish_task` call's arguments, applying the
   * wrapper-key unwrapping when the schema is a non-object.
   */
  extractOutput(args: Record<string, unknown>): unknown {
    if (this.wrapperKey) {
      return args[this.wrapperKey];
    }
    return args;
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const value = this.wrapperKey ? args[this.wrapperKey] : args;
    const missing = this.missingRequiredKeys(value);
    if (missing.length > 0) {
      return {
        error:
          `Invoking \`${this.name}()\` failed due to missing required ` +
          `parameters: ${missing.join(', ')}. You could retry calling this ` +
          'tool, but it is IMPORTANT for you to provide all the mandatory ' +
          'parameters with correct types.',
      };
    }
    return FINISH_TASK_SUCCESS_RESULT;
  }

  /** Returns any `required` keys the schema declares that are absent. */
  private missingRequiredKeys(value: unknown): string[] {
    const required = this.wrapperKey
      ? value === undefined || value === null
        ? [this.wrapperKey]
        : []
      : (this.outputSchema.required ?? []);
    if (this.wrapperKey) {
      return required;
    }
    if (typeof value !== 'object' || value === null) {
      return required;
    }
    const obj = value as Record<string, unknown>;
    return required.filter((key) => obj[key] === undefined);
  }
}
