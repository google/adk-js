/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';
import {type infer as zInfer, ZodObject} from 'zod';

import {isZodObject, zodObjectToSchema} from '../utils/simple_zod_to_json.js';

import {BaseTool} from './base_tool.js';
import {ToolContext} from './tool_context.js';

/**
 * Input parameters of the function tool.
 */
export type ToolInputParameters =|undefined|ZodObject<any>|Schema;

/*
 * The arguments of the function tool.
 */
export type ToolExecuteArgument<TParameters extends ToolInputParameters> =
    TParameters extends ZodObject<any>?
    zInfer<TParameters>:
    TParameters extends Schema ? unknown : string;

/*
 * The function to execute by the tool.
 */
type ToolExecuteFunction<
  TParameters extends ToolInputParameters,
> = (
  input: ToolExecuteArgument<TParameters>,
  tool_context?: ToolContext,
) => Promise<unknown> | unknown;

/**
 * The configuration options for creating a function-based tool.
 */
export type ToolOptions<
  TParameters extends ToolInputParameters,
> = {
  name?: string;
  description: string;
  parameters?: TParameters;
  execute: ToolExecuteFunction<TParameters>;
};

function toSchema<TParameters extends ToolInputParameters>(
    parameters: TParameters): Schema {
  if (parameters === undefined) {
    return {type: Type.OBJECT, properties: {}};
  }

  if (isZodObject(parameters)) {
    return zodObjectToSchema(parameters);
  }

  return parameters;
}

export class FunctionTool<
  TParameters extends ToolInputParameters = undefined,
> extends BaseTool {
  // User defined function.
  private readonly execute: ToolExecuteFunction<TParameters>;
  // Typed input parameters.
  private readonly parameters?: TParameters;

  /**
   * The constructor acts as the user-friendly factory.
   * @param options The configuration for the tool.
   */
  constructor(options: ToolOptions<TParameters>) {
    const name = options.name ?? (options.execute as any).name;
    if (!name) {
      throw new Error(
          'Tool name cannot be empty. Either name the `execute` function or provide a `name`.',
      );
    }
    super(name, options.description);
    this.execute = options.execute;
    this.parameters = options.parameters;
  }

  /**
   * Provide a schema for the function.
   */
  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: toSchema(this.parameters),
    };
  }

  /**
   * Logic for running the tool.
   */
  override async runAsync(
      args: Record<string, unknown>,
      toolContext: ToolContext): Promise<unknown> {
    try {
      let validatedArgs: unknown = args;
      if (this.parameters instanceof ZodObject) {
        validatedArgs = this.parameters.parse(args);
      }
      return await this.execute(
          validatedArgs as ToolExecuteArgument<TParameters>, toolContext);
    } catch (error) {
      const errorMessage =
          error instanceof Error ? error.message : String(error);
      throw new Error(`Error in tool '${this.name}': ${errorMessage}`);
    }
  }
}