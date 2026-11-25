/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agents (`LlmAgent`, `SequentialAgent`, `ParallelAgent`, `LoopAgent`, `LangGraphAgent`, and `LlmCallsLimitExceededError`)
 * ../../docs/guides/agents/index.md
 *
 * Demonstrates the `agents` subsystem in `@google/adk` without requiring an API
 * key:
 * 1. `LlmAgent` with a dynamic `InstructionProvider` (`ReadonlyContext`),
 *    `outputKey`, `beforeAgentCallback`, and `afterAgentCallback`
 *    (`CallbackContext`, including `saveArtifact` and `listArtifacts`).
 * 2. `ParallelAgent`, `LoopAgent`, and `SequentialAgent` orchestrating a custom
 *    `BaseAgent` subclass (`QualityCheckAgent`) that saves a session artifact
 *    via `ctx.artifactService.saveArtifact` and escalates on completion.
 * 3. `LangGraphAgent` wrapping an in-memory `CompiledGraphLike` state graph.
 * 4. `RunConfig.maxLlmCalls` enforcement throwing `LlmCallsLimitExceededError`
 *    across a multi-iteration `LoopAgent`.
 * 5. `Context.saveCredential` and `Context.loadCredential` inside agent
 *    callbacks using `Runner` configured with `InMemoryCredentialService`.
 * 6. `LlmAgent` configured with both `outputSchema` and a `BaseToolset` using
 *    `toolNamePrefix`, resolving prefixed tools via `getToolsWithPrefix` and
 *    saving validated structured JSON under `outputKey`.
 *
 * This sample exports `rootAgent` for `adk web` and `npm run sample`, and also
 * includes a direct `InMemoryRunner` driver in `main()` to inspect the agent
 * type guards, multi-agent event authors, saved artifact revisions, and
 * `LlmCallsLimitExceededError` handling that the CLI does not trigger by
 * default.
 *
 * Run (offline, no API key):
 *   npm run build
 *   npx tsx samples/agents/agent.ts
 *   npm run sample -- samples/agents/agent.ts
 */

import {
  AuthConfig,
  AuthCredentialTypes,
  BaseAgent,
  BaseAgentConfig,
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  BaseToolset,
  CompiledGraphLike,
  Event,
  FunctionTool,
  InMemoryArtifactService,
  InMemoryCredentialService,
  InMemoryRunner,
  InMemorySessionService,
  InvocationContext,
  LangGraphAIMessage,
  LangGraphAgent,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LoopAgent,
  ParallelAgent,
  Runner,
  SET_MODEL_RESPONSE_TOOL_NAME,
  SequentialAgent,
  createEvent,
  isFinalResponse,
  isLangGraphAgent,
  isLlmAgent,
  isLlmCallsLimitExceededError,
  isLoopAgent,
  isParallelAgent,
  isSequentialAgent,
  stringifyContent,
} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';

/**
 * Deterministic offline `BaseLlm` implementation used by `rootAgent` and `main()`
 * so the sample runs without external API credentials.
 */
class DeterministicDemoLlm extends BaseLlm {
  constructor() {
    super({model: 'deterministic-demo-llm'});
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const lastContent = llmRequest.contents[llmRequest.contents.length - 1];
    const lastText =
      lastContent?.parts
        ?.map((part) => part.text ?? '')
        .join(' ')
        .trim() ?? '';
    const topic = lastText.length > 0 ? lastText : 'general topic';

    yield {
      content: {
        role: 'model',
        parts: [{text: `Summary for "${topic}"`}],
      },
    };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connection is not used in this sample.');
  }
}

/**
 * Offline `BaseToolset` using `toolNamePrefix` so exposed tool names are
 * automatically prefixed without mutating the underlying `FunctionTool`.
 */
class CityGuideToolset extends BaseToolset {
  constructor() {
    super({toolNamePrefix: 'cityGuide'});
  }

  override async getTools(): Promise<BaseTool[]> {
    return [
      new FunctionTool({
        name: 'lookupHighlight',
        description: 'Returns a landmark highlight for a city.',
        parameters: z.object({city: z.string()}),
        execute: async ({city}) => ({
          city,
          highlight: `${city} waterfront`,
        }),
      }),
    ];
  }
}

/**
 * Offline `BaseLlm` driving a prefixed tool call followed by
 * `set_model_response` when `outputSchema` and `tools` are configured together.
 */
class StructuredToolDemoLlm extends BaseLlm {
  constructor() {
    super({model: 'structured-tool-demo-llm'});
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const toolResponsePart = llmRequest.contents
      .flatMap((content) => content.parts ?? [])
      .find(
        (part) => part.functionResponse?.name === 'cityGuide_lookupHighlight',
      );

    if (!toolResponsePart) {
      yield {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-highlight-1',
                name: 'cityGuide_lookupHighlight',
                args: {city: 'Lisbon'},
              },
            },
          ],
        },
      };
      return;
    }

    const responseRecord = toolResponsePart.functionResponse?.response;
    const highlight =
      typeof responseRecord?.['highlight'] === 'string'
        ? responseRecord['highlight']
        : 'Lisbon historic district';

    yield {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-structured-1',
              name: SET_MODEL_RESPONSE_TOOL_NAME,
              args: {city: 'Lisbon', highlight},
            },
          },
        ],
      },
    };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connection is not used in this sample.');
  }
}

interface QualityCheckAgentConfig extends BaseAgentConfig {
  requiredPasses?: number;
}

/**
 * Custom `BaseAgent` subclass used inside a `LoopAgent` to verify state, save
 * an approval artifact via `ctx.artifactService`, and escalate once the target
 * pass count is reached.
 */
class QualityCheckAgent extends BaseAgent<QualityCheckAgentConfig> {
  private readonly requiredPasses: number;

  constructor(config: QualityCheckAgentConfig) {
    super(config);
    this.requiredPasses = config.requiredPasses ?? 2;
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    ctx.incrementLlmCallCount();
    const priorPass = ctx.session.state['review_pass'];
    const currentPass = (typeof priorPass === 'number' ? priorPass : 0) + 1;
    const isApproved = currentPass >= this.requiredPasses;

    const artifactDelta: Record<string, number> = {};
    if (isApproved && ctx.artifactService) {
      const filename = 'quality_report.txt';
      const version = await ctx.artifactService.saveArtifact({
        filename,
        artifact: {
          text: `Approved in ${ctx.appName} on pass ${currentPass}.`,
        },
      });
      artifactDelta[filename] = version;
    }

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      actions: {
        stateDelta: {
          review_pass: currentPass,
          review_approved: isApproved,
        },
        ...(Object.keys(artifactDelta).length > 0 ? {artifactDelta} : {}),
        escalate: isApproved,
      },
      content: {
        role: 'model',
        parts: [
          {
            text: isApproved
              ? `Quality gate approved on pass ${currentPass}.`
              : `Quality gate pass ${currentPass}: requesting one more pass.`,
          },
        ],
      },
    });
  }

  protected override async *runLiveImpl(
    _ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* [];
    throw new Error('Live mode is not supported for QualityCheckAgent.');
  }
}

/**
 * Minimal in-memory `CompiledGraphLike` implementation demonstrating
 * `LangGraphAgent` without requiring an external LangGraph server.
 */
const demoCompiledGraph: CompiledGraphLike = {
  getGraph: () => ({nodes: ['classify']}),
  checkpointer: {},
  getState: () => ({values: {}}),
  invoke: async ({messages}) => {
    const latestMessage = messages[messages.length - 1];
    const latestInput =
      typeof latestMessage?.content === 'string' ? latestMessage.content : '';
    const reply: LangGraphAIMessage = {
      type: 'ai',
      content: `[LangGraph] Classified input (${latestInput.length} chars) as TECHNICAL.`,
    };
    return {
      messages: [...messages, reply],
    };
  },
};

/**
 * Builds the multi-agent showcase pipeline using the provided model.
 */
function createShowcasePipeline(model: string | BaseLlm): SequentialAgent {
  const topicSummarizer = new LlmAgent({
    name: 'topic_summarizer',
    description: 'Summarizes the user topic into session state.',
    model,
    instruction: (ctx) =>
      `Summarize the user request as agent "${ctx.agentName}" in session "${ctx.sessionId}".`,
    outputKey: 'topic_summary',
    beforeAgentCallback: (ctx) => {
      ctx.state.set('summarizer_started', true);
      return undefined;
    },
    afterAgentCallback: async (ctx) => {
      await ctx.saveArtifact('summary-audit.txt', {
        text: `Completed summary for invocation ${ctx.invocationId}`,
      });
      const artifacts = await ctx.listArtifacts();
      if (!artifacts.includes('summary-audit.txt')) {
        throw new Error('Expected summary-audit.txt in listArtifacts().');
      }
      return undefined;
    },
  });

  const graphClassifier = new LangGraphAgent({
    name: 'graph_classifier',
    description: 'Classifies the user prompt using a compiled LangGraph graph.',
    instruction: 'Classify the user request category.',
    graph: demoCompiledGraph,
  });

  const parallelCollectors = new ParallelAgent({
    name: 'parallel_collectors',
    description:
      'Runs the LLM summarizer and LangGraph classifier in parallel.',
    subAgents: [topicSummarizer, graphClassifier],
  });

  const qualityReviewLoop = new LoopAgent({
    name: 'quality_review_loop',
    description: 'Iterates until the quality check agent escalates.',
    maxIterations: 3,
    subAgents: [
      new QualityCheckAgent({
        name: 'quality_gate',
        requiredPasses: 2,
      }),
    ],
  });

  return new SequentialAgent({
    name: 'agents_showcase_pipeline',
    description: 'Orchestrates parallel collection and loop verification.',
    subAgents: [parallelCollectors, qualityReviewLoop],
  });
}

/**
 * Root agent exported for `npm run sample -- samples/agents/agent.ts` and `adk web`.
 */
export const rootAgent = createShowcasePipeline(new DeterministicDemoLlm());

async function main(): Promise<void> {
  process.stdout.write('=== 1. Agent Type Guards ===\n');
  process.stdout.write(
    `isSequentialAgent(rootAgent): ${isSequentialAgent(rootAgent)}\n`,
  );
  process.stdout.write(
    `isParallelAgent(parallel_collectors): ${isParallelAgent(rootAgent.findAgent('parallel_collectors'))}\n`,
  );
  process.stdout.write(
    `isLlmAgent(topic_summarizer): ${isLlmAgent(rootAgent.findAgent('topic_summarizer'))}\n`,
  );
  process.stdout.write(
    `isLangGraphAgent(graph_classifier): ${isLangGraphAgent(rootAgent.findAgent('graph_classifier'))}\n`,
  );
  process.stdout.write(
    `isLoopAgent(quality_review_loop): ${isLoopAgent(rootAgent.findAgent('quality_review_loop'))}\n`,
  );

  process.stdout.write('\n=== 2. Multi-Agent Pipeline Execution ===\n');
  const runner = new InMemoryRunner({
    agent: rootAgent,
    appName: 'agents_sample_app',
  });

  const session = await runner.sessionService.createSession({
    appName: 'agents_sample_app',
    userId: 'sample_user',
  });

  for await (const event of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: {
      role: 'user',
      parts: [{text: 'Distributed agent architectures'}],
    },
  })) {
    if (isFinalResponse(event)) {
      process.stdout.write(`[${event.author}] ${stringifyContent(event)}\n`);
    }
  }

  process.stdout.write('\n=== 3. LLM Call Limit Enforcement ===\n');
  const twoCallLoop = new LoopAgent({
    name: 'two_call_loop',
    maxIterations: 3,
    subAgents: [
      new QualityCheckAgent({name: 'bounded_gate', requiredPasses: 3}),
    ],
  });
  const loopRunner = new InMemoryRunner({
    agent: twoCallLoop,
    appName: 'agents_sample_app',
  });
  const boundedSession = await loopRunner.sessionService.createSession({
    appName: 'agents_sample_app',
    userId: 'sample_user',
  });

  try {
    for await (const _event of loopRunner.runAsync({
      userId: boundedSession.userId,
      sessionId: boundedSession.id,
      newMessage: {role: 'user', parts: [{text: 'Test call limit'}]},
      runConfig: {maxLlmCalls: 1},
    })) {
      // First iteration succeeds; second iteration exceeds maxLlmCalls.
    }
  } catch (err: unknown) {
    if (isLlmCallsLimitExceededError(err)) {
      process.stdout.write(`Caught ${err.name}: ${err.message}\n`);
    } else {
      throw err;
    }
  }

  process.stdout.write('\n=== 4. Callback Credential Persistence ===\n');
  const credentialAuthConfig: AuthConfig = {
    credentialKey: 'sample-api-credential',
    authScheme: {
      type: 'apiKey',
      in: 'header',
      name: 'X-Sample-Key',
    },
    exchangedAuthCredential: {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'sample-placeholder-value',
    },
  };
  let loadedCredentialType: string | undefined;
  const credentialAgent = new LlmAgent({
    name: 'credentialDemoAgent',
    model: new DeterministicDemoLlm(),
    instruction: 'Demonstrate callback credential persistence.',
    beforeAgentCallback: async (ctx) => {
      await ctx.saveCredential(credentialAuthConfig);
      return undefined;
    },
    afterAgentCallback: async (ctx) => {
      const loaded = await ctx.loadCredential(credentialAuthConfig);
      loadedCredentialType = loaded?.authType;
      return undefined;
    },
  });
  const credentialRunner = new Runner({
    appName: 'agents-sample-app',
    agent: credentialAgent,
    sessionService: new InMemorySessionService(),
    artifactService: new InMemoryArtifactService(),
    credentialService: new InMemoryCredentialService(),
  });
  const credentialSession = await credentialRunner.sessionService.createSession(
    {
      appName: 'agents-sample-app',
      userId: 'sample-user',
    },
  );
  for await (const _event of credentialRunner.runAsync({
    userId: credentialSession.userId,
    sessionId: credentialSession.id,
    newMessage: {role: 'user', parts: [{text: 'Verify credential callbacks'}]},
  })) {
    // Run completes after beforeAgentCallback and afterAgentCallback execute.
  }
  process.stdout.write(
    `Loaded credential type from callback context: ${loadedCredentialType ?? 'none'}\n`,
  );

  process.stdout.write(
    '\n=== 5. Structured Output with Prefixed Toolset ===\n',
  );
  const cityGuideToolset = new CityGuideToolset();
  const prefixedTools = await cityGuideToolset.getToolsWithPrefix();
  process.stdout.write(
    `Prefixed tool names: ${prefixedTools.map((tool) => tool.name).join(', ')}\n`,
  );

  const structuredBriefAgent = new LlmAgent({
    name: 'structuredBriefAgent',
    model: new StructuredToolDemoLlm(),
    instruction: 'Look up a highlight and return a structured city brief.',
    tools: [cityGuideToolset],
    outputSchema: z.object({
      city: z.string(),
      highlight: z.string(),
    }),
    outputKey: 'cityBrief',
  });
  const structuredRunner = new InMemoryRunner({
    agent: structuredBriefAgent,
    appName: 'agents-sample-app',
  });
  const structuredSession = await structuredRunner.sessionService.createSession(
    {
      appName: 'agents-sample-app',
      userId: 'sample-user',
    },
  );
  for await (const event of structuredRunner.runAsync({
    userId: structuredSession.userId,
    sessionId: structuredSession.id,
    newMessage: {role: 'user', parts: [{text: 'Share a Lisbon brief'}]},
  })) {
    if (isFinalResponse(event)) {
      process.stdout.write(`[${event.author}] ${stringifyContent(event)}\n`);
    }
  }
  const updatedStructuredSession =
    await structuredRunner.sessionService.getSession({
      appName: 'agents-sample-app',
      userId: 'sample-user',
      sessionId: structuredSession.id,
    });
  process.stdout.write(
    `Saved structured cityBrief: ${JSON.stringify(updatedStructuredSession?.state['cityBrief'])}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exitCode = 1;
  });
}
