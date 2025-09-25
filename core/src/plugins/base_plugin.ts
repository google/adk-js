/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {CallbackContext} from '../agents/callback_context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {BaseTool} from '../tools/base_tool.js';
import {ToolContext} from '../tools/tool_context.js';
import {getLogger} from '../utils/logger.js';

/**
 * Base class for creating plugins.
 *
 * Plugins provide a structured way to intercept and modify agent, tool, and
 * LLM behaviors at critical execution points in a callback manner. While agent
 * callbacks apply to a particular agent, plugins applies globally to all
 * agents added in the runner. Plugins are best used for adding custom behaviors
 * like logging, monitoring, caching, or modifying requests and responses at key
 * stages.
 *
 * A plugin can implement one or more methods of callbacks, but should not
 * implement the same method of callback for multiple times.
 *
 * Relation with [Agent
 * callbacks](https://google.github.io/adk-docs/callbacks/):
 *
 * **Execution Order**
 * Similar to Agent callbacks, Plugins are executed in the order they are
 * registered. However, Plugin and Agent Callbacks are executed sequentially,
 * with Plugins takes precedence over agent callbacks. When the callback in a
 * plugin returns a value, it will short circuit all remaining plugins and
 * agent callbacks, causing all remaining plugins and agent callbacks
 * to be skipped.
 *
 * **Change Propagation**
 * Plugins and agent callbacks can both modify the value of the input
 * parameters, including agent input, tool input, and LLM request/response, etc.
 * They work in the exactly same way. The modifications will be visible and
 * passed to the next callback in the chain. For example, if a plugin modifies
 * the tool input with before_tool_callback, the modified tool input will be
 * passed to the before_tool_callback of the next plugin, and further passed to
 * the agent callbacks if not short circuited.
 *
 * To use a plugin, implement the desired callback methods and pass an instance
 * of your custom plugin class to the ADK Runner.
 *
 * Example:
 * A simple plugin that logs every tool call.
 * ```typescript
 * class ToolLoggerPlugin extends BasePlugin {
 *   constructor() {
 *     super('tool_logger');
 *   }
 *
 *   override async beforeToolCallback(
 *     {tool, toolArgs, toolContext}: {
 *       tool: BaseTool,
 *       toolArgs: Record<string, unknown>,
 *       toolContext: ToolContext,
 *     },
 *   ): Promise<Record<string, unknown> | undefined> {
 *     this.logger.info(
 *       `[${this.name}] Calling tool '${tool.name}' with args:
 * ${JSON.stringify( toolArgs,
 *       )}`,
 *     );
 *     return;
 *   }
 *
 *   override async afterToolCallback(
 *     {tool, toolArgs, toolContext, result}: {
 *       tool: BaseTool,
 *       toolArgs: Record<string, unknown>,
 *       toolContext: ToolContext,
 *       result: Record<string, unknown>,
 *     },
 *   ): Promise<Record<string, unknown> | undefined> {
 *     this.logger.info(
 *       `[${this.name}] Tool '${tool.name}' finished with result:
 * ${JSON.stringify( result,
 *       )}`,
 *     );
 *     return;
 *   }
 * }
 *
 * // Add the plugin to ADK Runner
 * // runner = new Runner({
 * //   ...
 * //   plugins: [new ToolLoggerPlugin(), new AgentPolicyPlugin()],
 * // });
 * ```
 */
export abstract class BasePlugin {
  readonly name: string;
  readonly logger = getLogger();

  /**
   * Initializes the plugin.
   *
   * @param name A unique identifier for this plugin instance.
   */
  constructor(name: string) {
    this.name = name;
  }

  /**
   * Callback executed when a user message is received before an invocation
   * starts.
   *
   * This callback helps logging and modifying the user message before the
   * runner starts the invocation.
   *
   * @param invocationContext The context for the entire invocation.
   * @param userMessage The message content input by user.
   * @returns An optional `Content` to be returned to the ADK. Returning a
   *     value to replace the user message. Returning `undefined` to proceed
   *     normally.
   */
  async onUserMessageCallback({invocationContext, userMessage}: {
    invocationContext: InvocationContext; userMessage: Content;
  }): Promise<Content|undefined> {
    return;
  }

  /**
   * Callback executed before the ADK runner runs.
   *
   * This is the first callback to be called in the lifecycle, ideal for global
   * setup or initialization tasks.
   *
   * @param invocationContext The context for the entire invocation, containing
   *     session information, the root agent, etc.
   * @returns An optional `Event` to be returned to the ADK. Returning a value
   *     to halt execution of the runner and ends the runner with that event.
   *     Return `undefined` to proceed normally.
   */
  async beforeRunCallback({invocationContext}: {
    invocationContext: InvocationContext;
  }): Promise<Content|undefined> {
    return;
  }

  /**
   * Callback executed after an event is yielded from runner.
   *
   * This is the ideal place to make modification to the event before the event
   * is handled by the underlying agent app.
   *
   * @param invocationContext The context for the entire invocation.
   * @param event The event raised by the runner.
   * @returns An optional value. A non-`undefined` return may be used by the
   *     framework to modify or replace the response. Returning `undefined`
   *     allows the original response to be used.
   */
  async onEventCallback({invocationContext, event}: {
    invocationContext: InvocationContext; event: Event;
  }): Promise<Event|undefined> {
    return;
  }

  /**
   * Callback executed after an ADK runner run has completed.
   *
   * This is the final callback in the ADK lifecycle, suitable for cleanup,
   * final logging, or reporting tasks.
   *
   * @param invocationContext The context for the entire invocation.
   * @returns undefined
   */
  async afterRunCallback({invocationContext}: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    return;
  }

  /**
   * Callback executed before an agent's primary logic is invoked.
   *
   * This callback can be used for logging, setup, or to short-circuit the
   * agent's execution by returning a value.
   *
   * @param agent The agent that is about to run.
   * @param callbackContext The context for the agent invocation.
   * @returns An optional `Content` object. If a value is returned, it will
   *     bypass the agent's callbacks and its execution, and return this value
   *     directly. Returning `undefined` allows the agent to proceed normally.
   */
  async beforeAgentCallback({agent, callbackContext}: {
    agent: BaseAgent; callbackContext: CallbackContext;
  }): Promise<Content|undefined> {
    return;
  }

  /**
   * Callback executed after an agent's primary logic has completed.
   *
   * This callback can be used to inspect, log, or modify the agent's final
   * result before it is returned.
   *
   * @param agent The agent that has just run.
   * @param callbackContext The context for the agent invocation.
   * @returns An optional `Content` object. If a value is returned, it will
   *     replace the agent's original result. Returning `undefined` uses the
   *     original, unmodified result.
   */
  async afterAgentCallback({agent, callbackContext}: {
    agent: BaseAgent; callbackContext: CallbackContext;
  }): Promise<Content|undefined> {
    return;
  }

  /**
   * Callback executed before a request is sent to the model.
   *
   * This provides an opportunity to inspect, log, or modify the `LlmRequest`
   * object. It can also be used to implement caching by returning a cached
   * `LlmResponse`, which would skip the actual model call.
   *
   * @param callbackContext The context for the current agent call.
   * @param llmRequest The prepared request object to be sent to the model.
   * @returns An optional value. The interpretation of a non-`undefined`
   *     trigger an early exit and returns the response immediately. Returning
   *     `undefined` allows the LLM request to proceed normally.
   */
  async beforeModelCallback({callbackContext, llmRequest}: {
    callbackContext: CallbackContext; llmRequest: LlmRequest;
  }): Promise<LlmResponse|undefined> {
    return;
  }

  /**
   * Callback executed after a response is received from the model.
   *
   * This is the ideal place to log model responses, collect metrics on token
   * usage, or perform post-processing on the raw `LlmResponse`.
   *
   * @param callbackContext The context for the current agent call.
   * @param llmResponse The response object received from the model.
   * @returns An optional value. A non-`undefined` return may be used by the
   *     framework to modify or replace the response. Returning `undefined`
   *     allows the original response to be used.
   */
  async afterModelCallback({callbackContext, llmResponse}: {
    callbackContext: CallbackContext; llmResponse: LlmResponse;
  }): Promise<LlmResponse|undefined> {
    return;
  }

  /**
   * Callback executed when a model call encounters an error.
   *
   * This callback provides an opportunity to handle model errors gracefully,
   * potentially providing alternative responses or recovery mechanisms.
   *
   * @param callbackContext The context for the current agent call.
   * @param llmRequest The request that was sent to the model when the error
   *     occurred.
   * @param error The exception that was raised during model execution.
   * @returns An optional LlmResponse. If an LlmResponse is returned, it will be
   *     used instead of propagating the error. Returning `undefined` allows
   *     the original error to be raised.
   */
  async onModelErrorCallback({callbackContext, llmRequest, error}: {
    callbackContext: CallbackContext; llmRequest: LlmRequest; error: Error;
  }): Promise<LlmResponse|undefined> {
    return;
  }

  /**
   * Callback executed before a tool is called.
   *
   * This callback is useful for logging tool usage, input validation, or
   * modifying the arguments before they are passed to the tool.
   *
   * @param tool The tool instance that is about to be executed.
   * @param toolArgs The dictionary of arguments to be used for invoking the
   *     tool.
   * @param toolContext The context specific to the tool execution.
   * @returns An optional dictionary. If a dictionary is returned, it will stop
   *     the tool execution and return this response immediately. Returning
   *     `undefined` uses the original, unmodified arguments.
   */
  async beforeToolCallback({tool, toolArgs, toolContext}: {
    tool: BaseTool; toolArgs: Record<string, unknown>; toolContext: ToolContext;
  }): Promise<Record<string, unknown>|undefined> {
    return;
  }

  /**
   * Callback executed after a tool has been called.
   *
   * This callback allows for inspecting, logging, or modifying the result
   * returned by a tool.
   *
   * @param tool The tool instance that has just been executed.
   * @param toolArgs The original arguments that were passed to the tool.
   * @param toolContext The context specific to the tool execution.
   * @param result The dictionary returned by the tool invocation.
   * @returns An optional dictionary. If a dictionary is returned, it will
   *     **replace** the original result from the tool. This allows for
   *     post-processing or altering tool outputs. Returning `undefined` uses
   *     the original, unmodified result.
   */
  async afterToolCallback({tool, toolArgs, toolContext, result}: {
    tool: BaseTool; toolArgs: Record<string, unknown>; toolContext: ToolContext;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown>|undefined> {
    return;
  }

  /**
   * Callback executed when a tool call encounters an error.
   *
   * This callback provides an opportunity to handle tool errors gracefully,
   * potentially providing alternative responses or recovery mechanisms.
   *
   * @param tool The tool instance that encountered an error.
   * @param toolArgs The arguments that were passed to the tool.
   * @param toolContext The context specific to the tool execution.
   * @param error The exception that was raised during tool execution.
   * @returns An optional dictionary. If a dictionary is returned, it will be
   *     used as the tool response instead of propagating the error. Returning
   *     `undefined` allows the original error to be raised.
   */
  async onToolErrorCallback({tool, toolArgs, toolContext, error}: {
    tool: BaseTool; toolArgs: Record<string, unknown>; toolContext: ToolContext;
    error: Error;
  }): Promise<Record<string, unknown>|undefined> {
    return;
  }
}
