/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {CallbackContext} from '../agents/callback_context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event, getFunctionCalls, getFunctionResponses, isFinalResponse} from '../events/event.js';
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
 * ```typescript
 * const loggingPlugin = new LoggingPlugin();
 * const runner = new Runner({
 *   agents: [myAgent],
 *   // ...
 *   plugins: [loggingPlugin],
 * });
 * ```
 */
export class LoggingPlugin extends BasePlugin {
  /**
   * Initialize the logging plugin.
   *
   * @param name The name of the plugin instance.
   */
  constructor(name = 'logging_plugin') {
    super(name);
  }

  override async onUserMessageCallback(
      {invocationContext, userMessage}:
          {invocationContext: InvocationContext; userMessage: Content;},
      ): Promise<Content|undefined> {
    this.log('🚀 USER MESSAGE RECEIVED');
    this.log(`   Invocation ID: ${invocationContext.invocationId}`);
    this.log(`   Session ID: ${invocationContext.session.id}`);
    this.log(`   User ID: ${invocationContext.userId}`);
    this.log(`   App Name: ${invocationContext.appName}`);
    this.log(`   Root Agent: ${invocationContext.agent.name ?? 'Unknown'}`);
    this.log(`   User Content: ${this.formatContent(userMessage)}`);
    if (invocationContext.branch) {
      this.log(`   Branch: ${invocationContext.branch}`);
    }
    return undefined;
  }

  override async beforeRunCallback({invocationContext}: {
    invocationContext: InvocationContext;
  }): Promise<Content|undefined> {
    this.log('🏃 INVOCATION STARTING');
    this.log(`   Invocation ID: ${invocationContext.invocationId}`);
    this.log(`   Starting Agent: ${invocationContext.agent.name ?? 'Unknown'}`);
    return undefined;
  }

  override async onEventCallback({invocationContext, event}: {
    invocationContext: InvocationContext; event: Event;
  }): Promise<Event|undefined> {
    this.log('📢 EVENT YIELDED');
    this.log(`   Event ID: ${event.id}`);
    this.log(`   Author: ${event.author}`);
    this.log(`   Content: ${this.formatContent(event.content)}`);
    this.log(`   Final Response: ${isFinalResponse(event)}`);

    const functionCalls = getFunctionCalls(event);
    if (functionCalls.length > 0) {
      const funcCalls = functionCalls.map((fc) => fc.name);
      this.log(`   Function Calls: ${funcCalls}`);
    }

    const functionResponses = getFunctionResponses(event);
    if (functionResponses.length > 0) {
      const funcResponses = functionResponses.map((fr) => fr.name);
      this.log(`   Function Responses: ${funcResponses}`);
    }

    if (event.longRunningToolIds && event.longRunningToolIds.length > 0) {
      this.log(`   Long Running Tools: ${[...event.longRunningToolIds]}`);
    }

    return undefined;
  }

  override async afterRunCallback({invocationContext}: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    this.log('✅ INVOCATION COMPLETED');
    this.log(`   Invocation ID: ${invocationContext.invocationId}`);
    this.log(`   Final Agent: ${invocationContext.agent.name ?? 'Unknown'}`);
    return undefined;
  }

  override async beforeAgentCallback({agent, callbackContext}: {
    agent: BaseAgent; callbackContext: CallbackContext;
  }): Promise<Content|undefined> {
    this.log('🤖 AGENT STARTING');
    this.log(`   Agent Name: ${callbackContext.agentName}`);
    this.log(`   Invocation ID: ${callbackContext.invocationId}`);
    if (callbackContext.invocationContext.branch) {
      this.log(`   Branch: ${callbackContext.invocationContext.branch}`);
    }
    return undefined;
  }

  override async afterAgentCallback({agent, callbackContext}: {
    agent: BaseAgent; callbackContext: CallbackContext;
  }): Promise<Content|undefined> {
    this.log('🤖 AGENT COMPLETED');
    this.log(`   Agent Name: ${callbackContext.agentName}`);
    this.log(`   Invocation ID: ${callbackContext.invocationId}`);
    return undefined;
  }

  override async beforeModelCallback({callbackContext, llmRequest}: {
    callbackContext: CallbackContext; llmRequest: LlmRequest;
  }): Promise<LlmResponse|undefined> {
    this.log('🧠 LLM REQUEST');
    this.log(`   Model: ${llmRequest.model ?? 'default'}`);
    this.log(`   Agent: ${callbackContext.agentName}`);

    if (llmRequest.config && llmRequest.config.systemInstruction) {
      let sysInstruction = llmRequest.config.systemInstruction as string;
      if (sysInstruction.length > 200) {
        sysInstruction = sysInstruction.substring(0, 200) + '...';
      }
      this.log(`   System Instruction: '${sysInstruction}'`);
    }

    if (llmRequest.toolsDict) {
      const toolNames = Object.keys(llmRequest.toolsDict);
      this.log(`   Available Tools: ${toolNames}`);
    }

    return undefined;
  }

  override async afterModelCallback({callbackContext, llmResponse}: {
    callbackContext: CallbackContext; llmResponse: LlmResponse;
  }): Promise<LlmResponse|undefined> {
    this.log('🧠 LLM RESPONSE');
    this.log(`   Agent: ${callbackContext.agentName}`);

    if (llmResponse.errorCode) {
      this.log(`   ❌ ERROR - Code: ${llmResponse.errorCode}`);
      this.log(`   Error Message: ${llmResponse.errorMessage}`);
    } else {
      this.log(`   Content: ${this.formatContent(llmResponse.content)}`);
      if (llmResponse.partial) {
        this.log(`   Partial: ${llmResponse.partial}`);
      }
      if (llmResponse.turnComplete !== undefined) {
        this.log(`   Turn Complete: ${llmResponse.turnComplete}`);
      }
    }

    if (llmResponse.usageMetadata) {
      this.log(`   Token Usage - Input: ${
          llmResponse.usageMetadata.promptTokenCount}, Output: ${
          llmResponse.usageMetadata.candidatesTokenCount}`);
    }

    return undefined;
  }

  override async beforeToolCallback({tool, toolArgs, toolContext}: {
    tool: BaseTool; toolArgs: Record<string, unknown>; toolContext: ToolContext;
  }): Promise<Record<string, unknown>|undefined> {
    this.log('🔧 TOOL STARTING');
    this.log(`   Tool Name: ${tool.name}`);
    this.log(`   Agent: ${toolContext.agentName}`);
    this.log(`   Function Call ID: ${toolContext.functionCallId}`);
    this.log(`   Arguments: ${this.formatArgs(toolArgs)}`);
    return undefined;
  }

  override async afterToolCallback({tool, toolArgs, toolContext, result}: {
    tool: BaseTool; toolArgs: Record<string, unknown>; toolContext: ToolContext;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown>|undefined> {
    this.log('🔧 TOOL COMPLETED');
    this.log(`   Tool Name: ${tool.name}`);
    this.log(`   Agent: ${toolContext.agentName}`);
    this.log(`   Function Call ID: ${toolContext.functionCallId}`);
    this.log(`   Result: ${this.formatArgs(result)}`);
    return undefined;
  }

  override async onModelErrorCallback({callbackContext, llmRequest, error}: {
    callbackContext: CallbackContext; llmRequest: LlmRequest; error: Error;
  }): Promise<LlmResponse|undefined> {
    this.log('🧠 LLM ERROR');
    this.log(`   Agent: ${callbackContext.agentName}`);
    this.log(`   Error: ${error}`);

    return undefined;
  }

  override async onToolErrorCallback({tool, toolArgs, toolContext, error}: {
    tool: BaseTool; toolArgs: Record<string, unknown>; toolContext: ToolContext;
    error: Error;
  }): Promise<Record<string, unknown>|undefined> {
    this.log('🔧 TOOL ERROR');
    this.log(`   Tool Name: ${tool.name}`);
    this.log(`   Agent: ${toolContext.agentName}`);
    this.log(`   Function Call ID: ${toolContext.functionCallId}`);
    this.log(`   Arguments: ${this.formatArgs(toolArgs)}`);
    this.log(`   Error: ${error}`);
    return undefined;
  }

  private log(message: string): void {
    const formattedMessage = `\u001b[90m[${this.name}] ${message}\u001b[0m`;
    console.log(formattedMessage);
  }

  private formatContent(content?: Content, maxLength = 200): string {
    if (!content || !content.parts) {
      return 'None';
    }

    const parts: string[] = [];
    for (const part of content.parts) {
      if (part.text) {
        let text = part.text.trim();
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '...';
        }
        parts.push(`text: '${text}'`);
      } else if (part.functionCall) {
        parts.push(`function_call: ${part.functionCall.name}`);
      } else if (part.functionResponse) {
        parts.push(`function_response: ${part.functionResponse.name}`);
      } else if (part.codeExecutionResult) {
        parts.push('code_execution_result');
      } else {
        parts.push('other_part');
      }
    }

    return parts.join(' | ');
  }

  private formatArgs(args: Record<string, unknown>, maxLength = 300): string {
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
