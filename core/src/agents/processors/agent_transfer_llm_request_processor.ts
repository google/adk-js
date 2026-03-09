/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {Event} from '../../events/event.js';
import {appendInstructions, LlmRequest} from '../../models/llm_request.js';
import {FunctionTool} from '../../tools/function_tool.js';
import {BaseAgent} from '../base_agent.js';
import {Context} from '../context.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent, LlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

export class AgentTransferLlmRequestProcessor extends BaseLlmRequestProcessor {
  private readonly toolName = 'transfer_to_agent' as const;
  private readonly tool = new FunctionTool({
    name: this.toolName,
    description:
      'Transfer the question to another agent. This tool hands off control to another agent when it is more suitable to answer the user question according to the agent description.',
    parameters: z.object({
      agentName: z.string().describe('the agent name to transfer to.'),
    }),
    execute: function (args: {agentName: string}, toolContext?: Context) {
      if (!toolContext) {
        throw new Error('toolContext is required.');
      }
      toolContext.actions.transferToAgent = args.agentName;
      return 'Transfer queued';
    },
  });

  // eslint-disable-next-line require-yield
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    if (!isLlmAgent(invocationContext.agent)) {
      return;
    }

    const transferTargets = this.getTransferTargets(invocationContext.agent);
    if (!transferTargets.length) {
      return;
    }

    appendInstructions(llmRequest, [
      this.buildTargetAgentsInstructions(
        invocationContext.agent,
        transferTargets,
      ),
    ]);

    const toolContext = new Context({invocationContext});
    await this.tool.processLlmRequest({toolContext, llmRequest});
  }

  private buildTargetAgentsInfo(targetAgent: BaseAgent): string {
    return `
Agent name: ${targetAgent.name}
Agent description: ${targetAgent.description}
`;
  }

  private buildTargetAgentsInstructions(
    agent: LlmAgent,
    targetAgents: BaseAgent[],
  ): string {
    let instructions = `
You have a list of other agents to transfer to:

${targetAgents.map((t) => this.buildTargetAgentsInfo(t)).join('\n')}

If you are the best to answer the question according to your description, you
can answer it.

If another agent is better for answering the question according to its
description, call \`${this.toolName}\` function to transfer the
question to that agent. When transferring, do not generate any text other than
the function call.
`;

    if (agent.parentAgent && !agent.disallowTransferToParent) {
      instructions += `
Your parent agent is ${agent.parentAgent.name}. If neither the other agents nor
you are best for answering the question according to the descriptions, transfer
to your parent agent.
`;
    }
    return instructions;
  }

  private getTransferTargets(agent: LlmAgent): BaseAgent[] {
    const targets: BaseAgent[] = [];
    targets.push(...agent.subAgents);

    if (!agent.parentAgent || !isLlmAgent(agent.parentAgent)) {
      return targets;
    }

    if (!agent.disallowTransferToParent) {
      targets.push(agent.parentAgent);
    }

    if (!agent.disallowTransferToPeers) {
      targets.push(
        ...agent.parentAgent.subAgents.filter(
          (peerAgent) => peerAgent.name !== agent.name,
        ),
      );
    }

    return targets;
  }
}

export const AGENT_TRANSFER_LLM_REQUEST_PROCESSOR =
  new AgentTransferLlmRequestProcessor();
