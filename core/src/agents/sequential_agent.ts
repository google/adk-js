/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {Event} from '../events/event.js';
import {FunctionTool} from '../tools/function_tool.js';

import {BaseAgent} from './base_agent.js';
import {InvocationContext} from './invocation_context.js';
import {LlmAgent} from './llm_agent.js';
import {ReadonlyContext} from './readonly_context.js';

const TASK_COMPLETED_TOOL_NAME = 'task_completed';

/**
 * A shell agent that runs its sub-agents in a sequential order.
 */
export class SequentialAgent extends BaseAgent {
  protected async *
      runImpl(
          context: InvocationContext,
          ): AsyncGenerator<Event, void, void> {
    for (const subAgent of this.subAgents) {
      for await (const event of subAgent.run(context)) {
        yield event;
      }
    }
  }

  /**
   * Implementation for live SequentialAgent.
   *
   * Compared to the non-live case, live agents process a continuous stream of
   * audio or video, so there is no way to tell if it's finished and should pass
   * to the next agent or not. So we introduce a task_completed() function so
   * the model can call this function to signal that it's finished the task and
   * we can move on to the next agent.
   *
   * @param context: The invocation context of the agent.
   */
  protected async *
      runLiveImpl(
          context: InvocationContext,
          ): AsyncGenerator<Event, void, void> {
    for (const subAgent of this.subAgents) {
      if (subAgent instanceof LlmAgent) {
        const agentTools =
            await subAgent.canonicalTools(new ReadonlyContext(context));
        const taskCompletedToolAlreadyAdded =
            agentTools.some(tool => tool.name === TASK_COMPLETED_TOOL_NAME);

        if (!taskCompletedToolAlreadyAdded) {
          subAgent.tools.push(new FunctionTool({
            name: TASK_COMPLETED_TOOL_NAME,
            description: `Signals that the model has successfully completed the user's question or task.`,
            execute: () => 'Task completion signaled.'
          }));
          subAgent.instruction +=
              `If you finished the user's request according to its description, call the ${
                  TASK_COMPLETED_TOOL_NAME} function to exit so the next agents can take over. When calling this function, do not generate any text other than the function call.`;
        }
      }
    }

    for (const subAgent of this.subAgents) {
      for await (const event of subAgent.runLive(context)) {
        yield event;
      }
    }
  }
}
