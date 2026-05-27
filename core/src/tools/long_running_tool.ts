/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';

import {
  FunctionTool,
  ToolInputParameters,
  ToolOptions,
} from './function_tool.js';

const LONG_RUNNING_INSTRUCTION = `

NOTE: This is a long-running operation. Do not call this tool again if it has already returned some intermediate or pending status.`;

/**
 * A {@link FunctionTool} for long-running operations whose result is returned
 * asynchronously.
 *
 * The framework invokes the user-provided function and delivers the response
 * back to the model once it completes, identified by the `function_call_id`.
 * The model is also instructed not to re-invoke the tool while a call is
 * already in flight.
 */
export class LongRunningFunctionTool<
  TParameters extends ToolInputParameters = undefined,
> extends FunctionTool<TParameters> {
  /**
   * The constructor acts as the user-friendly factory.
   * @param options The configuration for the tool.
   */
  constructor(options: ToolOptions<TParameters>) {
    super({...options, isLongRunning: true});
  }

  /**
   * Returns the function declaration with an appended instruction warning the
   * model not to re-invoke the tool while it is still running.
   */
  override _getDeclaration(): FunctionDeclaration {
    const declaration = super._getDeclaration();
    if (declaration.description) {
      declaration.description += LONG_RUNNING_INSTRUCTION;
    } else {
      declaration.description = LONG_RUNNING_INSTRUCTION.trimStart();
    }
    return declaration;
  }
}
