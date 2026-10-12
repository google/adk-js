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

import {InvocationContext} from '../agents/invocation_context.js';
import {toGeminiSchema} from '../utils/gemini_schema_util.js';
import {SchemaLike, toJsonSchema} from '../utils/schema.js';

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
  /** Optional schema describing the tool's return value. */
  response?: SchemaLike;
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

/**
 * The parameters for `_callLive`.
 */
export interface CallLiveToolRequest {
  args: Record<string, unknown>;
  toolContext: Context;
  invocationContext: InvocationContext;
}

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

function toResponseSchema(response: SchemaLike): Schema {
  if (isZodObject(response)) {
    return zodObjectToSchema(response);
  }
  if (
    typeof response === 'object' &&
    response !== null &&
    'safeParse' in response &&
    typeof (response as {safeParse?: unknown}).safeParse === 'function'
  ) {
    return (
      toGeminiSchema(
        toJsonSchema(response) as Parameters<typeof toGeminiSchema>[0],
      ) ?? {type: Type.TYPE_UNSPECIFIED}
    );
  }
  return response as Schema;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as {[Symbol.asyncIterator]?: unknown})[
      Symbol.asyncIterator
    ] === 'function'
  );
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
  // Optional schema describing the tool's return value.
  private readonly response?: SchemaLike;
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
    this.response = options.response;
    this.requireConfirmation = options.requireConfirmation ?? false;
  }

  /**
   * Returns the function declaration derived from the tool's name, description,
   * and parameter schema.
   */
  override _getDeclaration(): FunctionDeclaration {
    if (this.response !== undefined) {
      return {
        name: this.name,
        description: this.description,
        parameters: toSchema(this.parameters),
        response: toResponseSchema(this.response),
      };
    }
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
   * Invokes the tool in live streaming mode, injecting any active input stream
   * from the invocation context and yielding items from the returned stream.
   *
   * @param req The live tool invocation request.
   */
  async *_callLive(
    req: CallLiveToolRequest,
  ): AsyncGenerator<unknown, void, void> {
    const validatedArgs = this.validateArgs(req.args);
    const argsToCall: Record<string, unknown> = isPlainRecord(validatedArgs)
      ? {...validatedArgs}
      : {...req.args};
    const activeTool = req.invocationContext.activeStreamingTools?.[this.name];
    if (activeTool?.stream) {
      argsToCall['inputStream'] = activeTool.stream;
    }
    const rawResult = this.execute(
      argsToCall as ToolExecuteArgument<TParameters>,
      req.toolContext,
    );
    if (isAsyncIterable(rawResult)) {
      for await (const item of rawResult) {
        yield item;
      }
      return;
    }
    const awaited = await rawResult;
    if (isAsyncIterable(awaited)) {
      for await (const item of awaited) {
        yield item;
      }
      return;
    }
    if (awaited !== undefined) {
      yield awaited;
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

const SCHEMA_TYPE_MAP: Readonly<Record<string, Type>> = {
  str: Type.STRING,
  int: Type.INTEGER,
  float: Type.NUMBER,
  bool: Type.BOOLEAN,
  string: Type.STRING,
  integer: Type.INTEGER,
  number: Type.NUMBER,
  boolean: Type.BOOLEAN,
  list: Type.ARRAY,
  array: Type.ARRAY,
  tuple: Type.ARRAY,
  object: Type.OBJECT,
  Dict: Type.OBJECT,
  List: Type.ARRAY,
  Tuple: Type.ARRAY,
  Any: Type.TYPE_UNSPECIFIED,
  STRING: Type.STRING,
  INTEGER: Type.INTEGER,
  NUMBER: Type.NUMBER,
  BOOLEAN: Type.BOOLEAN,
  ARRAY: Type.ARRAY,
  OBJECT: Type.OBJECT,
  NULL: Type.NULL,
  null: Type.NULL,
  TYPE_UNSPECIFIED: Type.TYPE_UNSPECIFIED,
};

function annotateNullableFields(schema: Record<string, unknown>): void {
  const properties = schema['properties'];
  if (!isPlainRecord(properties)) {
    return;
  }
  for (const propertySchema of Object.values(properties)) {
    if (!isPlainRecord(propertySchema)) {
      continue;
    }
    const anyOf = propertySchema['anyOf'];
    if (!Array.isArray(anyOf)) {
      continue;
    }
    for (let i = 0; i < anyOf.length; i++) {
      const branch = anyOf[i];
      if (
        isPlainRecord(branch) &&
        (branch['type'] === 'null' || branch['type'] === Type.NULL)
      ) {
        propertySchema['nullable'] = true;
        anyOf.splice(i, 1);
        break;
      }
    }
  }
}

function annotateRequiredFields(schema: Record<string, unknown>): void {
  const properties = schema['properties'];
  if (!isPlainRecord(properties)) {
    schema['required'] = [];
    return;
  }
  const required: string[] = [];
  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    if (
      isPlainRecord(fieldSchema) &&
      !fieldSchema['nullable'] &&
      !('default' in fieldSchema)
    ) {
      required.push(fieldName);
    }
  }
  schema['required'] = required;
}

function removeAnyOf(schema: Record<string, unknown>): void {
  const properties = schema['properties'];
  if (!isPlainRecord(properties)) {
    return;
  }
  for (const propertySchema of Object.values(properties)) {
    if (!isPlainRecord(propertySchema)) {
      continue;
    }
    const unionTypes = propertySchema['anyOf'];
    delete propertySchema['anyOf'];
    if (Array.isArray(unionTypes)) {
      for (const branch of unionTypes) {
        if (
          isPlainRecord(branch) &&
          branch['type'] !== 'null' &&
          branch['type'] !== Type.NULL
        ) {
          Object.assign(propertySchema, branch);
          break;
        }
      }
    }
  }
}

function removeDefault(schema: Record<string, unknown>): void {
  const properties = schema['properties'];
  if (!isPlainRecord(properties)) {
    return;
  }
  for (const propertySchema of Object.values(properties)) {
    if (isPlainRecord(propertySchema)) {
      delete propertySchema['default'];
    }
  }
}

function removeNullable(schema: Record<string, unknown>): void {
  const properties = schema['properties'];
  if (!isPlainRecord(properties)) {
    return;
  }
  for (const propertySchema of Object.values(properties)) {
    if (isPlainRecord(propertySchema)) {
      delete propertySchema['nullable'];
    }
  }
}

function removeTitle(schema: Record<string, unknown>): void {
  const properties = schema['properties'];
  if (!isPlainRecord(properties)) {
    return;
  }
  for (const propertySchema of Object.values(properties)) {
    if (isPlainRecord(propertySchema)) {
      delete propertySchema['title'];
    }
  }
}

function processParameterSchema(
  vertexai: boolean,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  annotateNullableFields(schema);
  annotateRequiredFields(schema);
  if (!vertexai) {
    removeAnyOf(schema);
    removeDefault(schema);
    removeNullable(schema);
    removeTitle(schema);
  }
  return schema;
}

function mapPropertySchemaType(propertySchema: Record<string, unknown>): void {
  if (typeof propertySchema['type'] === 'string') {
    propertySchema['type'] =
      SCHEMA_TYPE_MAP[propertySchema['type']] ?? Type.TYPE_UNSPECIFIED;
    if (
      propertySchema['type'] === Type.ARRAY &&
      isPlainRecord(propertySchema['items'])
    ) {
      mapPropertySchemaType(propertySchema['items']);
    }
  }
  if (isPlainRecord(propertySchema['properties'])) {
    for (const nestedProp of Object.values(propertySchema['properties'])) {
      if (isPlainRecord(nestedProp)) {
        mapPropertySchemaType(nestedProp);
      }
    }
  }
  if (Array.isArray(propertySchema['anyOf'])) {
    for (const branch of propertySchema['anyOf']) {
      if (isPlainRecord(branch) && typeof branch['type'] === 'string') {
        branch['type'] =
          SCHEMA_TYPE_MAP[branch['type']] ?? Type.TYPE_UNSPECIFIED;
        propertySchema['type'] = branch['type'];
      }
    }
  }
}

function mapSchemaTypes(schema: Record<string, unknown>): void {
  const properties = schema['properties'];
  if (!isPlainRecord(properties)) {
    return;
  }
  for (const propertySchema of Object.values(properties)) {
    if (isPlainRecord(propertySchema)) {
      mapPropertySchemaType(propertySchema);
    }
  }
}

function resolveReturnSchema(
  func: unknown,
  beforeParamSchema: Record<string, unknown>,
): Schema | undefined {
  const funcObj =
    typeof func === 'function' || isPlainRecord(func)
      ? (func as {response?: SchemaLike; returnType?: string})
      : undefined;
  const responseCandidate =
    funcObj?.response ??
    (beforeParamSchema['response'] as SchemaLike | undefined);
  if (responseCandidate !== undefined) {
    return toResponseSchema(responseCandidate);
  }
  const returnTypeCandidate =
    funcObj?.returnType ??
    (typeof beforeParamSchema['returnType'] === 'string'
      ? beforeParamSchema['returnType']
      : undefined);
  if (typeof returnTypeCandidate === 'string') {
    return {
      type: SCHEMA_TYPE_MAP[returnTypeCandidate] ?? Type.TYPE_UNSPECIFIED,
    };
  }
  if (typeof func === 'function') {
    return {type: Type.TYPE_UNSPECIFIED};
  }
  return undefined;
}

/**
 * Builds a `FunctionDeclaration` from a normalized parameter schema.
 */
export function buildFunctionDeclarationUtil(
  vertexai: boolean,
  name: string,
  description: string,
  func: unknown,
  beforeParamSchema: Record<string, unknown>,
): FunctionDeclaration {
  const schemaCopy = structuredClone(beforeParamSchema);
  mapSchemaTypes(schemaCopy);
  const properties = isPlainRecord(schemaCopy['properties'])
    ? (schemaCopy['properties'] as Record<string, Schema>)
    : {};
  const hasProperties = Object.keys(properties).length > 0;
  const declaration: FunctionDeclaration = {
    name,
    description,
  };
  if (hasProperties) {
    const parameters: Schema = {
      type: Type.OBJECT,
      properties,
    };
    if (
      Array.isArray(schemaCopy['required']) &&
      schemaCopy['required'].length > 0
    ) {
      parameters.required = schemaCopy['required'] as string[];
    }
    declaration.parameters = parameters;
  }
  if (vertexai) {
    const responseSchema = resolveReturnSchema(func, schemaCopy);
    if (responseSchema !== undefined) {
      declaration.response = responseSchema;
    }
  }
  return declaration;
}

/**
 * Builds a `FunctionDeclaration` for a LangChain tool parameter map.
 */
export function buildFunctionDeclarationForLangchain(
  vertexai: boolean,
  name: string,
  description: string,
  func: unknown,
  paramSchema: Record<string, unknown>,
): FunctionDeclaration {
  const rawCopy = structuredClone(paramSchema);
  const explicitRequired = Array.isArray(rawCopy['required'])
    ? (rawCopy['required'] as string[])
    : undefined;
  delete rawCopy['required'];
  const wrapped = processParameterSchema(vertexai, {
    properties: rawCopy,
  });
  const properties = isPlainRecord(wrapped['properties'])
    ? {...wrapped['properties']}
    : {};
  const computedRequired = Array.isArray(wrapped['required'])
    ? (wrapped['required'] as string[])
    : [];
  const requiredFields =
    explicitRequired !== undefined ? explicitRequired : computedRequired;
  return buildFunctionDeclarationUtil(vertexai, name, description, func, {
    properties,
    required: requiredFields,
  });
}

/**
 * Builds a `FunctionDeclaration` for a CrewAI tool parameter schema.
 */
export function buildFunctionDeclarationForParamsForCrewai(
  vertexai: boolean,
  name: string,
  description: string,
  func: unknown,
  paramSchema: Record<string, unknown>,
): FunctionDeclaration {
  const processed = processParameterSchema(
    vertexai,
    structuredClone(paramSchema),
  );
  return buildFunctionDeclarationUtil(vertexai, name, description, func, {
    ...processed,
  });
}
