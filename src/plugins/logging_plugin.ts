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
import {BasePlugin} from './base_plugin.js';

/**
 * A plugin that logs important information at each callback point.
 *
 * This plugin helps printing all critical events in the console. It is not a
 * replacement of existing logging in ADK. It rather helps terminal based
 * debugging by showing all logs in the console, and serves as a simple demo for
 * everyone to leverage when developing new plugins.
 *
 * This plugin helps users track the invocation status by logging:
 * - User messages and invocation context
 * - Agent execution flow
 * - LLM requests and responses
 * - Tool calls with arguments and results
 * - Events and final responses
 * - Errors during model and tool execution
 *
 * Example:
 *      const loggingPlugin = new LoggingPlugin();
 *      const runner = new Runner({
 *          agents=[myAgent],
 *          // ...
 *          plugins=[loggingPlugin],
 *      });
 */
export class LoggingPlugin extends BasePlugin {
  constructor(name = 'logging_plugin') {
    super(name);
  }

  override async onUserMessageCallback(params: {
    invocationContext: InvocationContext;
    userMessage: Content;
  }): Promise<Content | undefined> {
    this.log('🚀 USER MESSAGE RECEIVED');
    this.log(`   Invocation ID: ${params.invocationContext.invocationId}`);
    this.log(`   Session ID: ${params.invocationContext.session.id}`);
    this.log(`   User ID: ${params.invocationContext.userId}`);
    this.log(`   App Name: ${params.invocationContext.appName}`);
    this.log(`   Root Agent: ${params.invocationContext.agent.name}`);
    this.log(`   User Content: ${this.formatContent(params.userMessage)}`);
    if (params.invocationContext.branch) {
      this.log(`   Branch: ${params.invocationContext.branch}`);
    }
    return undefined;
  }

  override async beforeRunCallback(params: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    this.log('🏃 INVOCATION STARTING');
    this.log(`   Invocation ID: ${params.invocationContext.invocationId}`);
    this.log(`   Starting Agent: ${params.invocationContext.agent.name}`);
    return undefined;
  }

  override async onEventCallback(params: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    this.log('📢 EVENT YIELDED');
    this.log(`   Event ID: ${params.event.id}`);
    this.log(`   Author: ${params.event.author}`);
    this.log(`   Content: ${this.formatContent(params.event.content)}`);
    this.log(`   Final Response: ${params.event.isFinalResponse()}`);

    const functionCalls = params.event.getFunctionCalls();
    if (functionCalls?.length) {
      this.log(`   Function Calls: ${functionCalls.map(fc => fc.name)}`);
    }

    const functionResponses = params.event.getFunctionResponses();
    if (functionResponses?.length) {
      this.log(
        `   Function Responses: ${functionResponses.map(fr => fr.name)}`
      );
    }

    if (params.event.longRunningToolIds?.length) {
      this.log(
        `   Long Running Tools: ${Array.from(params.event.longRunningToolIds)}`
      );
    }
    return undefined;
  }

  override async afterRunCallback(params: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    this.log('✅ INVOCATION COMPLETED');
    this.log(`   Invocation ID: ${params.invocationContext.invocationId}`);
    this.log(`   Final Agent: ${params.invocationContext.agent.name}`);
  }

  override async beforeAgentCallback(params: {
    agent: BaseAgent;
    callbackContext: CallbackContext;
  }): Promise<Content | undefined> {
    this.log('🤖 AGENT STARTING');
    this.log(`   Agent Name: ${params.callbackContext.agentName}`);
    this.log(`   Invocation ID: ${params.callbackContext.invocationId}`);
    if (params.callbackContext.invocationContext.branch) {
      this.log(`   Branch: ${params.callbackContext.invocationContext.branch}`);
    }
    return undefined;
  }

  override async afterAgentCallback(params: {
    agent: BaseAgent;
    callbackContext: CallbackContext;
  }): Promise<Content | undefined> {
    this.log('🤖 AGENT COMPLETED');
    this.log(`   Agent Name: ${params.callbackContext.agentName}`);
    this.log(`   Invocation ID: ${params.callbackContext.invocationId}`);
    return undefined;
  }

  override async beforeModelCallback(params: {
    callbackContext: CallbackContext;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    this.log('🧠 LLM REQUEST');
    this.log(`   Model: ${params.llmRequest.model ?? 'default'}`);
    this.log(`   Agent: ${params.callbackContext.agentName}`);

    if (params.llmRequest.config?.systemInstruction) {
      let sysInstruction =
        typeof params.llmRequest.config.systemInstruction === 'string'
          ? params.llmRequest.config.systemInstruction
          : JSON.stringify(params.llmRequest.config.systemInstruction);
      if (sysInstruction.length > 200) {
        sysInstruction = sysInstruction.substring(0, 200) + '...';
      }
      this.log(`   System Instruction: '${sysInstruction}'`);
    }

    if (params.llmRequest.toolsDict) {
      const toolNames = Object.keys(params.llmRequest.toolsDict);
      this.log(`   Available Tools: ${toolNames}`);
    }
    return undefined;
  }

  override async afterModelCallback(params: {
    callbackContext: CallbackContext;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    this.log('🧠 LLM RESPONSE');
    this.log(`   Agent: ${params.callbackContext.agentName}`);

    if (params.llmResponse.errorCode) {
      this.log(`   ❌ ERROR - Code: ${params.llmResponse.errorCode}`);
      this.log(`   Error Message: ${params.llmResponse.errorMessage}`);
    } else {
      this.log(`   Content: ${this.formatContent(params.llmResponse.content)}`);
      if (params.llmResponse.partial) {
        this.log(`   Partial: ${params.llmResponse.partial}`);
      }
      if (params.llmResponse.turnComplete !== undefined) {
        this.log(`   Turn Complete: ${params.llmResponse.turnComplete}`);
      }
    }

    if (params.llmResponse.usageMetadata) {
      this.log(
        `   Token Usage - Input: ${params.llmResponse.usageMetadata.promptTokenCount}, Output: ${params.llmResponse.usageMetadata.candidatesTokenCount}`
      );
    }
    return undefined;
  }

  override async onModelErrorCallback(params: {
    callbackContext: CallbackContext;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<LlmResponse | undefined> {
    this.log('🧠 LLM ERROR');
    this.log(`   Agent: ${params.callbackContext.agentName}`);
    this.log(`   Error: ${params.error}`);
    return undefined;
  }

  override async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: ToolContext;
  }): Promise<Record<string, unknown> | undefined> {
    this.log('🔧 TOOL STARTING');
    this.log(`   Tool Name: ${params.tool.name}`);
    this.log(`   Agent: ${params.toolContext.agentName}`);
    this.log(`   Function Call ID: ${params.toolContext.functionCallId}`);
    this.log(`   Arguments: ${this.formatArgs(params.toolArgs)}`);
    return undefined;
  }

  override async afterToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: ToolContext;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    this.log('🔧 TOOL COMPLETED');
    this.log(`   Tool Name: ${params.tool.name}`);
    this.log(`   Agent: ${params.toolContext.agentName}`);
    this.log(`   Function Call ID: ${params.toolContext.functionCallId}`);
    this.log(`   Result: ${this.formatArgs(params.result)}`);
    return undefined;
  }

  override async onToolErrorCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: ToolContext;
    error: Error;
  }): Promise<Record<string, unknown> | undefined> {
    this.log('🔧 TOOL ERROR');
    this.log(`   Tool Name: ${params.tool.name}`);
    this.log(`   Agent: ${params.toolContext.agentName}`);
    this.log(`   Function Call ID: ${params.toolContext.functionCallId}`);
    this.log(`   Arguments: ${this.formatArgs(params.toolArgs)}`);
    this.log(`   Error: ${params.error}`);
    return undefined;
  }

  private log(message: string): void {
    // ANSI color codes: \x1b[90m for grey, \x1b[0m to reset
    const formattedMessage = `\x1b[90m[${this.name}] ${message}\x1b[0m`;
    console.debug(formattedMessage);
  }

  private formatContent(
    content: Content | undefined,
    maxLength = 200
  ): string {
    if (!content?.parts) {
      return 'None';
    }

    const parts = content.parts.map(part => {
      if (part.text) {
        let text = part.text.trim();
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '...';
        }
        return `text: '${text}'`;
      } else if (part.functionCall) {
        return `function_call: ${part.functionCall.name}`;
      } else if (part.functionResponse) {
        return `function_response: ${part.functionResponse.name}`;
      } else if (part.codeExecutionResult) {
        return 'code_execution_result';
      } else {
        return 'other_part';
      }
    });

    return parts.join(' | ');
  }

  private formatArgs(
    args: Record<string, unknown>,
    maxLength = 300
  ): string {
    if (!args) {
      return '{}';
    }
    let formatted = JSON.stringify(args);
    if (formatted.length > maxLength) {
      formatted = formatted.substring(0, maxLength) + '...}';
    }
    return formatted;
  }
}
