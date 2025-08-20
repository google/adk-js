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

/**
 * Base class for creating plugins.
 *
 * Plugins provide a structured way to intercept and modify agent behaviors globally.
 *
 * **Execution Order**
 * Plugins execute before agent callbacks. If a plugin returns a non-undefined value,
 * it short-circuits subsequent plugins and agent callbacks.
 */
export abstract class BasePlugin {
  public readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  // --- Runner Lifecycle Callbacks ---

  async onUserMessageCallback(
      params: {invocationContext: InvocationContext, userMessage: Content}):
      Promise<Content|undefined> {
    return undefined;
  }

  async beforeRunCallback(params: {invocationContext: InvocationContext}):
      Promise<Content|undefined> {
    return undefined;
  }

  async onEventCallback(
      params: {invocationContext: InvocationContext, event: Event}):
      Promise<Event|undefined> {
    return undefined;
  }

  async afterRunCallback(params: {invocationContext: InvocationContext}):
      Promise<void> {
    // No return value expected
  }

  // --- Agent Lifecycle Callbacks ---

  async beforeAgentCallback(
      params: {agent: BaseAgent, callbackContext: CallbackContext}):
      Promise<Content|undefined> {
    return undefined;
  }

  async afterAgentCallback(
      params: {agent: BaseAgent, callbackContext: CallbackContext}):
      Promise<Content|undefined> {
    return undefined;
  }

  // --- Model Callbacks ---

  async beforeModelCallback(
      params: {callbackContext: CallbackContext, llmRequest: LlmRequest}):
      Promise<LlmResponse|undefined> {
    return undefined;
  }

  async afterModelCallback(
      params: {callbackContext: CallbackContext, llmResponse: LlmResponse}):
      Promise<LlmResponse|undefined> {
    return undefined;
  }

  async onModelErrorCallback(params: {
    callbackContext: CallbackContext,
    llmRequest: LlmRequest,
    error: Error
  }): Promise<LlmResponse|undefined> {
    return undefined;
  }

  // --- Tool Callbacks ---

  /**
   * Executed before a tool is called. Crucial for HITL confirmation.
   * @returns An optional object. If returned, it short-circuits the tool execution.
   */
  async beforeToolCallback(params: {
    tool: BaseTool,
    toolArgs: Record<string, unknown>,
    toolContext: ToolContext
  }): Promise<Record<string, unknown>|undefined> {
    return undefined;
  }

  async afterToolCallback(params: {
    tool: BaseTool,
    toolArgs: Record<string, unknown>,
    toolContext: ToolContext,
    // Result is normalized to an object by the framework for consistency.
    result: Record<string, unknown>
  }): Promise<Record<string, unknown>|undefined> {
    return undefined;
  }

  async onToolErrorCallback(params: {
    tool: BaseTool,
    toolArgs: Record<string, unknown>,
    toolContext: ToolContext,
    error: Error
  }): Promise<Record<string, unknown>|undefined> {
    return undefined;
  }
}