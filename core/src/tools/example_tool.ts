/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ToolErrorType,
  ToolExecutionError,
} from '../errors/tool_execution_error.js';
import {
  BaseExampleProvider,
  isBaseExampleProvider,
} from '../examples/base_example_provider.js';
import {Example} from '../examples/example.js';
import {buildExampleSi, validateExamples} from '../examples/example_util.js';
import {appendInstructions} from '../models/llm_request.js';

import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';

/**
 * A tool that adds (few-shot) examples to the LLM request.
 *
 * This tool is executed for each LLM request and is never called by the model;
 * it only mutates the outgoing request by appending few-shot instructions built
 * from the latest user query.
 *
 * The constructor checks `examples` at runtime, so a malformed value fails
 * where it is supplied rather than on every later LLM request.
 */
export class ExampleTool extends BaseTool {
  /** The examples to add to the LLM request. */
  readonly examples: Example[] | BaseExampleProvider;

  /**
   * @param examples - A list of {@link Example}s, or a
   *   {@link BaseExampleProvider} that returns them for a query.
   * @throws {InputValidationError} When `examples` is a list holding a
   *   malformed entry.
   * @throws {ToolExecutionError} With {@link ToolErrorType.BAD_REQUEST} when
   *   `examples` is neither a list nor a {@link BaseExampleProvider}.
   */
  constructor(examples: Example[] | BaseExampleProvider) {
    super({
      // Name and description are not used because this tool only changes
      // llmRequest.
      name: 'example_tool',
      description: 'example tool',
    });
    if (Array.isArray(examples)) {
      validateExamples(examples);
    } else if (!isBaseExampleProvider(examples)) {
      throw new ToolExecutionError(
        'ExampleTool examples must be a list of examples or a ' +
          'BaseExampleProvider instance.',
        ToolErrorType.BAD_REQUEST,
      );
    }
    this.examples = examples;
  }

  override async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    // Should not be called by model because it's not declared in LLM tools list.
    throw new Error('ExampleTool should not be called by model');
  }

  override async processLlmRequest({
    toolContext,
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    const parts = toolContext.userContent?.parts;
    if (!parts || !parts[0]?.text) {
      return;
    }
    appendInstructions(llmRequest, [
      await buildExampleSi(this.examples, parts[0].text, llmRequest.model),
    ]);
  }
}
