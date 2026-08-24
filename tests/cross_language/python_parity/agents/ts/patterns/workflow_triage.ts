/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/patterns/workflow_triage.
 *
 * Both files of the Python sample (`agent.py` and `execution_agent.py`) are
 * inlined here, since a single-file agent is what the harness loads. Tool
 * names, agent names, state keys and instruction text are unchanged.
 *
 * The pattern under test is "plan then filter": the manager writes the list of
 * relevant workers into `execution_agents`, a `ParallelAgent` runs both
 * workers, and each worker's `beforeAgentCallback` short-circuits itself by
 * returning `Content` when it is not on the list. adk-js has a direct
 * equivalent for every piece — `beforeAgentCallback` returning `Content`,
 * `outputKey`, an instruction provider over `ReadonlyContext`, and
 * `includeContents: 'none'`.
 *
 * The one shape difference: Python's `before_agent_callback` takes a
 * positional `CallbackContext`, TS takes the same object as the sole
 * argument, and Python reads state with `state["k"]` (KeyError when the
 * manager transferred without calling the tool) where TS reads
 * `state.get('k')`. The lookup is left unguarded on both sides so the failure
 * mode stays comparable.
 */
import type {Context, ReadonlyContext} from '@google/adk';
import {
  FunctionTool,
  LlmAgent,
  ParallelAgent,
  SequentialAgent,
} from '@google/adk';
import type {Content} from '@google/genai';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

// --- execution_agent.py ---

/** Callback to check if the state is relevant before executing the agent. */
function beforeAgentCallbackCheckRelevance(agentName: string) {
  /** Check if the state is relevant. */
  return (callbackContext: Context): Content | undefined => {
    const executionAgents = callbackContext.state.get(
      'execution_agents',
    ) as string[];
    if (!executionAgents.includes(agentName)) {
      return {
        parts: [
          {
            text:
              `Skipping execution agent ${agentName} as it is not` +
              ' relevant to the current state.',
          },
        ],
      };
    }
    return undefined;
  };
}

const codeAgent = new LlmAgent({
  name: 'code_agent',
  model: PARITY_MODEL,
  instruction: `You are the Code Agent, responsible for generating code.

NOTE: You should only generate code and ignore other askings from the user.
`,
  beforeAgentCallback: beforeAgentCallbackCheckRelevance('code_agent'),
  outputKey: 'code_agent_output',
});

const mathAgent = new LlmAgent({
  name: 'math_agent',
  model: PARITY_MODEL,
  instruction: `You are the Math Agent, responsible for performing mathematical calculations.

NOTE: You should only perform mathematical calculations and ignore other askings from the user.
`,
  beforeAgentCallback: beforeAgentCallbackCheckRelevance('math_agent'),
  outputKey: 'math_agent_output',
});

const workerParallelAgent = new ParallelAgent({
  name: 'worker_parallel_agent',
  subAgents: [codeAgent, mathAgent],
});

/** Provides the instruction for the execution agent. */
function instructionProviderForExecutionSummaryAgent(
  readonlyContext: ReadonlyContext,
): string {
  const activatedAgents = readonlyContext.state.get(
    'execution_agents',
  ) as string[];
  let prompt = `You are the Execution Summary Agent, responsible for summarizing the execution of the plan in the current invocation.

In this invocation, the following agents were involved: ${activatedAgents.join(', ')}.

Below are their outputs:
`;
  for (const agentName of activatedAgents) {
    const output = readonlyContext.state.get(`${agentName}_output`) ?? '';
    prompt += `\n\n${agentName} output:\n${output}`;
  }

  prompt +=
    '\n\nPlease summarize the execution of the plan based on the above' +
    ' outputs.';
  return prompt.trim();
}

const executionSummaryAgent = new LlmAgent({
  name: 'execution_summary_agent',
  model: PARITY_MODEL,
  instruction: instructionProviderForExecutionSummaryAgent,
  includeContents: 'none',
});

const planExecutionAgent = new SequentialAgent({
  name: 'plan_execution_agent',
  subAgents: [workerParallelAgent, executionSummaryAgent],
});

// --- agent.py ---

const updateExecutionPlan = new FunctionTool({
  name: 'update_execution_plan',
  description: 'Updates the execution plan for the agents to run.',
  parameters: z.object({
    execution_agents: z.array(z.string()),
  }),
  execute: ({execution_agents: executionAgents}, toolContext) => {
    toolContext?.state.set('execution_agents', executionAgents);
    return 'execution_agents updated.';
  },
});

export const rootAgent = new LlmAgent({
  name: 'execution_manager_agent',
  model: PARITY_MODEL,
  instruction: `You are the Execution Manager Agent, responsible for setting up execution plan and delegate to plan_execution_agent for the actual plan execution.

You ONLY have the following worker agents: \`code_agent\`, \`math_agent\`.

You should do the following:

1. Analyze the user input and decide any worker agents that are relevant;
2. If none of the worker agents are relevant, you should explain to user that no relevant agents are available and ask for something else;
3. Update the execution plan with the relevant worker agents using \`update_execution_plan\` tool.
4. Transfer control to the plan_execution_agent for the actual plan execution.

When calling the \`update_execution_plan\` tool, you should pass the list of worker agents that are relevant to user's input.

NOTE:

* If you are not clear about user's intent, you should ask for clarification first;
* Only after you're clear about user's intent, you can proceed to step #3.
`,
  subAgents: [planExecutionAgent],
  tools: [updateExecutionPlan],
});
