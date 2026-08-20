/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

import {isZodObject, zodObjectToSchema} from '../utils/simple_zod_to_json.js';

import {Context} from '../agents/context.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/**
 * Input parameters of the function tool.
 */
export type ToolInputParameters =
  | z3.ZodObject<z3.ZodRawShape>
  | z4.ZodObject<z4.ZodRawShape>
  | Schema
  | undefined;

/**
 * The arguments passed to the function tool's `execute` callback, inferred
 * from the `parameters` schema type.
 */
export type ToolExecuteArgument<TParameters extends ToolInputParameters> =
  TParameters extends z3.ZodObject<infer T, infer U, infer V>
    ? z3.infer<z3.ZodObject<T, U, V>>
    : TParameters extends z4.ZodObject<infer T>
      ? z4.infer<z4.ZodObject<T>>
      : TParameters extends Schema
        ? unknown
        : string;

/**
 * The signature of the user-provided function executed by a {@link FunctionTool}.
 */
export type ToolExecuteFunction<TParameters extends ToolInputParameters> = (
  input: ToolExecuteArgument<TParameters>,
  toolContext?: Context,
) => Promise<unknown> | unknown;

/**
 * Whether a {@link FunctionTool} requires user confirmation before it runs: a
 * boolean, or a predicate over the (validated) call arguments and tool context.
 * See {@link ToolOptions.requireConfirmation}.
 */
export type RequireConfirmation<TParameters extends ToolInputParameters> =
  | boolean
  | ((
      input: ToolExecuteArgument<TParameters>,
      toolContext?: Context,
    ) => boolean | Promise<boolean>);

/**
 * The configuration options for creating a function-based tool.
 * The `name`, `description` and `parameters` fields are used to generate the
 * tool definition that is passed to the LLM prompt.
 *
 * Note: Unlike Python's ADK, JSDoc on the `execute` function is ignored
 * for tool definition generation.
 */
export type ToolOptions<TParameters extends ToolInputParameters> = {
  name?: string;
  description: string;
  parameters?: TParameters;
  execute: ToolExecuteFunction<TParameters>;
  isLongRunning?: boolean;
  /**
   * Whether this tool requires user confirmation before it runs. A boolean, or
   * a predicate over the (validated) call arguments and tool context returning
   * a boolean.
   *
   * The HITL gate is enforced when the tool is invoked through an `LlmAgent`
   * turn: `agents/functions.ts` surfaces an `adk_request_confirmation`
   * interrupt from the tool's `requestedToolConfirmations`, and the tool only
   * executes once the user approves (via the
   * `RequestConfirmationLlmRequestProcessor`).
   *
   * NOTE: a workflow `ToolNode` does not yet route through that path, so a
   * `requireConfirmation` tool used directly as a node does not pause — it
   * returns the "requires confirmation" error as its node output. Approval for
   * workflow nodes is not wired up. Mirrors Python's
   * `FunctionTool(require_confirmation=...)`.
   */
  requireConfirmation?: RequireConfirmation<TParameters>;
};

function toSchema<TParameters extends ToolInputParameters>(
  parameters: TParameters,
): Schema {
  if (parameters === undefined) {
    return {type: Type.OBJECT, properties: {}};
  }

  if (isZodObject(parameters)) {
    return zodObjectToSchema(parameters);
  }

  return parameters;
}

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all BaseTool instances.
 */
const FUNCTION_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.functionTool');

/**
 * Type guard to check if an object is an instance of BaseTool.
 * @param obj The object to check.
 * @returns True if the object is an instance of BaseTool, false otherwise.
 */
export function isFunctionTool(obj: unknown): obj is FunctionTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    FUNCTION_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[FUNCTION_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * A tool that wraps a user-defined function, making it callable by an LLM.
 *
 * The function's name, description, and parameter schema are exposed to the
 * model as a function declaration. When the model requests a call, the
 * framework validates the arguments and invokes the user-provided `execute`
 * callback.
 */
export class FunctionTool<
  TParameters extends ToolInputParameters = undefined,
> extends BaseTool {
  /** A unique symbol to identify ADK function tool class. */
  readonly [FUNCTION_TOOL_SIGNATURE_SYMBOL] = true;

  // User defined function.
  private readonly execute: ToolExecuteFunction<TParameters>;
  // Typed input parameters.
  private readonly parameters?: TParameters;
  // Whether the tool requires user confirmation before running.
  private readonly requireConfirmation: RequireConfirmation<TParameters>;

  /**
   * The constructor acts as the user-friendly factory.
   * @param options The configuration for the tool.
   */
  constructor(options: ToolOptions<TParameters>) {
    const name = options.name ?? (options.execute as {name?: string}).name;
    if (!name) {
      throw new Error(
        'Tool name cannot be empty. Either name the `execute` function or provide a `name`.',
      );
    }
    super({
      name,
      description: options.description,
      isLongRunning: options.isLongRunning,
    });
    this.execute = options.execute;
    this.parameters = options.parameters;
    this.requireConfirmation = options.requireConfirmation ?? false;
  }

  /**
   * Returns the function declaration derived from the tool's name, description,
   * and parameter schema.
   */
  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: toSchema(this.parameters),
    };
  }

  /**
   * Validates the model-provided arguments against the parameter schema and
   * invokes the user-defined `execute` function.
   *
   * @param req The tool request containing arguments and tool context.
   * @returns A promise resolving to the function's return value.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    try {
      const validatedArgs = this.validateArgs(req.args);

      const pending = await this.checkConfirmation(
        validatedArgs,
        req.toolContext,
      );
      if (pending !== undefined) {
        return pending;
      }

      return await this.execute(validatedArgs, req.toolContext);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Error in tool '${this.name}': ${errorMessage}`);
    }
  }

  /**
   * Whether this call is gated on human approval — the static flag, or the
   * predicate evaluated against the validated arguments.
   *
   * @param args The arguments the tool would run with.
   * @param toolContext The context of the call, when there is one.
   * @return Whether the call requires confirmation.
   */
  override async checkRequireConfirmation(
    args: Record<string, unknown>,
    toolContext?: Context,
  ): Promise<boolean> {
    // Only a predicate needs typed arguments. Validating for the static flag
    // would answer a question about the gate with a schema error.
    if (typeof this.requireConfirmation !== 'function') {
      return this.requireConfirmation;
    }
    return this.requireConfirmation(this.validateArgs(args), toolContext);
  }

  /** Parses `args` against the parameter schema, when one is declared. */
  private validateArgs(
    args: Record<string, unknown>,
  ): ToolExecuteArgument<TParameters> {
    if (isZodObject(this.parameters)) {
      return this.parameters.parse(args) as ToolExecuteArgument<TParameters>;
    }
    return args as ToolExecuteArgument<TParameters>;
  }

  /** Resolves `requireConfirmation`, which may be a flag or a predicate. */
  private async evaluateRequireConfirmation(
    input: ToolExecuteArgument<TParameters>,
    toolContext?: Context,
  ): Promise<boolean> {
    return typeof this.requireConfirmation === 'function'
      ? this.requireConfirmation(input, toolContext)
      : this.requireConfirmation;
  }

  /**
   * Evaluates the confirmation gate. Returns `undefined` if the tool may
   * proceed; otherwise returns the function response payload to surface instead
   * of running (a request-for-confirmation on the first pass, or a rejection
   * once the user declined).
   */
  private async checkConfirmation(
    input: ToolExecuteArgument<TParameters>,
    toolContext?: Context,
  ): Promise<{error: string} | undefined> {
    const requireConfirmation = await this.evaluateRequireConfirmation(
      input,
      toolContext,
    );
    if (!requireConfirmation) {
      return undefined;
    }
    if (!toolContext) {
      throw new Error(
        `Tool '${this.name}' requires confirmation but no tool context was provided.`,
      );
    }
    if (!toolContext.toolConfirmation) {
      toolContext.requestConfirmation({
        hint:
          `Please approve or reject the tool call ${this.name}() by ` +
          'responding with a FunctionResponse with an expected ' +
          'ToolConfirmation payload.',
      });
      toolContext.actions.skipSummarization = true;
      return {
        error:
          'This tool call requires confirmation, please approve or reject.',
      };
    }
    if (!toolContext.toolConfirmation.confirmed) {
      return {error: 'This tool call is rejected.'};
    }
    return undefined;
  }
}
