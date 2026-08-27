/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../utils/logger.js';
import {
  BaseTool,
  IN_MODEL_TOOL_SYMBOL,
  ToolProcessLlmRequest,
} from './base_tool.js';

/**
 * A tool the model runs itself. It is switched on through request parameters
 * — Google Search, URL context, the grounding and retrieval tools — and never
 * executes here.
 *
 * Such a tool has no function declaration, so `BaseTool.processLlmRequest`
 * returns before the line that registers it in `llmRequest.toolsDict`. That
 * left the model primed with a name the framework could not route: a model
 * that returns one as an explicit function call, rather than running it,
 * produced a call that failed to resolve even though the user had registered
 * the tool. Registering the name here keeps the call resolvable, and
 * `runAsync` answers it by telling the model the tool is not callable.
 *
 * A tool whose `applyBuiltInConfig` returns without configuring anything —
 * every one of them does when the request carries no model — still claims its
 * name. That request never reaches a model, so no function call can come back
 * for it and the registration is inert.
 */
export abstract class BuiltInTool extends BaseTool {
  /** Marks this tool as one the model runs itself. */
  readonly [IN_MODEL_TOOL_SYMBOL] = true;

  /**
   * Adds this tool's configuration to the request.
   *
   * @param request The request to process the LLM request.
   */
  protected abstract applyBuiltInConfig(
    request: ToolProcessLlmRequest,
  ): Promise<void>;

  override async processLlmRequest(
    request: ToolProcessLlmRequest,
  ): Promise<void> {
    // This override never forwards a declaration to `llmRequest.config.tools`,
    // because a tool the model runs itself has none. A subclass that returns
    // one would have it dropped here while the name still registered as
    // in-model, leaving the model unable to see the function and told the tool
    // is not callable if it guessed the name. Say so rather than swallow it.
    if (this._getDeclaration()) {
      throw new Error(
        `${this.name} extends BuiltInTool but returns a function ` +
          'declaration. A tool the model runs itself cannot declare a ' +
          'callable function; extend BaseTool instead.',
      );
    }
    await this.applyBuiltInConfig(request);
    // Registered only after the configuration lands, so a tool that rejects
    // the model and throws does not leave behind a name claiming it is
    // callable.
    //
    // Never displace a tool already holding the name. A callable tool called
    // `google_search` is what the model's call almost certainly means, and it
    // won before this registration existed. `BaseTool.processLlmRequest`
    // handles the reverse order, letting a callable tool replace this entry
    // instead of reporting a duplicate.
    // `Object.hasOwn` rather than `in`, so a tool named after an
    // `Object.prototype` member is not read as already registered.
    if (!Object.hasOwn(request.llmRequest.toolsDict, this.name)) {
      request.llmRequest.toolsDict[this.name] = this;
    }
  }

  /**
   * Answers a function call the model should not have made. The tool is
   * already configured on the request and its results arrive as grounding
   * metadata, so the model is told to use those rather than call again.
   */
  override async runAsync(): Promise<unknown> {
    // A model calling an in-model tool as a function is an anomaly worth
    // surfacing, even though the turn recovers from it.
    logger.warn(
      `${this.name} runs inside the model but was called as a function; ` +
        'answering with guidance instead of executing anything.',
    );
    return {
      error:
        `${this.name} runs inside the model and cannot be called as a ` +
        'function. It is already enabled on this request and its results ' +
        'arrive as grounding metadata; answer from those instead of calling ' +
        'it.',
    };
  }
}
