/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FinishReason,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
  Part,
} from '@google/genai';
import {vi} from 'vitest';
import {z} from 'zod';

import {LlmAgent} from '../../../../src/agents/llm_agent.js';
import {StreamingMode} from '../../../../src/agents/run_config.js';
import {
  BaseCodeExecutor,
  ExecuteCodeParams,
} from '../../../../src/code_executors/base_code_executor.js';
import {CodeExecutionResult} from '../../../../src/code_executors/code_execution_utils.js';
import {LlmSummarizer} from '../../../../src/context/summarizers/llm_summarizer.js';
import {TokenBasedContextCompactor} from '../../../../src/context/token_based_context_compactor.js';
import {createEvent, Event} from '../../../../src/events/event.js';
import {BaseLlm} from '../../../../src/models/base_llm.js';
import {BaseLlmConnection} from '../../../../src/models/base_llm_connection.js';
import {LlmRequest} from '../../../../src/models/llm_request.js';
import {LlmResponse} from '../../../../src/models/llm_response.js';
import {InMemoryRunner} from '../../../../src/runner/in_memory_runner.js';
import {Frontmatter, Skill} from '../../../../src/skills/skill.js';
import {SkillRegistry} from '../../../../src/skills/skill_registry.js';
import {AgentTool} from '../../../../src/tools/agent_tool.js';
import {FunctionTool} from '../../../../src/tools/function_tool.js';
import {StreamableHTTPConnectionParams} from '../../../../src/tools/mcp/mcp_session_manager.js';
import {MCPToolset} from '../../../../src/tools/mcp/mcp_toolset.js';
import {SkillToolset} from '../../../../src/tools/skill/skill_toolset.js';
import {Workflow} from '../../../../src/workflow/workflow.js';
import {
  CompactionSetup,
  FunctionalTestCase,
  SkillResourceType,
  SkillType,
} from '../recording.js';

import {
  AGENT_DESCRIPTION,
  AGENT_NAME,
  AGENT_TOOL_WORKFLOW_NAME,
  BASE_INSTRUCTION,
  COMPACTION_APP_NAME,
  COMPACTION_SEEDED_INVOCATION_COUNT,
  COMPACTION_SEEDED_PROMPT_TOKEN_COUNT,
  COMPACTION_SUMMARY,
  COMPACTION_TOKEN_THRESHOLD,
  COMPACTION_UNREACHABLE_TOKEN_THRESHOLD,
  COMPACTION_USER_ID,
  DELEGATE_AGENT_DESCRIPTION,
  DELEGATE_AGENT_NAME,
  DELEGATING_AGENT_DESCRIPTION,
  DELEGATING_AGENT_NAME,
  FINAL_TEXT,
  FIRST_TURN_USAGE,
  GROUNDING_METADATA,
  LOCAL_SKILL_NAME,
  MCP_AUTHORIZATION,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_URL,
  MCP_SESSION_ID,
  MCP_TOOL_DESCRIPTION,
  MODEL_NAME,
  NESTED_AGENT_DESCRIPTION,
  NESTED_AGENT_NAME,
  NESTED_TURN_USAGE,
  NESTED_WORKFLOW_NAME,
  NODE_APP_NAME,
  NODE_RESULT,
  NODE_USER_ID,
  NONEXISTENT_SKILL_NAME,
  REGISTRY_SKILL_NAME,
  SECOND_TURN_USAGE,
  SKILL_DESCRIPTION,
  SKILL_SCRIPT_OUTPUT_DIR,
  SPECIALIST_AGENT_DESCRIPTION,
  SPECIALIST_AGENT_NAME,
  STREAMED_TEXT_CHUNKS,
  TOOL_ARGS,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  TOOL_RESULT_PREFIX,
  USER_PROMPT,
  WORKFLOW_NAME,
} from './testcasedata.js';

/**
 * One scripted turn for {@link ScriptedModel}: either a single response, a
 * sequence of streaming chunks, or an error to throw.
 */
export type ScriptedTurn = LlmResponse | readonly LlmResponse[] | Error;

function makePartResponse(options: {
  part: Part;
  usageMetadata: GenerateContentResponseUsageMetadata;
  groundingMetadata?: GroundingMetadata;
  partial?: boolean;
  turnComplete?: boolean;
}): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [options.part],
    },
    usageMetadata: options.usageMetadata,
    groundingMetadata: options.groundingMetadata,
    partial: options.partial,
    turnComplete: options.turnComplete,
    finishReason: options.partial ? undefined : FinishReason.STOP,
  };
}

/**
 * Deterministic {@link BaseLlm} implementation driven by a queue of
 * {@link ScriptedTurn} items.
 */
export class ScriptedModel extends BaseLlm {
  private readonly turns: ScriptedTurn[];
  private callIndex = 0;

  constructor(turns: readonly ScriptedTurn[], modelName = MODEL_NAME) {
    super({model: modelName});
    this.turns = [...turns];
  }

  override async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    const turn = this.turns[this.callIndex];
    this.callIndex += 1;
    if (!turn) {
      throw new Error(
        `ScriptedModel exhausted at call ${this.callIndex} (configured turns: ${this.turns.length}).`,
      );
    }
    if (turn instanceof Error) {
      throw turn;
    }
    if (Array.isArray(turn)) {
      for (const chunk of turn) {
        yield chunk;
      }
      return;
    }
    yield turn as LlmResponse;
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connection is not supported by ScriptedModel.');
  }
}

function buildToolCallingTurns(options?: {
  grounding?: boolean;
  modelException?: Error;
}): ScriptedTurn[] {
  if (options?.modelException) {
    return [options.modelException];
  }
  return [
    makePartResponse({
      part: {functionCall: {name: TOOL_NAME, args: {...TOOL_ARGS}}},
      usageMetadata: FIRST_TURN_USAGE,
    }),
    makePartResponse({
      part: {text: FINAL_TEXT},
      usageMetadata: SECOND_TURN_USAGE,
      groundingMetadata: options?.grounding ? GROUNDING_METADATA : undefined,
    }),
  ];
}

function buildSampleTool(toolException?: Error) {
  return new FunctionTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: z.object({arg1: z.string()}),
    execute: async ({arg1}: {arg1: string}) => {
      if (toolException) {
        throw toolException;
      }
      return `${TOOL_RESULT_PREFIX}${arg1}`;
    },
  });
}

function buildTestAgent(model: BaseLlm, toolException?: Error): LlmAgent {
  return new LlmAgent({
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
    tools: [buildSampleTool(toolException)],
  });
}

async function runWithInMemoryRunner(
  agentOrWorkflow: LlmAgent | Workflow,
  options?: {
    appName?: string;
    userId?: string;
    streamingMode?: StreamingMode;
    seedEvents?: readonly Event[];
  },
): Promise<void> {
  const appName = options?.appName ?? 'InMemoryRunner';
  const userId = options?.userId ?? 'test_user';
  const runner = new InMemoryRunner({
    agent: agentOrWorkflow,
    appName,
  });
  const session = await runner.sessionService.createSession({
    appName,
    userId,
  });
  if (options?.seedEvents) {
    for (const event of options.seedEvents) {
      await runner.sessionService.appendEvent({session, event});
    }
  }
  for await (const _event of runner.runAsync({
    userId,
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: USER_PROMPT}]},
    runConfig: options?.streamingMode
      ? {streamingMode: options.streamingMode}
      : undefined,
  })) {
    // Drain all events from the run.
  }
}

async function runAgentScenario(tc: FunctionalTestCase): Promise<void> {
  const model = new ScriptedModel(
    buildToolCallingTurns({
      grounding: tc.grounding,
      modelException: tc.modelException,
    }),
  );
  const agent = buildTestAgent(model, tc.toolException);
  await runWithInMemoryRunner(agent);
}

async function runStreamingScenario(_tc: FunctionalTestCase): Promise<void> {
  const streamingTurns: ScriptedTurn[] = [
    [
      makePartResponse({
        part: {functionCall: {name: TOOL_NAME, args: {...TOOL_ARGS}}},
        usageMetadata: FIRST_TURN_USAGE,
        partial: false,
        turnComplete: true,
      }),
    ],
    STREAMED_TEXT_CHUNKS.map((chunk, index) =>
      makePartResponse({
        part: {text: chunk},
        usageMetadata: SECOND_TURN_USAGE,
        partial: index < STREAMED_TEXT_CHUNKS.length - 1,
        turnComplete: index === STREAMED_TEXT_CHUNKS.length - 1,
      }),
    ),
  ];
  const model = new ScriptedModel(streamingTurns);
  const agent = buildTestAgent(model);
  await runWithInMemoryRunner(agent, {streamingMode: StreamingMode.SSE});
}

async function runMultiAgentScenario(_tc: FunctionalTestCase): Promise<void> {
  const turns: ScriptedTurn[] = [
    makePartResponse({
      part: {
        functionCall: {
          name: 'transfer_to_agent',
          args: {agent_name: SPECIALIST_AGENT_NAME},
        },
      },
      usageMetadata: FIRST_TURN_USAGE,
    }),
    makePartResponse({
      part: {text: FINAL_TEXT},
      usageMetadata: SECOND_TURN_USAGE,
    }),
  ];
  const model = new ScriptedModel(turns);
  const specialist = new LlmAgent({
    name: SPECIALIST_AGENT_NAME,
    description: SPECIALIST_AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
  });
  const rootAgent = new LlmAgent({
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
    subAgents: [specialist],
  });
  await runWithInMemoryRunner(rootAgent);
}

async function runAgentToolScenario(_tc: FunctionalTestCase): Promise<void> {
  const turns: ScriptedTurn[] = [
    makePartResponse({
      part: {
        functionCall: {
          name: DELEGATE_AGENT_NAME,
          args: {request: USER_PROMPT},
        },
      },
      usageMetadata: FIRST_TURN_USAGE,
    }),
    makePartResponse({
      part: {text: NODE_RESULT},
      usageMetadata: NESTED_TURN_USAGE,
    }),
    makePartResponse({
      part: {text: FINAL_TEXT},
      usageMetadata: SECOND_TURN_USAGE,
    }),
  ];
  const model = new ScriptedModel(turns);
  const delegate = new LlmAgent({
    name: DELEGATE_AGENT_NAME,
    description: DELEGATE_AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
  });
  const delegatingAgent = new LlmAgent({
    name: DELEGATING_AGENT_NAME,
    description: DELEGATING_AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
    tools: [new AgentTool({agent: delegate})],
  });
  const workflow = new Workflow({
    name: AGENT_TOOL_WORKFLOW_NAME,
    edges: [['START', delegatingAgent]],
  });
  await runWithInMemoryRunner(workflow, {
    appName: NODE_APP_NAME,
    userId: NODE_USER_ID,
  });
}

async function some_node(): Promise<string> {
  return NODE_RESULT;
}

async function runNodeScenario(_tc: FunctionalTestCase): Promise<void> {
  const model = new ScriptedModel(buildToolCallingTurns());
  const testAgent = buildTestAgent(model);
  const nestedWorkflow = new Workflow({
    name: NESTED_WORKFLOW_NAME,
    edges: [['START', some_node]],
  });
  const workflow = new Workflow({
    name: WORKFLOW_NAME,
    edges: [['START', nestedWorkflow, testAgent]],
  });
  await runWithInMemoryRunner(workflow, {
    appName: NODE_APP_NAME,
    userId: NODE_USER_ID,
  });
}

async function runNestedAgentsInWorkflowScenario(
  _tc: FunctionalTestCase,
): Promise<void> {
  const turns: ScriptedTurn[] = [
    makePartResponse({
      part: {text: NODE_RESULT},
      usageMetadata: NESTED_TURN_USAGE,
    }),
    ...buildToolCallingTurns(),
  ];
  const model = new ScriptedModel(turns);
  const nestedAgent = new LlmAgent({
    name: NESTED_AGENT_NAME,
    description: NESTED_AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
  });
  const nestedWorkflow = new Workflow({
    name: NESTED_WORKFLOW_NAME,
    edges: [['START', nestedAgent]],
  });
  const testAgent = buildTestAgent(model);
  const workflow = new Workflow({
    name: WORKFLOW_NAME,
    edges: [['START', nestedWorkflow, testAgent]],
  });
  await runWithInMemoryRunner(workflow, {
    appName: NODE_APP_NAME,
    userId: NODE_USER_ID,
  });
}

function buildSeededCompactionHistory(): Event[] {
  const events: Event[] = [];
  for (let index = 0; index < COMPACTION_SEEDED_INVOCATION_COUNT; index += 1) {
    const invocationId = `seeded-invocation-${index}`;
    events.push(
      createEvent({
        timestamp: index * 2 + 1,
        invocationId,
        author: 'user',
        content: {
          role: 'user',
          parts: [{text: `question ${index}`}],
        },
      }),
    );
    events.push(
      createEvent({
        timestamp: index * 2 + 2,
        invocationId,
        author: AGENT_NAME,
        content: {
          role: 'model',
          parts: [{text: `answer ${index}`}],
        },
        usageMetadata: {
          promptTokenCount: COMPACTION_SEEDED_PROMPT_TOKEN_COUNT,
        },
      }),
    );
  }
  return events;
}

function buildTokenCompactor(
  setup: CompactionSetup,
): TokenBasedContextCompactor {
  const summarizerModel = new ScriptedModel([
    makePartResponse({
      part: {text: COMPACTION_SUMMARY},
      usageMetadata: {},
    }),
  ]);
  const summarizer = new LlmSummarizer({llm: summarizerModel});
  const tokenThreshold =
    setup === 'token_threshold'
      ? COMPACTION_TOKEN_THRESHOLD
      : COMPACTION_UNREACHABLE_TOKEN_THRESHOLD;
  return new TokenBasedContextCompactor({
    tokenThreshold,
    eventRetentionSize: 1,
    summarizer,
  });
}

async function runCompactionScenario(tc: FunctionalTestCase): Promise<void> {
  const model = new ScriptedModel(buildToolCallingTurns());
  const compactor = buildTokenCompactor(
    tc.compactionSetup ?? 'token_threshold',
  );
  const agent = new LlmAgent({
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
    tools: [buildSampleTool()],
    contextCompactors: [compactor],
  });
  await runWithInMemoryRunner(agent, {
    appName: COMPACTION_APP_NAME,
    userId: COMPACTION_USER_ID,
    seedEvents: buildSeededCompactionHistory(),
  });
}

function makeSkill(options?: {
  name?: string;
  additionalTools?: readonly string[];
}): Skill {
  const name = options?.name ?? LOCAL_SKILL_NAME;
  const additionalTools = options?.additionalTools ?? [];
  return {
    frontmatter: {
      name,
      description: SKILL_DESCRIPTION,
      metadata: {
        adk_additional_tools: [...additionalTools],
      },
    },
    instructions: 'skill instructions',
    resources: {
      references: {ref1: 'ref1_content'},
      assets: {'deeply/hidden/asset1': 'asset1_content'},
      scripts: {
        script1: {src: 'script1_content'},
        'ec_0.py': {src: "print(':D')"},
        'ec_1.py': {src: 'foo = 1/0'},
        'ec_10.py': {src: 'import sys; sys.exit(10)'},
      },
    },
  };
}

class FakeSkillRegistry implements SkillRegistry {
  constructor(private readonly skill: Skill) {}

  async getSkill(name: string): Promise<Skill> {
    if (name === this.skill.frontmatter.name) {
      return structuredClone(this.skill);
    }
    throw new Error(`Skill ${name} not found`);
  }

  async searchSkills(_query: string): Promise<Frontmatter[]> {
    return [];
  }
}

class FakeSkillCodeExecutor extends BaseCodeExecutor {
  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const code = params.codeExecutionInput.code;
    if (code.includes('ec_0.py')) {
      return {
        stdout: ':D\n',
        stderr: '',
        outputFiles: [],
      };
    }
    if (code.includes('ec_1.py')) {
      return {
        stdout: '',
        stderr: 'ZeroDivisionError: division by zero\n',
        outputFiles: [],
      };
    }
    if (code.includes('ec_10.py')) {
      return {
        stdout: '',
        stderr: '',
        outputFiles: [],
      };
    }
    return {
      stdout: '',
      stderr: '',
      outputFiles: [],
    };
  }
}

function buildSkillCallPart(skill: SkillType): Part {
  const skillNameByType: Record<SkillType, string> = {
    local: LOCAL_SKILL_NAME,
    registry: REGISTRY_SKILL_NAME,
    nonexistent: NONEXISTENT_SKILL_NAME,
  };
  return {
    functionCall: {
      name: 'load_skill',
      args: {name: skillNameByType[skill]},
    },
  };
}

function buildSkillResourceCallPart(resource: SkillResourceType): Part {
  const pathByType: Record<SkillResourceType, string> = {
    references: 'references/ref1',
    assets: 'assets/deeply/hidden/asset1',
    scripts: 'scripts/script1',
    wrong_type: 'fake/file/not/existing',
    wrong_name: 'references/nope/never',
  };
  return {
    functionCall: {
      name: 'load_skill_resource',
      args: {
        skill_name: REGISTRY_SKILL_NAME,
        path: pathByType[resource],
      },
    },
  };
}

function buildRunScriptCallPart(exitCode: number): Part {
  return {
    functionCall: {
      name: 'run_skill_script',
      args: {
        skill_name: REGISTRY_SKILL_NAME,
        script_path: `scripts/ec_${exitCode}.py`,
      },
    },
  };
}

function buildSkillTurns(tc: FunctionalTestCase): ScriptedTurn[] {
  const turns: ScriptedTurn[] = [];
  for (const skill of tc.loadedSkills ?? []) {
    turns.push(
      makePartResponse({
        part: buildSkillCallPart(skill),
        usageMetadata: FIRST_TURN_USAGE,
      }),
    );
  }
  for (const resource of tc.loadedResources ?? []) {
    turns.push(
      makePartResponse({
        part: buildSkillResourceCallPart(resource),
        usageMetadata: FIRST_TURN_USAGE,
      }),
    );
  }
  for (const exitCode of tc.scriptReturnExitCodes ?? []) {
    turns.push(
      makePartResponse({
        part: buildRunScriptCallPart(exitCode),
        usageMetadata: FIRST_TURN_USAGE,
      }),
    );
  }
  turns.push(
    makePartResponse({
      part: {text: FINAL_TEXT},
      usageMetadata: SECOND_TURN_USAGE,
    }),
  );
  return turns;
}

async function runSkillScenario(tc: FunctionalTestCase): Promise<void> {
  const model = new ScriptedModel(buildSkillTurns(tc));
  const registry = new FakeSkillRegistry(
    makeSkill({name: REGISTRY_SKILL_NAME}),
  );
  const toolset = new SkillToolset(
    [makeSkill({additionalTools: ['foo', 'bar']})],
    {
      registry,
      codeExecutor: new FakeSkillCodeExecutor(),
      scriptOutputDir: SKILL_SCRIPT_OUTPUT_DIR,
    },
  );
  vi.spyOn(toolset, 'getScriptOutputDir').mockResolvedValue(
    SKILL_SCRIPT_OUTPUT_DIR,
  );
  const agent = new LlmAgent({
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
    tools: [toolset],
  });
  await runWithInMemoryRunner(agent);
}

interface JsonRpcRequestPayload {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: {
    readonly name?: string;
    readonly arguments?: Record<string, unknown>;
  };
}

function createInMemoryMcpFetch(): typeof fetch {
  const responseHeaders = {
    'content-type': 'application/json',
    'mcp-session-id': MCP_SESSION_ID,
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
  };

  return async (
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      return new Response(null, {status: 405});
    }
    if (method === 'DELETE') {
      return new Response(null, {status: 200});
    }

    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    const rpc = JSON.parse(rawBody) as JsonRpcRequestPayload;

    if (rpc.method === 'initialize') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id ?? 1,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {tools: {}},
            serverInfo: {name: 'test-mcp-server', version: '1.0.0'},
          },
        }),
        {status: 200, headers: responseHeaders},
      );
    }

    if (rpc.method === 'notifications/initialized') {
      return new Response(null, {status: 202, headers: responseHeaders});
    }

    if (rpc.method === 'tools/list') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id ?? 2,
          result: {
            tools: [
              {
                name: TOOL_NAME,
                description: MCP_TOOL_DESCRIPTION,
                inputSchema: {
                  type: 'object',
                  properties: {arg1: {type: 'string'}},
                  required: ['arg1'],
                },
              },
            ],
          },
        }),
        {status: 200, headers: responseHeaders},
      );
    }

    if (rpc.method === 'tools/call') {
      const arg1 = String(rpc.params?.arguments?.['arg1'] ?? '');
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id ?? 3,
          result: {
            content: [{type: 'text', text: `${TOOL_RESULT_PREFIX}${arg1}`}],
            isError: false,
          },
        }),
        {status: 200, headers: responseHeaders},
      );
    }

    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id ?? 0,
        result: {},
      }),
      {status: 200, headers: responseHeaders},
    );
  };
}

async function runMcpScenario(_tc: FunctionalTestCase): Promise<void> {
  const model = new ScriptedModel(buildToolCallingTurns());
  const connectionParams: StreamableHTTPConnectionParams = {
    type: 'StreamableHTTPConnectionParams',
    url: MCP_SERVER_URL,
    header: {Authorization: MCP_AUTHORIZATION},
    terminateOnClose: false,
    transportOptions: {
      fetch: createInMemoryMcpFetch(),
    },
  };
  const mcpToolset = new MCPToolset(connectionParams);
  const agent = new LlmAgent({
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
    tools: [mcpToolset],
  });
  await runWithInMemoryRunner(agent);
}

/**
 * Executes the scenario graph corresponding to `tc.scenario`.
 */
export async function executeScenario(tc: FunctionalTestCase): Promise<void> {
  switch (tc.scenario) {
    case 'agent':
      await runAgentScenario(tc);
      break;
    case 'agent_tool':
      await runAgentToolScenario(tc);
      break;
    case 'conversational_agent_compaction':
      await runCompactionScenario(tc);
      break;
    case 'mcp':
      await runMcpScenario(tc);
      break;
    case 'multi_agent':
      await runMultiAgentScenario(tc);
      break;
    case 'nested_agents_in_workflow':
      await runNestedAgentsInWorkflowScenario(tc);
      break;
    case 'node':
      await runNodeScenario(tc);
      break;
    case 'skill':
      await runSkillScenario(tc);
      break;
    case 'streaming':
      await runStreamingScenario(tc);
      break;
    default: {
      const exhaustiveCheck: never = tc.scenario;
      throw new Error(`Unhandled scenario: ${String(exhaustiveCheck)}`);
    }
  }
}
