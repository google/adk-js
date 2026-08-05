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
 *
 * What the model is shown about the tool is built from these options: `name`,
 * `description` and the `parameters` schema become its function declaration.
 * TypeScript types and JSDoc are erased at runtime and cannot be read back, so
 * `description` is required and per-argument descriptions have to live in the
 * schema — typically as Zod `.describe()` calls.
 *
 * ```ts
 * new FunctionTool({
 *   name: 'get_weather',
 *   description: 'Returns the current weather for a city.',
 *   parameters: z.object({
 *     city: z.string().describe('City name, e.g. "San Francisco".'),
 *   }),
 *   execute: async ({city}) => fetchWeather(city),
 * });
 * ```
 *
 * A subclass may add to the declaration it derives from these options: given
 * the identical options, {@link LongRunningFunctionTool} appends a sentence to
 * `description` telling the model not to re-invoke a call that is still in
 * flight.
 *
 * `parameters` is a description for the model, and only a Zod object schema is
 * additionally enforced at call time — see {@link FunctionTool.runAsync}.
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
 * The tool's name, description, and parameter schema are exposed to the
 * model as a function declaration. When the model requests a call, the
 * framework invokes the user-provided `execute` callback with the arguments
 * the model produced.
 *
 * Those arguments are checked only when `parameters` is a Zod object schema:
 * it is applied with `parse()`, so a call that does not match is rejected and
 * `execute` receives the parsed value. Keys the schema does not declare are
 * handled however that schema says: a plain `z.object()` drops them,
 * `.passthrough()` forwards them, `.strict()` rejects the call. A plain
 * genai `Schema`, or no `parameters` at all, is shown to the model but is not
 * a runtime guard — the arguments reach `execute` exactly as the model
 * produced them, wrong types and extra keys included. Validate them inside
 * `execute` on that path.
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
   * Invokes the user-defined `execute` function with the model-provided
   * arguments, after parsing them when `parameters` is a Zod object schema.
   * Any other `parameters` value is passed through unchecked.
   *
   * @param req The tool request containing arguments and tool context.
   * @returns A promise resolving to the function's return value.
   * @throws {Error} Wrapped as `Error in tool '<name>': …` when a Zod
   *     `parameters` schema rejects the arguments or `execute` throws.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    try {
      let validatedArgs: unknown = req.args;
      if (isZodObject(this.parameters)) {
        validatedArgs = this.parameters.parse(req.args);
      }

      const pending = await this.checkConfirmation(
        validatedArgs as ToolExecuteArgument<TParameters>,
        req.toolContext,
      );
      if (pending !== undefined) {
        return pending;
      }

      return await this.execute(
        validatedArgs as ToolExecuteArgument<TParameters>,
        req.toolContext,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Error in tool '${this.name}': ${errorMessage}`);
    }
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
    const requireConfirmation =
      typeof this.requireConfirmation === 'function'
        ? await this.requireConfirmation(input, toolContext)
        : this.requireConfirmation;
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
