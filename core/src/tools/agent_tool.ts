/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionDeclaration, Type} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import {Event} from '../events/event.js';
import {InMemoryMemoryService} from '../memory/in_memory_memory_service.js';
import {Runner} from '../runner/runner.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';

import {BaseTool, RunAsyncToolRequest} from './base_tool.js';
import {ForwardingArtifactService} from './forwarding_artifact_service.js';

/**
 * The configuration of the agent tool.
 */
export interface AgentToolConfig {
  /**
   * The reference to the agent instance.
   */
  agent: BaseAgent;

  /**
   * Whether to skip summarization of the agent output.
   */
  skipSummarization?: boolean;
}

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all BaseTool instances.
 */
const AGENT_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.agentTool');

/**
 * Type guard to check if an object is an instance of BaseTool.
 * @param obj The object to check.
 * @returns True if the object is an instance of BaseTool, false otherwise.
 */
export function isAgentTool(obj: unknown): obj is AgentTool {
  return typeof obj === 'object' && obj !== null &&
      AGENT_TOOL_SIGNATURE_SYMBOL in obj &&
      obj[AGENT_TOOL_SIGNATURE_SYMBOL] === true;
}

/**
 * A tool that wraps an agent.
 *
 * This tool allows an agent to be called as a tool within a larger
 * application. The agent's input schema is used to define the tool's input
 * parameters, and the agent's output is returned as the tool's result.
 *
 *  @param config: The configuration of the agent tool.
 */
export class AgentTool extends BaseTool {
  /** A unique symbol to identify ADK agent tool class. */
  readonly[AGENT_TOOL_SIGNATURE_SYMBOL] = true;

  private readonly agent: BaseAgent;

  private readonly skipSummarization: boolean;

  constructor(config: AgentToolConfig) {
    super(
        {name: config.agent.name, description: config.agent.description || ''});
    this.agent = config.agent;
    this.skipSummarization = config.skipSummarization || false;
  }

  override _getDeclaration(): FunctionDeclaration {
    let declaration: FunctionDeclaration;

    if (isLlmAgent(this.agent) && this.agent.inputSchema) {
      declaration = {
        name: this.name,
        description: this.description,
        // TODO(b/425992518): We should not use the agent's input schema as is.
        // It should be validated and possibly transformed. Consider similar
        // logic to one we have in Python ADK.
        parameters: this.agent.inputSchema,
      };
    } else {
      declaration = {
        name: this.name,
        description: this.description,
        parameters: {
          type: Type.OBJECT,
          properties: {
            'request': {
              type: Type.STRING,
            },
          },
          required: ['request'],
        },
      };
    }

    if (this.apiVariant !== GoogleLLMVariant.GEMINI_API) {
      const hasOutputSchema = isLlmAgent(this.agent) && this.agent.outputSchema;
      declaration.response =
          hasOutputSchema ? {type: Type.OBJECT} : {type: Type.STRING};
    }

    return declaration;
  }

  override async runAsync({args, toolContext}: RunAsyncToolRequest):
      Promise<unknown> {
    if (this.skipSummarization) {
      toolContext.actions.skipSummarization = true;
    }

    const hasInputSchema = isLlmAgent(this.agent) && this.agent.inputSchema;
    const content: Content = {
      role: 'user',
      parts: [
        {
          // TODO(b/425992518): Should be validated. Consider similar
          // logic to one we have in Python ADK.
          text: hasInputSchema ? JSON.stringify(args) :
                                 args['request'] as string,
        },
      ],
    };

    const runner = new Runner({
      appName: this.agent.name,
      agent: this.agent,
      artifactService: new ForwardingArtifactService(toolContext),
      sessionService: new InMemorySessionService(),
      memoryService: new InMemoryMemoryService(),
      credentialService: toolContext.invocationContext.credentialService,
    });

    const session = await runner.sessionService.createSession({
      appName: this.agent.name,
      userId: 'tmp_user',
      state: toolContext.state.toRecord(),
    });

    let lastEvent: Event|undefined;
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: content,
    })) {
      if (event.actions.stateDelta) {
        toolContext.state.update(event.actions.stateDelta);
      }

      lastEvent = event;
    }

    if (!lastEvent?.content?.parts?.length) {
      return '';
    }

    const hasOutputSchema = isLlmAgent(this.agent) && this.agent.outputSchema;
    const mergedText = lastEvent.content.parts.map((part) => part.text)
                           .filter((text) => text)
                           .join('\n');

    // TODO - b/425992518: In case of output schema, the output should be
    // validated. Consider similar logic to one we have in Python ADK.
    return hasOutputSchema ? JSON.parse(mergedText) : mergedText;
  }
}
