/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agents (`LlmAgent`, `SequentialAgent`, `ParallelAgent`, `LoopAgent`, `LangGraphAgent`, `RemoteAgent`, and `LlmCallsLimitExceededError`)
 * ../../docs/guides/agents/index.md
 *
 * Demonstrates the `agents` subsystem in `@google/adk` without requiring an API
 * key:
 * 1. `LlmAgent` with a dynamic `InstructionProvider` (`ReadonlyContext`),
 *    `outputKey`, `beforeAgentCallback`, and `afterAgentCallback`
 *    (`CallbackContext`).
 * 2. `ParallelAgent`, `LoopAgent`, and `SequentialAgent` orchestrating a custom
 *    `BaseAgent` subclass (`QualityCheckAgent`) that saves a session artifact
 *    via `ctx.artifactService.saveArtifact` and escalates on completion.
 * 3. `LangGraphAgent` wrapping an in-memory `CompiledGraphLike` state graph and
 *    `RemoteAgent` forwarding a session with null-stripped schema fields over
 *    HTTP POST.
 * 4. `RunConfig.maxLlmCalls` enforcement throwing `LlmCallsLimitExceededError`
 *    across a multi-iteration `LoopAgent`.
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
  BaseAgent,
  BaseAgentConfig,
  BaseLlm,
  BaseLlmConnection,
  CallbackContext,
  CompiledGraphLike,
  Event,
  InMemoryRunner,
  InvocationContext,
  LangGraphAIMessage,
  LangGraphAgent,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LoopAgent,
  ParallelAgent,
  ReadonlyContext,
  RemoteAgent,
  RemoteAgentFetch,
  SequentialAgent,
  createEvent,
  isFinalResponse,
  isLangGraphAgent,
  isLlmAgent,
  isLlmCallsLimitExceededError,
  isLoopAgent,
  isParallelAgent,
  isRemoteAgent,
  isSequentialAgent,
  stringifyContent,
} from '@google/adk';
import {fileURLToPath} from 'node:url';

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
 * In-memory `RemoteAgentFetch` implementation for `RemoteAgent` so the sample
 * runs deterministically without opening network sockets.
 */
const mockRemoteFetch: RemoteAgentFetch = async (_input, init) => {
  const rawBody = typeof init?.body === 'string' ? init.body : '{}';
  const body: {
    invocation_id?: string;
    session?: {id?: string; state?: Record<string, unknown>};
  } = JSON.parse(rawBody);
  const rawSummary = body.session?.state?.['topic_summary'];
  const summary = typeof rawSummary === 'string' ? rawSummary : 'no summary';
  const responseEvents = [
    {
      invocation_id: body.invocation_id ?? 'remote-inv',
      author: 'remote_backend_service',
      content: {
        role: 'model',
        parts: [
          {
            text: `[RemoteAgent] Archived session "${body.session?.id ?? ''}" with summary: ${summary}`,
          },
        ],
      },
    },
  ];

  return new Response(JSON.stringify(responseEvents), {
    status: 200,
    headers: {'Content-Type': 'application/json'},
  });
};

/**
 * Builds the multi-agent showcase pipeline using the provided model.
 */
function createShowcasePipeline(model: string | BaseLlm): SequentialAgent {
  const topicSummarizer = new LlmAgent({
    name: 'topic_summarizer',
    description: 'Summarizes the user topic into session state.',
    model,
    instruction: (ctx: ReadonlyContext) =>
      `Summarize the user request as agent "${ctx.agentName}" in session "${ctx.sessionId}".`,
    outputKey: 'topic_summary',
    beforeAgentCallback: (ctx: CallbackContext) => {
      ctx.state.set('summarizer_started', true);
      return undefined;
    },
    afterAgentCallback: async (ctx: CallbackContext) => {
      await ctx.saveArtifact('summary_audit.txt', {
        text: `Completed summary for invocation ${ctx.invocationId}`,
      });
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

  const remoteArchiver = new RemoteAgent({
    name: 'remote_archiver',
    description: 'Delegates final archiving to a remote agent endpoint.',
    url: 'https://agent-archiver.example.invalid/run',
    fetchImpl: mockRemoteFetch,
  });

  return new SequentialAgent({
    name: 'agents_showcase_pipeline',
    description:
      'Orchestrates parallel collection, loop verification, and remote archiving.',
    subAgents: [parallelCollectors, qualityReviewLoop, remoteArchiver],
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
  process.stdout.write(
    `isRemoteAgent(remote_archiver): ${isRemoteAgent(rootAgent.findAgent('remote_archiver'))}\n`,
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exitCode = 1;
  });
}
