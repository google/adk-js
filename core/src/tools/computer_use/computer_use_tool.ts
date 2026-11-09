/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema} from '@google/genai';

import {Context} from '../../agents/context.js';
import {base64Encode} from '../../utils/env_aware_utils.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {RunAsyncToolRequest, ToolProcessLlmRequest} from '../base_tool.js';
import {FunctionTool} from '../function_tool.js';
import {checkComputerUseEnabled, ComputerState} from './base_computer.js';

/** The default virtual coordinate space the model works in. */
const DEFAULT_VIRTUAL_SCREEN_SIZE: readonly [number, number] = [1000, 1000];

/** Argument names that carry an x coordinate. */
const X_COORDINATE_FIELDS = ['x', 'destination_x', 'start_x', 'end_x'];

/** Argument names that carry a y coordinate. */
const Y_COORDINATE_FIELDS = ['y', 'destination_y', 'start_y', 'end_y'];

/** A whole number written as a string, such as `"250"`. */
const INTEGER_STRING = /^-?\d+$/;

/** The safety decision value that asks for user confirmation. */
const REQUIRE_CONFIRMATION = 'require_confirmation';

/**
 * The function a {@link ComputerUseTool} wraps. It receives the model's
 * arguments, with coordinates already scaled to the screen.
 */
export type ComputerUseFunction = (
  args: Record<string, unknown>,
  toolContext?: Context,
) => Promise<unknown> | unknown;

/**
 * The options for creating a {@link ComputerUseTool}.
 */
export interface ComputerUseToolOptions {
  /** The name of the computer use action, such as `click_at`. */
  name: string;
  /** The description of the action. */
  description: string;
  /** The schema of the action's arguments. */
  parameters?: Schema;
  /** The computer control function to wrap. */
  execute: ComputerUseFunction;
  /**
   * The actual screen size as (width, height) in pixels. This represents the
   * real dimensions of the target screen.
   */
  screenSize: readonly [number, number];
  /**
   * The virtual coordinate space as (width, height) that the model uses to
   * specify coordinates. Coordinates from the model are scaled from this space
   * to `screenSize`. Defaults to (1000, 1000), so the model works with a
   * 1000x1000 screen regardless of the actual screen dimensions.
   */
  virtualScreenSize?: readonly [number, number];
}

/** The safety decision a computer use model attaches to a risky action. */
interface SafetyDecision {
  decision?: unknown;
  explanation?: unknown;
}

const COMPUTER_USE_TOOL_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.computerUseTool',
);

/**
 * Type guard to check if an object is an instance of {@link ComputerUseTool}.
 *
 * @param obj The object to check.
 * @returns True if the object is an instance of ComputerUseTool, false
 *     otherwise.
 */
export function isComputerUseTool(obj: unknown): obj is ComputerUseTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    COMPUTER_USE_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[COMPUTER_USE_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * A tool that wraps computer control functions for use with LLMs.
 *
 * This tool scales coordinates from a virtual coordinate space (by default
 * 1000x1000) to the actual screen size. This lets the model work with a
 * consistent coordinate system regardless of the actual screen dimensions,
 * which makes its output more predictable.
 *
 * When the wrapped function returns a {@link ComputerState}, the tool returns
 * `{image: {mimetype, data}, url}` with the screenshot base64-encoded; the
 * agent then sends the image to the model as part of the function response.
 *
 * When the model marks a call with a `safety_decision` of
 * `require_confirmation`, the tool asks the user to confirm before it runs and
 * adds `safety_acknowledgement: 'true'` to the response once confirmed.
 */
@experimental
export class ComputerUseTool extends FunctionTool<Schema> {
  /** A unique symbol to identify ADK computer use tool class. */
  readonly [COMPUTER_USE_TOOL_SIGNATURE_SYMBOL] = true;

  /** The wrapped computer control function. */
  readonly func: ComputerUseFunction;
  /** The actual screen size as (width, height) in pixels. */
  readonly screenSize: readonly [number, number];
  /** The virtual coordinate space as (width, height). */
  readonly virtualScreenSize: readonly [number, number];

  /**
   * @param options The options for the tool.
   * @throws {Error} If `screenSize` or `virtualScreenSize` is not a pair of
   *     positive numbers.
   */
  constructor(options: ComputerUseToolOptions) {
    checkComputerUseEnabled();
    const virtualScreenSize =
      options.virtualScreenSize ?? DEFAULT_VIRTUAL_SCREEN_SIZE;
    checkScreenSize('screenSize', options.screenSize);
    checkScreenSize('virtualScreenSize', virtualScreenSize);
    const func = options.execute;
    super({
      name: options.name,
      description: options.description,
      parameters: options.parameters,
      execute: (input, toolContext) =>
        func(isRecord(input) ? input : {}, toolContext),
    });
    this.func = func;
    this.screenSize = options.screenSize;
    this.virtualScreenSize = virtualScreenSize;
  }

  /**
   * Runs the computer control function with scaled coordinates.
   *
   * @param request The tool request containing arguments and tool context.
   * @returns The function's result, with a {@link ComputerState} converted to
   *     a response carrying the base64-encoded screenshot.
   * @throws {Error} If a coordinate is not numeric, or the function returns a
   *     state with no screenshot.
   */
  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const confirmation = toolContext.toolConfirmation;
    if (!confirmation) {
      const safetyDecision = getSafetyDecision(args);
      if (safetyDecision?.decision === REQUIRE_CONFIRMATION) {
        toolContext.requestConfirmation({
          hint:
            typeof safetyDecision.explanation === 'string' &&
            safetyDecision.explanation
              ? safetyDecision.explanation
              : 'This computer use action requires safety confirmation.',
        });
        toolContext.actions.skipSummarization = true;
        return {
          error:
            'This tool call requires confirmation, please approve or reject.',
        };
      }
    } else if (!confirmation.confirmed) {
      return {error: 'This tool call is rejected.'};
    }

    const scaledArgs = this.scaleCoordinates(args);
    const result = await super.runAsync({args: scaledArgs, toolContext});

    let response = result;
    if (isComputerState(result)) {
      if (!result.screenshot) {
        throw new Error(
          'A computer action returned a state with no screenshot',
        );
      }
      response = {
        image: {mimetype: 'image/png', data: base64Encode(result.screenshot)},
        url: result.url,
      };
    }

    if (confirmation?.confirmed) {
      const acknowledged = isRecord(response) ? response : {result: response};
      acknowledged['safety_acknowledgement'] = 'true';
      return acknowledged;
    }
    return response;
  }

  /**
   * Whether this call needs user confirmation: when the model marked it with
   * a `safety_decision` of `require_confirmation`, or when the base tool says
   * so.
   *
   * @param args The arguments the tool would run with.
   * @param toolContext The context of the call, when there is one.
   * @returns Whether the call requires confirmation.
   */
  override async checkRequireConfirmation(
    args: Record<string, unknown>,
    toolContext?: Context,
  ): Promise<boolean> {
    if (getSafetyDecision(args)?.decision === REQUIRE_CONFIRMATION) {
      return true;
    }
    return super.checkRequireConfirmation(args, toolContext);
  }

  /**
   * Adds nothing to the request: {@link ComputerUseToolset} adds the single
   * computer use configuration and registers its tools by name.
   */
  override async processLlmRequest(
    _request: ToolProcessLlmRequest,
  ): Promise<void> {}

  /** Returns a copy of `args` with every coordinate scaled to the screen. */
  private scaleCoordinates(
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const scaled = {...args};
    delete scaled['safety_decision'];
    for (const field of X_COORDINATE_FIELDS) {
      if (field in scaled) {
        scaled[field] = scaleCoordinate({
          field,
          value: scaled[field],
          virtual: this.virtualScreenSize[0],
          actual: this.screenSize[0],
        });
      }
    }
    for (const field of Y_COORDINATE_FIELDS) {
      if (field in scaled) {
        scaled[field] = scaleCoordinate({
          field,
          value: scaled[field],
          virtual: this.virtualScreenSize[1],
          actual: this.screenSize[1],
        });
      }
    }
    return scaled;
  }
}

/**
 * Scales a model coordinate from the virtual space to the screen, clamped to
 * the screen bounds.
 *
 * @throws {Error} If the value is not a finite number or an integer string.
 */
function scaleCoordinate({
  field,
  value,
  virtual,
  actual,
}: {
  field: string;
  value: unknown;
  virtual: number;
  actual: number;
}): number {
  const numeric =
    typeof value === 'string' && INTEGER_STRING.test(value)
      ? Number(value)
      : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
    throw new Error(
      `${field} coordinate must be numeric, got ${typeof value} ${JSON.stringify(value)}`,
    );
  }
  const scaled = Math.max(
    0,
    Math.min(Math.trunc((numeric / virtual) * actual), actual - 1),
  );
  logger.debug(`Normalized ${field}: ${numeric} -> ${scaled}`);
  return scaled;
}

/** Throws unless `size` is a pair of positive numbers. */
function checkScreenSize(name: string, size: readonly number[]): void {
  if (!Array.isArray(size) || size.length !== 2) {
    throw new Error(`${name} must be a pair of (width, height)`);
  }
  if (!size.every((dimension) => Number.isFinite(dimension) && dimension > 0)) {
    throw new Error(`${name} dimensions must be positive`);
  }
}

/** Returns the model's safety decision for a call, if it attached one. */
function getSafetyDecision(
  args: Record<string, unknown>,
): SafetyDecision | undefined {
  const decision = args['safety_decision'];
  return isRecord(decision) ? decision : undefined;
}

/** Whether `value` is a plain object, not an array or `null`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `value` is a {@link ComputerState}: an object whose only fields are
 * a `Uint8Array` screenshot and a string url.
 */
function isComputerState(value: unknown): value is ComputerState {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (
    keys.length === 0 ||
    keys.some((k) => k !== 'screenshot' && k !== 'url')
  ) {
    return false;
  }
  const {screenshot, url} = value;
  return (
    (screenshot === undefined || screenshot instanceof Uint8Array) &&
    (url === undefined || typeof url === 'string')
  );
}
