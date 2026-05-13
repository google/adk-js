/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {Context} from '../agents/context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {BaseTool} from '../tools/base_tool.js';
import {logger} from '../utils/logger.js';

import {BasePlugin, ContextCompactionTrigger} from './base_plugin.js';

/**
 * Manages the registration and execution of plugins.
 *
 * The PluginManager is an internal class that orchestrates the invocation of
 * plugin callbacks at key points in the SDK's execution lifecycle. It maintains
 * a list of registered plugins and ensures they are called in the order they
 * were registered.
 *
 * The core execution logic implements an "early exit" strategy: if any plugin
 * callback returns a non-`undefined` value, the execution of subsequent plugins
 * for that specific event is halted, and the returned value is propagated up
 * the call stack. This allows plugins to short-circuit operations like agent
 * runs, tool calls, or model requests.
 *
 * A plugin can opt out of the early exit by returning a payload that includes
 * a literal `shortCircuit: false` field; in that case the remaining fields
 * (with `shortCircuit` stripped) are forwarded to the next plugin as the new
 * value of the transformed input field, and execution continues. Returning a
 * payload with `shortCircuit: true` (or omitting the field entirely) preserves
 * the legacy early-exit behavior.
 */
export class PluginManager {
  private readonly plugins: Set<BasePlugin> = new Set();
  /**
   * Initializes the plugin service.
   *
   * @param plugins An optional list of plugins to register upon
   *     initialization.
   */
  constructor(plugins?: BasePlugin[]) {
    if (plugins) {
      for (const plugin of plugins) {
        this.registerPlugin(plugin);
      }
    }
  }

  /**
   * Registers a new plugin.
   *
   * @param plugin The plugin instance to register.
   * @throws If the same exact plugin or a plugin with the same name is already
   *     registered.
   */
  registerPlugin(plugin: BasePlugin): void {
    // Short circuit for duplicate objects or duplicate names
    if (this.plugins.has(plugin)) {
      throw new Error(`Plugin '${plugin.name}' already registered.`);
    }
    if (Array.from(this.plugins).some((p) => p.name === plugin.name)) {
      throw new Error(`Plugin with name '${plugin.name}' already registered.`);
    }

    this.plugins.add(plugin);

    logger.info(`Plugin '${plugin.name}' registered.`);
  }

  /**
   * Retrieves a registered plugin by its name.
   *
   * @param pluginName The name of the plugin to retrieve.
   * @returns The plugin instance if found, otherwise `undefined`.
   */
  getPlugin(pluginName: string): BasePlugin | undefined {
    // Set operates on strict equality, we only want to match by name
    return Array.from(this.plugins).find((p) => p.name === pluginName);
  }

  /**
   * Runs the same callback for all plugins. This is a utility method to reduce
   * duplication below.
   *
   * Plugins receive the latest transformed value (via `latest`); the caller is
   * responsible for splicing it into the right field of the plugin params. If
   * no prior plugin produced a value, `latest` is `undefined` and the caller
   * should fall back to the original input.
   *
   * A plugin return value of `undefined` continues the chain unchanged. A
   * return value containing `shortCircuit: false` strips the flag and forwards
   * the remaining fields to subsequent plugins; any other return value is
   * treated as a short-circuit (legacy behavior) and returned as-is.
   *
   * @param plugins The set of plugins to run
   * @param callback A closure containing the callback method to run on each
   *     plugin. Receives the latest transformed value, or `undefined`.
   * @param callbackName The name of the function being called in the closure
   *     above. Used for logging purposes.
   * @returns A promise containing the plugin method result. Must be casted to
   *     the proper type for the plugin method.
   */
  private async runCallbacks(
    plugins: Set<BasePlugin>,
    callback: (plugin: BasePlugin, latest: unknown) => Promise<unknown>,
    callbackName: string,
  ): Promise<unknown> {
    let current: unknown = undefined;
    for (const plugin of plugins) {
      try {
        const result = await callback(plugin, current);
        if (result === undefined) continue;
        if (
          typeof result === 'object' &&
          result !== null &&
          'shortCircuit' in result &&
          (result as {shortCircuit: unknown}).shortCircuit === false
        ) {
          const {shortCircuit: _omit, ...rest} = result as Record<
            string,
            unknown
          >;
          current = rest;
          continue;
        }
        logger.debug(
          `Plugin '${plugin.name}' returned a value for callback '${callbackName}', exiting early.`,
        );
        return result;
      } catch (e) {
        const errorMessage = `Error in plugin '${plugin.name}' during '${callbackName}' callback: ${e}`;
        logger.error(errorMessage);
        throw new Error(errorMessage);
      }
    }
    return current;
  }

  /**
   * Runs the `onUserMessageCallback` for all plugins.
   */
  async runOnUserMessageCallback({
    userMessage,
    invocationContext,
  }: {
    userMessage: Content;
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin, latest: unknown) =>
        plugin.onUserMessageCallback({
          userMessage: (latest as Content) ?? userMessage,
          invocationContext,
        }),
      'onUserMessageCallback',
    )) as Content | undefined;
  }

  /**
   * Runs the `beforeRunCallback` for all plugins.
   */
  async runBeforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) => plugin.beforeRunCallback({invocationContext}),
      'beforeRunCallback',
    )) as Content | undefined;
  }

  /**
   * Runs the `afterRunCallback` for all plugins.
   */
  async runAfterRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) => plugin.afterRunCallback({invocationContext}),
      'afterRunCallback',
    );
  }

  /**
   * Runs the `onEventCallback` for all plugins.
   */
  async runOnEventCallback({
    invocationContext,
    event,
  }: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin, latest: unknown) =>
        plugin.onEventCallback({
          invocationContext,
          event: (latest as Event) ?? event,
        }),
      'onEventCallback',
    )) as Event | undefined;
  }

  /**
   * Runs the `beforeAgentCallback` for all plugins.
   */
  async runBeforeAgentCallback({
    agent,
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.beforeAgentCallback({agent, callbackContext}),
      'beforeAgentCallback',
    )) as Content | undefined;
  }

  /**
   * Runs the `afterAgentCallback` for all plugins.
   */
  async runAfterAgentCallback({
    agent,
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.afterAgentCallback({agent, callbackContext}),
      'afterAgentCallback',
    )) as Content | undefined;
  }

  /**
   * Runs the `beforeToolSelection` for all plugins.
   */
  async runBeforeToolSelection({
    callbackContext,
    tools,
  }: {
    callbackContext: Context;
    tools: Readonly<Record<string, BaseTool>>;
  }): Promise<Readonly<Record<string, BaseTool>> | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin, latest: unknown) =>
        plugin.beforeToolSelection({
          callbackContext,
          tools: (latest as Readonly<Record<string, BaseTool>>) ?? tools,
        }),
      'beforeToolSelection',
    )) as Readonly<Record<string, BaseTool>> | undefined;
  }

  /**
   * Runs the `beforeContextCompaction` for all plugins.
   */
  async runBeforeContextCompaction({
    invocationContext,
    trigger,
  }: {
    invocationContext: InvocationContext;
    trigger: ContextCompactionTrigger;
  }): Promise<void> {
    await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.beforeContextCompaction({invocationContext, trigger}),
      'beforeContextCompaction',
    );
  }

  /**
   * Runs the `afterContextCompaction` for all plugins.
   */
  async runAfterContextCompaction({
    invocationContext,
    trigger,
  }: {
    invocationContext: InvocationContext;
    trigger: ContextCompactionTrigger;
  }): Promise<void> {
    await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.afterContextCompaction({invocationContext, trigger}),
      'afterContextCompaction',
    );
  }

  /**
   * Runs the `beforeToolCallback` for all plugins.
   */
  async runBeforeToolCallback({
    tool,
    toolArgs,
    toolContext,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.beforeToolCallback({tool, toolArgs, toolContext}),
      'beforeToolCallback',
    )) as Record<string, unknown> | undefined;
  }

  /**
   * Runs the `afterToolCallback` for all plugins.
   */
  async runAfterToolCallback({
    tool,
    toolArgs,
    toolContext,
    result,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin, latest: unknown) =>
        plugin.afterToolCallback({
          tool,
          toolArgs,
          toolContext,
          result: (latest as Record<string, unknown>) ?? result,
        }),
      'afterToolCallback',
    )) as Record<string, unknown> | undefined;
  }

  /**
   * Runs the `onModelErrorCallback` for all plugins.
   */
  async runOnModelErrorCallback({
    callbackContext,
    llmRequest,
    error,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<LlmResponse | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.onModelErrorCallback({callbackContext, llmRequest, error}),
      'onModelErrorCallback',
    )) as LlmResponse | undefined;
  }

  /**
   * Runs the `beforeModelCallback` for all plugins.
   */
  async runBeforeModelCallback({
    callbackContext,
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.beforeModelCallback({callbackContext, llmRequest}),
      'beforeModelCallback',
    )) as LlmResponse | undefined;
  }

  /**
   * Runs the `afterModelCallback` for all plugins.
   */
  async runAfterModelCallback({
    callbackContext,
    llmResponse,
  }: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin, latest: unknown) =>
        plugin.afterModelCallback({
          callbackContext,
          llmResponse: (latest as LlmResponse) ?? llmResponse,
        }),
      'afterModelCallback',
    )) as LlmResponse | undefined;
  }

  /**
   * Runs the `onToolErrorCallback` for all plugins.
   */
  async runOnToolErrorCallback({
    tool,
    toolArgs,
    toolContext,
    error,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    error: Error;
  }): Promise<Record<string, unknown> | undefined> {
    return (await this.runCallbacks(
      this.plugins,
      (plugin: BasePlugin) =>
        plugin.onToolErrorCallback({tool, toolArgs, toolContext, error}),
      'onToolErrorCallback',
    )) as Record<string, unknown> | undefined;
  }
}
