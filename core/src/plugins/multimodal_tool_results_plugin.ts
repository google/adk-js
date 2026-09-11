/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type Part} from '@google/genai';
import {cloneDeep, isEqual} from 'lodash-es';

import {type Context} from '../agents/context.js';
import {type LlmRequest} from '../models/llm_request.js';
import {type LlmResponse} from '../models/llm_response.js';
import {type BaseTool} from '../tools/base_tool.js';
import {BasePlugin} from './base_plugin.js';

/**
 * Temporary state key for parts returned by tools in default (next_model_call) mode.
 */
export const PARTS_RETURNED_BY_TOOLS_ID = 'temp:PARTS_RETURNED_BY_TOOLS_ID';

/**
 * Session-scoped state key for parts returned by tools in session retention mode.
 *
 * Deliberately NOT "temp:"-prefixed: the session layer treats "temp:" state
 * as invocation-scoped and strips it before persisting an event. Retention="session"
 * needs the saved parts to survive into later conversational turns, so it is stored
 * under this session-scoped key instead.
 */
export const SESSION_PARTS_RETURNED_BY_TOOLS_ID =
  'multimodal_tool_results_plugin:PARTS_RETURNED_BY_TOOLS_ID';

/**
 * Temporary state key for current turn parts in session retention mode.
 */
export const _CURRENT_TURN_PARTS_ID =
  'temp:multimodal_tool_results_plugin:current_turn_parts';

/**
 * Temporary flag indicating session parts were updated in the current invocation.
 */
export const _SESSION_UPDATED_KEY =
  'temp:multimodal_tool_results_plugin:updated_in_invocation';

/**
 * Retention strategy for tool-returned multimodal parts.
 */
export type MultimodalToolResultsRetention = 'next_model_call' | 'session';

/**
 * Options for configuring {@link MultimodalToolResultsPlugin}.
 */
export interface MultimodalToolResultsPluginOptions {
  /**
   * The name of the plugin instance.
   * Defaults to `'multimodal_tool_results_plugin'`.
   */
  name?: string;

  /**
   * How long tool-returned parts stay attached to model requests:
   * - `'next_model_call'` (default): Attaches saved parts once to the immediate
   *   next model request and then clears them.
   * - `'session'`: Keeps re-attaching the latest saved parts to every subsequent
   *   model request for the rest of the session. Inline data (images/audio bytes)
   *   remains one-shot, while file data and text parts persist across turns.
   */
  retention?: MultimodalToolResultsRetention;
}

const MULTIMODAL_TOOL_RESULTS_PLUGIN_SYMBOL = Symbol.for(
  'google.adk.multimodalToolResultsPlugin',
);

const PART_KEYS = new Set([
  'text',
  'inlineData',
  'fileData',
  'functionCall',
  'functionResponse',
  'executableCode',
  'codeExecutionResult',
  'thought',
  'thoughtSignature',
  'videoMetadata',
  'partMetadata',
  'mediaResolution',
]);

/**
 * Checks whether an object conforms to the Gemini {@link Part} structure for
 * multimodal content.
 *
 * Matches parts containing `inlineData` or `fileData`. Plain objects containing
 * text or standard tool results are not treated as multimodal parts so their
 * return values are not dropped.
 *
 * @param value The value to inspect.
 * @returns True if the value is a multimodal Part object.
 */
export function isPart(value: unknown): value is Part {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return false;
  }
  const hasMultimodalPayload = 'inlineData' in obj || 'fileData' in obj;
  if (!hasMultimodalPayload) {
    return false;
  }

  return keys.every((k) => PART_KEYS.has(k));
}

function hasInlineData(part: Part): boolean {
  return part.inlineData != null;
}

/**
 * Type guard for {@link MultimodalToolResultsPlugin}.
 *
 * @param plugin The plugin to check.
 * @returns True if the plugin is an instance of MultimodalToolResultsPlugin.
 */
export function isMultimodalToolResultsPlugin(
  plugin: unknown,
): plugin is MultimodalToolResultsPlugin {
  return (
    plugin != null &&
    typeof plugin === 'object' &&
    (plugin as {[MULTIMODAL_TOOL_RESULTS_PLUGIN_SYMBOL]?: boolean})[
      MULTIMODAL_TOOL_RESULTS_PLUGIN_SYMBOL
    ] === true
  );
}

/**
 * Plugin that modifies function tool responses to support returning multimodal parts directly.
 *
 * Intercepts tool execution outputs returning `Part` or `Part[]` (such as images,
 * audio, or PDF documents) and attaches them directly to the LLM's next request
 * context so the model can inspect the multimodal content.
 *
 * @example
 * ```typescript
 * import {MultimodalToolResultsPlugin} from '@google/adk';
 *
 * // Create plugin with default next_model_call retention
 * const plugin = new MultimodalToolResultsPlugin();
 *
 * // Or retain fileData across turns for the entire session
 * const sessionPlugin = new MultimodalToolResultsPlugin({
 *   retention: 'session',
 * });
 * ```
 */
export class MultimodalToolResultsPlugin extends BasePlugin {
  readonly [MULTIMODAL_TOOL_RESULTS_PLUGIN_SYMBOL] = true;
  readonly retention: MultimodalToolResultsRetention;

  constructor(options?: MultimodalToolResultsPluginOptions) {
    const name = options?.name ?? 'multimodal_tool_results_plugin';
    const retention = options?.retention ?? 'next_model_call';
    if (retention !== 'next_model_call' && retention !== 'session') {
      throw new Error(
        `retention must be 'next_model_call' or 'session', got ${retention}`,
      );
    }
    super(name);
    this.retention = retention;
  }

  /**
   * Saves parts returned by the tool in context state.
   *
   * Later these are attached to the LLM request contents.
   * No-op if the tool result is not a Part or Part[].
   */
  override async afterToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown> | unknown;
  }): Promise<Record<string, unknown> | undefined> {
    const {toolContext, result} = params;

    const isSinglePart = isPart(result);
    const isPartsArray =
      Array.isArray(result) && result.length > 0 && isPart(result[0]);

    if (!isSinglePart && !isPartsArray) {
      return result as Record<string, unknown>;
    }

    const parts: Part[] = isSinglePart
      ? [cloneDeep(result as Part)]
      : cloneDeep(result as Part[]);

    if (this.retention === 'session') {
      const sessionParts = parts.filter((p) => !hasInlineData(p));
      const sessionKey = SESSION_PARTS_RETURNED_BY_TOOLS_ID;
      const updatedKey = _SESSION_UPDATED_KEY;

      if (sessionParts.length > 0) {
        if (toolContext.state.get(updatedKey)) {
          const existing = toolContext.state.get<Part[]>(sessionKey) ?? [];
          toolContext.state.set(sessionKey, [...existing, ...sessionParts]);
        } else {
          toolContext.state.set(updatedKey, true);
          toolContext.state.set(sessionKey, [...sessionParts]);
        }
      }

      const currentTurnKey = _CURRENT_TURN_PARTS_ID;
      if (toolContext.state.has(currentTurnKey)) {
        const existing = toolContext.state.get<Part[]>(currentTurnKey) ?? [];
        toolContext.state.set(currentTurnKey, [...existing, ...parts]);
      } else {
        toolContext.state.set(currentTurnKey, [...parts]);
      }
    } else {
      const tempKey = PARTS_RETURNED_BY_TOOLS_ID;
      if (toolContext.state.has(tempKey)) {
        const existing = toolContext.state.get<Part[]>(tempKey) ?? [];
        toolContext.state.set(tempKey, [...existing, ...parts]);
      } else {
        toolContext.state.set(tempKey, [...parts]);
      }
    }

    return undefined;
  }

  /**
   * Attaches saved parts returned by tools to the model request contents.
   */
  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const {callbackContext, llmRequest} = params;

    if (!llmRequest.contents || llmRequest.contents.length === 0) {
      return undefined;
    }

    if (this.retention === 'session') {
      const sessionKey = SESSION_PARTS_RETURNED_BY_TOOLS_ID;
      const currentTurnKey = _CURRENT_TURN_PARTS_ID;

      const savedSessionParts =
        callbackContext.state.get<Part[]>(sessionKey) ?? [];
      const currentParts =
        callbackContext.state.get<Part[]>(currentTurnKey) ?? [];

      const filteredSessionParts = savedSessionParts.filter(
        (sp) => !currentParts.some((cp) => isEqual(sp, cp)),
      );

      const partsToAttach = [...filteredSessionParts, ...currentParts];

      if (currentParts.length > 0) {
        callbackContext.state.set(currentTurnKey, []);
      }

      if (partsToAttach.length > 0) {
        const lastContent = llmRequest.contents[llmRequest.contents.length - 1];
        if (!lastContent.parts) {
          lastContent.parts = [];
        }
        lastContent.parts.push(...cloneDeep(partsToAttach));
      }
    } else {
      const tempKey = PARTS_RETURNED_BY_TOOLS_ID;
      const tempParts = callbackContext.state.get<Part[]>(tempKey) ?? [];

      if (tempParts.length > 0) {
        const lastContent = llmRequest.contents[llmRequest.contents.length - 1];
        if (!lastContent.parts) {
          lastContent.parts = [];
        }
        lastContent.parts.push(...cloneDeep(tempParts));
        callbackContext.state.set(tempKey, []);
      }
    }

    return undefined;
  }
}
