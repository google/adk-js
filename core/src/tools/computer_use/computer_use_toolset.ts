/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Environment, Tool, ToolUnion} from '@google/genai';

import {Context} from '../../agents/context.js';
import {LlmRequest} from '../../models/llm_request.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {getGeminiMajorVersion} from '../../utils/model_name.js';
import {BaseToolset} from '../base_toolset.js';
import {
  BaseComputer,
  checkComputerUseEnabled,
  ComputerEnvironment,
} from './base_computer.js';
import {
  ComputerAction,
  createComputerActions,
  LEGACY_ACTION_NAMES,
  OPTIONAL_KEY_ACTIONS,
  OPTIONAL_MOUSE_ACTIONS,
  unimplementedOptionalActions,
} from './computer_use_actions.js';
import {
  ComputerUseFunction,
  ComputerUseTool,
  isComputerUseTool,
} from './computer_use_tool.js';

/**
 * How excluding one action name carries over to its counterparts across the
 * legacy and the Gemini 3.x action schemas.
 */
const DIRECT_EXCLUSION_MAP: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    // Legacy -> modern.
    click_at: ['click'],
    hover_at: ['move'],
    type_text_at: ['type'],
    type_text: ['type'],
    scroll_at: ['scroll'],
    // Whole-page scroll has no modern counterpart.
    scroll_document: [],
    current_state: ['take_screenshot'],
    key_combination: ['press_key', 'hotkey'],
    wait_5_seconds: ['wait'],
    // Modern -> legacy.
    click: ['click_at'],
    move: ['hover_at'],
    type: ['type_text_at'],
    // Does not drop scroll_document.
    scroll: ['scroll_at'],
    take_screenshot: ['current_state'],
    // key_combination is dropped only when both of these are excluded.
    press_key: [],
    hotkey: [],
    wait: ['wait_5_seconds'],
  });

const LEGACY_EXCLUSION_NAMES = new Set([
  'click_at',
  'hover_at',
  'type_text_at',
  'type_text',
  'scroll_at',
  'scroll_document',
  'current_state',
  'key_combination',
  'wait_5_seconds',
]);

const MODERN_EXCLUSION_NAMES = new Set<string>([
  'click',
  'move',
  'type',
  'scroll',
  'take_screenshot',
  'press_key',
  'hotkey',
  'wait',
  ...OPTIONAL_MOUSE_ACTIONS,
  ...OPTIONAL_KEY_ACTIONS,
]);

const TYPING_ACTIONS = ['type', 'type_text_at', 'type_text'];

/** The tail of the queue of actions running on each computer. */
const computerQueues = new WeakMap<BaseComputer, Promise<void>>();

/**
 * Expands configured exclusions across legacy and Gemini 3.x action names, so
 * excluding an action also hides the tools that perform it.
 *
 * @param excludedNames The configured exclusions.
 * @returns Every tool name that must not be exposed.
 */
function expandLocalExclusions(excludedNames: readonly string[]): Set<string> {
  const expanded = new Set(excludedNames);
  for (const name of excludedNames) {
    for (const counterpart of DIRECT_EXCLUSION_MAP[name] ?? []) {
      expanded.add(counterpart);
    }
  }
  if (TYPING_ACTIONS.some((name) => expanded.has(name))) {
    TYPING_ACTIONS.forEach((name) => expanded.add(name));
  }
  if (expanded.has('press_key') && expanded.has('hotkey')) {
    expanded.add('key_combination');
  }
  return expanded;
}

/**
 * Translates configured exclusions into the action schema of the target model.
 *
 * Gemini 1.x and 2.x models use the legacy action names. Every other model,
 * including aliases such as `gemini-flash-latest` and custom endpoints, uses
 * the Gemini 3.x names. For Gemini 3.x models the optional actions the
 * computer does not implement are excluded too, so the model does not call
 * them.
 *
 * @param options.excludedNames The configured exclusions.
 * @param options.model The model the request is sent to.
 * @param options.unimplementedActions The optional actions the computer does
 *     not implement.
 * @returns The names for `excludedPredefinedFunctions`, or `undefined` when
 *     nothing was configured and nothing needs to be excluded.
 */
function resolveExcludedPredefinedFunctions({
  excludedNames,
  model,
  unimplementedActions,
}: {
  excludedNames: readonly string[] | undefined;
  model: string | undefined;
  unimplementedActions: readonly string[];
}): string[] | undefined {
  const major = getGeminiMajorVersion(model);
  if (major !== undefined && major < 3) {
    if (excludedNames === undefined) {
      return undefined;
    }
    const bothModernKeys =
      excludedNames.includes('press_key') && excludedNames.includes('hotkey');
    const resolved: string[] = [];
    for (const name of excludedNames) {
      if (name === 'press_key' || name === 'hotkey') {
        if (bothModernKeys) {
          resolved.push('key_combination');
        }
      } else if (name === 'type_text') {
        resolved.push('type_text_at');
      } else if (MODERN_EXCLUSION_NAMES.has(name)) {
        resolved.push(...(DIRECT_EXCLUSION_MAP[name] ?? []));
      } else {
        resolved.push(name);
      }
    }
    return [...new Set(resolved)];
  }

  const resolved: string[] = [];
  for (const name of excludedNames ?? []) {
    if (LEGACY_EXCLUSION_NAMES.has(name)) {
      resolved.push(...DIRECT_EXCLUSION_MAP[name]);
    } else {
      resolved.push(name);
    }
  }
  if (major !== undefined && major >= 3) {
    resolved.push(...unimplementedActions);
  }
  const deduped = [...new Set(resolved)];
  if (deduped.length === 0 && excludedNames === undefined) {
    return undefined;
  }
  return deduped;
}

/**
 * Runs `action` after every earlier action on `computer` has settled.
 *
 * Gemini 3.x can return several actions in one response, and sessions can
 * share a computer. Serializing them lets each action's `prepare()` and
 * execution finish before another action rebinds the computer's state or takes
 * a screenshot.
 */
async function runExclusive<T>(
  computer: BaseComputer,
  action: () => Promise<T>,
): Promise<T> {
  const previous = computerQueues.get(computer) ?? Promise.resolve();
  const result = previous.then(action);
  computerQueues.set(
    computer,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/** Maps a {@link ComputerEnvironment} onto the `@google/genai` environment. */
function toGenaiEnvironment(environment: ComputerEnvironment): Environment {
  switch (environment) {
    case ComputerEnvironment.ENVIRONMENT_UNSPECIFIED:
      return Environment.ENVIRONMENT_UNSPECIFIED;
    case ComputerEnvironment.ENVIRONMENT_BROWSER:
      return Environment.ENVIRONMENT_BROWSER;
    default: {
      const exhaustive: never = environment;
      throw new Error(`Unknown computer environment: ${exhaustive}`);
    }
  }
}

/** Whether a request tool already carries a computer use configuration. */
function isComputerUseConfig(tool: ToolUnion): boolean {
  return 'computerUse' in tool && (tool as Tool).computerUse !== undefined;
}

/**
 * A computer use function, as returned by the adapter passed to
 * {@link adaptComputerUseTool}.
 */
export interface AdaptedComputerUseFunction {
  /** The name of the new tool. */
  name: string;
  /** The description of the new tool. */
  description: string;
  /** The new computer use function. */
  execute: ComputerUseFunction;
}

/** The parameters of {@link adaptComputerUseTool}. */
export interface AdaptComputerUseToolParams {
  /** The predefined action to adapt, such as `wait`. */
  methodName: string;
  /**
   * Receives the original computer use function and returns the new one. It
   * may be async.
   */
  adapter: (
    func: ComputerUseFunction,
  ) => AdaptedComputerUseFunction | Promise<AdaptedComputerUseFunction>;
  /** The request holding the tools. */
  llmRequest: LlmRequest;
}

/**
 * Replaces a computer use tool in the request with an adapted version.
 *
 * The adapted tool keeps the original tool's screen size and virtual screen
 * size. When the adapted function has a new name, the original tool is
 * removed from the request.
 *
 * @param params The action to adapt, the adapter and the request.
 */
export async function adaptComputerUseTool({
  methodName,
  adapter,
  llmRequest,
}: AdaptComputerUseToolParams): Promise<void> {
  if (!LEGACY_ACTION_NAMES.includes(methodName)) {
    logger.warn(`Method ${methodName} is not a valid BaseComputer method`);
    return;
  }
  const original = Object.hasOwn(llmRequest.toolsDict, methodName)
    ? llmRequest.toolsDict[methodName]
    : undefined;
  if (!isComputerUseTool(original)) {
    logger.warn(`Method ${methodName} not found in toolsDict`);
    return;
  }

  const adapted = await adapter(original.func);
  llmRequest.toolsDict[adapted.name] = new ComputerUseTool({
    ...adapted,
    screenSize: original.screenSize,
    virtualScreenSize: original.virtualScreenSize,
  });
  if (adapted.name !== methodName) {
    delete llmRequest.toolsDict[methodName];
  }
  logger.debug(`Adapted tool ${methodName} to ${adapted.name}`);
}

/**
 * The options for creating a {@link ComputerUseToolset}.
 */
export interface ComputerUseToolsetOptions {
  /** The computer environment to expose as tools. */
  computer: BaseComputer;
  /**
   * Names of computer use actions that should not be exposed as tools. Both
   * legacy names (such as `click_at`) and Gemini 3.x names (such as `click`)
   * are accepted. Each is expanded to its counterpart locally, and translated
   * to the target model's action schema in the request.
   */
  excludedPredefinedFunctions?: readonly string[];
  /**
   * By default `navigate` refuses urls whose host is not publicly routable.
   * Set this to true when the agent is meant to drive the browser against
   * localhost or an internal host.
   */
  allowPrivateNetworkAccess?: boolean;
}

const COMPUTER_USE_TOOLSET_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.computerUseToolset',
);

/**
 * Type guard to check if an object is an instance of
 * {@link ComputerUseToolset}.
 *
 * @param obj The object to check.
 * @returns True if the object is an instance of ComputerUseToolset, false
 *     otherwise.
 */
export function isComputerUseToolset(obj: unknown): obj is ComputerUseToolset {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    COMPUTER_USE_TOOLSET_SIGNATURE_SYMBOL in obj &&
    obj[COMPUTER_USE_TOOLSET_SIGNATURE_SYMBOL] === true
  );
}

/**
 * A toolset that exposes the actions of a {@link BaseComputer} to an agent.
 *
 * The toolset initializes the computer on first use and wraps each action in a
 * {@link ComputerUseTool}. Actions on one computer run one at a time, and the
 * computer's `prepare()` runs before each of them. When the agent builds a
 * request, the toolset registers its tools and adds the computer use
 * configuration that tells the model which predefined actions it may call.
 *
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'browser_agent',
 *   model: 'gemini-flash-latest',
 *   tools: [new ComputerUseToolset({computer: new MyBrowserComputer()})],
 * });
 * ```
 */
@experimental
export class ComputerUseToolset extends BaseToolset {
  /** A unique symbol to identify ADK computer use toolset class. */
  readonly [COMPUTER_USE_TOOLSET_SIGNATURE_SYMBOL] = true;

  private readonly computer: BaseComputer;
  private readonly excludedPredefinedFunctions?: readonly string[];
  private readonly allowPrivateNetworkAccess: boolean;
  private initializing?: Promise<void>;
  private loadingTools?: Promise<ComputerUseTool[]>;
  private closed = false;

  /**
   * @param options The computer and its configuration.
   */
  constructor(options: ComputerUseToolsetOptions) {
    checkComputerUseEnabled();
    super([]);
    this.computer = options.computer;
    this.excludedPredefinedFunctions = options.excludedPredefinedFunctions;
    this.allowPrivateNetworkAccess = options.allowPrivateNetworkAccess ?? false;
  }

  /**
   * Returns a tool for every action the computer supports, except the
   * excluded ones. The computer is initialized on the first call, and the
   * tools are cached until {@link close}.
   */
  override async getTools(): Promise<ComputerUseTool[]> {
    this.loadingTools ??= this.loadTools();
    try {
      return await this.loadingTools;
    } catch (error) {
      this.loadingTools = undefined;
      throw error;
    }
  }

  /**
   * Closes the computer and drops the cached tools. The next call to
   * {@link getTools} initializes the computer again.
   */
  override async close(): Promise<void> {
    if (!this.closed) {
      await this.computer.close();
      this.closed = true;
    }
    this.initializing = undefined;
    this.loadingTools = undefined;
  }

  /**
   * Registers the computer use tools in the request and adds the computer use
   * configuration, unless the request already has one.
   *
   * @param _toolContext The context of the tool.
   * @param llmRequest The outgoing request.
   */
  override async processLlmRequest(
    _toolContext: Context,
    llmRequest: LlmRequest,
  ): Promise<void> {
    for (const tool of await this.getTools()) {
      llmRequest.toolsDict[tool.name] = tool;
    }

    llmRequest.config ??= {};
    llmRequest.config.tools ??= [];
    if (llmRequest.config.tools.some(isComputerUseConfig)) {
      logger.debug('Computer use already configured in LLM request');
      return;
    }

    const environment = toGenaiEnvironment(await this.computer.environment());
    const excludedPredefinedFunctions = resolveExcludedPredefinedFunctions({
      excludedNames: this.excludedPredefinedFunctions,
      model: llmRequest.model,
      unimplementedActions: unimplementedOptionalActions(this.computer),
    });
    llmRequest.config.tools.push({
      computerUse:
        excludedPredefinedFunctions === undefined
          ? {environment}
          : {environment, excludedPredefinedFunctions},
    });
    logger.debug(
      `Added computer use tool with environment: ${environment}, ` +
        `excluded functions: ${excludedPredefinedFunctions}`,
    );
  }

  private ensureInitialized(): Promise<void> {
    this.initializing ??= this.computer.initialize().then(
      () => {
        this.closed = false;
      },
      (error: unknown) => {
        this.initializing = undefined;
        throw error;
      },
    );
    return this.initializing;
  }

  private async loadTools(): Promise<ComputerUseTool[]> {
    await this.ensureInitialized();
    const screenSize = await this.computer.screenSize();
    const excluded = expandLocalExclusions(
      this.excludedPredefinedFunctions ?? [],
    );
    return createComputerActions({
      computer: this.computer,
      allowPrivateNetworkAccess: this.allowPrivateNetworkAccess,
    })
      .filter((action) => !excluded.has(action.name))
      .map(
        (action) =>
          new ComputerUseTool({
            name: action.name,
            description: action.description,
            parameters: action.parameters,
            execute: this.bindToComputer(action),
            screenSize,
          }),
      );
  }

  /**
   * Wraps an action so it runs exclusively on the computer, after the
   * computer has prepared for the calling session.
   */
  private bindToComputer(action: ComputerAction): ComputerUseFunction {
    const computer = this.computer;
    return (args, toolContext) =>
      runExclusive(computer, async () => {
        if (toolContext) {
          await computer.prepare(toolContext);
        }
        return action.execute(args);
      });
  }
}
