/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Replays the functional telemetry scenarios and compares the span tree each
 * one produces with its recorded golden digest under
 * `fixtures/functional_goldens/<scenario>/<case>.json`.
 */

import {
  AgentTool,
  BaseLlm,
  BaseLlmConnection,
  FunctionNode,
  FunctionTool,
  Gemini,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  RunnableNode,
  Runner,
  StreamingMode,
  Workflow,
} from '@google/adk';
import {
  ApiError,
  FinishReason,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  Part,
} from '@google/genai';
import {context, trace} from '@opentelemetry/api';
import {logs} from '@opentelemetry/api-logs';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {z} from 'zod';

import {
  buildSpanDigest,
  type SpanDigest,
  StartOrderSpanProcessor,
} from './functional_digest.js';

const FIXTURES_DIR = join(
  import.meta.dirname,
  'fixtures',
  'functional_goldens',
);

const EXPERIMENTAL_OPT_IN = 'gen_ai_latest_experimental';

const USER_PROMPT = 'hello';
const MODEL_NAME = 'gemini-2.5-flash';
const BASE_INSTRUCTION = 'you are helpful';
const AGENT_NAME = 'some_root_agent';
const AGENT_DESCRIPTION = 'A sample root agent.';
const SPECIALIST_AGENT_NAME = 'some_specialist_agent';
const SPECIALIST_AGENT_DESCRIPTION = 'A sample specialist agent.';
const TOOL_NAME = 'some_tool';
const TOOL_DESCRIPTION = 'A sample tool.';
const TOOL_ARGS = {arg1: 'val1'};
const TOOL_RESULT_PREFIX = 'processed ';
const FINAL_TEXT = 'text response';
const STREAMED_TEXT_CHUNKS = ['text ', 'response'];
const WORKFLOW_NAME = 'my_workflow';
const NESTED_WORKFLOW_NAME = 'my_nested_workflow';
const NODE_NAME = 'some_node';
const NODE_RESULT = 'some result';
const NESTED_AGENT_NAME = 'some_nested_agent';
const NESTED_AGENT_DESCRIPTION = 'A sample agent inside a nested workflow.';
const AGENT_TOOL_WORKFLOW_NAME = 'my_agent_tool_workflow';
const DELEGATING_AGENT_NAME = 'some_delegating_agent';
const DELEGATING_AGENT_DESCRIPTION = 'A sample agent that delegates.';
const DELEGATE_AGENT_NAME = 'some_delegate_agent';
const DELEGATE_AGENT_DESCRIPTION = 'A sample delegate agent.';
const RUNNER_APP_NAME = 'InMemoryRunner';
const RUNNER_USER_ID = 'test_user';
const NODE_APP_NAME = 'some_app';
const NODE_USER_ID = 'some_user';

const FIRST_TURN_USAGE: GenerateContentResponseUsageMetadata = {
  promptTokenCount: 100,
  cachedContentTokenCount: 40,
  candidatesTokenCount: 20,
  thoughtsTokenCount: 5,
  totalTokenCount: 125,
};
const SECOND_TURN_USAGE: GenerateContentResponseUsageMetadata = {
  promptTokenCount: 150,
  cachedContentTokenCount: 60,
  candidatesTokenCount: 35,
  thoughtsTokenCount: 15,
  totalTokenCount: 200,
};
const NESTED_TURN_USAGE: GenerateContentResponseUsageMetadata = {
  promptTokenCount: 70,
  cachedContentTokenCount: 30,
  candidatesTokenCount: 10,
  thoughtsTokenCount: 3,
  totalTokenCount: 83,
};

/** One canned model answer: its single part and the usage it reports. */
interface Turn {
  part: Part;
  usage: GenerateContentResponseUsageMetadata;
}

const TOOL_CALLING_TURNS: readonly Turn[] = [
  {
    part: {functionCall: {name: TOOL_NAME, args: TOOL_ARGS}},
    usage: FIRST_TURN_USAGE,
  },
  {part: {text: FINAL_TEXT}, usage: SECOND_TURN_USAGE},
];

const MULTI_AGENT_TURNS: readonly Turn[] = [
  {
    part: {
      functionCall: {
        name: 'transfer_to_agent',
        args: {agent_name: SPECIALIST_AGENT_NAME},
      },
    },
    usage: FIRST_TURN_USAGE,
  },
  {part: {text: FINAL_TEXT}, usage: SECOND_TURN_USAGE},
];

const AGENT_TOOL_TURNS: readonly Turn[] = [
  {
    part: {
      functionCall: {name: DELEGATE_AGENT_NAME, args: {request: USER_PROMPT}},
    },
    usage: FIRST_TURN_USAGE,
  },
  {part: {text: NODE_RESULT}, usage: NESTED_TURN_USAGE},
  {part: {text: FINAL_TEXT}, usage: SECOND_TURN_USAGE},
];

const NESTED_WORKFLOW_TURNS: readonly Turn[] = [
  {part: {text: NODE_RESULT}, usage: NESTED_TURN_USAGE},
  ...TOOL_CALLING_TURNS,
];

/** The streamed conversation: one chunk for the tool call, two for the text. */
const STREAMING_TURNS: readonly (readonly Turn[])[] = [
  [TOOL_CALLING_TURNS[0]],
  STREAMED_TEXT_CHUNKS.map((text) => ({
    part: {text},
    usage: SECOND_TURN_USAGE,
  })),
];

type Scenario =
  | 'agent'
  | 'multi_agent'
  | 'agent_tool'
  | 'nested_agents_in_workflow'
  | 'node'
  | 'streaming';

type ModelErrorKind = 'resource_exhausted' | 'value_error';

/** One scenario, driven under one telemetry configuration. */
interface GoldenCase {
  readonly scenario: Scenario;
  readonly testId: string;
  readonly semconvOptIn?: string;
  readonly captureContent: string;
  readonly schemaVersion: 1 | 2;
  readonly experimentalTelemetry: boolean;
  readonly modelError?: ModelErrorKind;
}

interface SemconvConfig {
  name: string;
  semconvOptIn?: string;
  captureContent: string;
  schemaVersions: ReadonlyArray<1 | 2>;
}

const SEMCONV_CONFIGS: readonly SemconvConfig[] = [
  {name: 'stable-no-capture', captureContent: 'false', schemaVersions: [1]},
  {name: 'stable-capture', captureContent: 'true', schemaVersions: [1]},
  {
    name: 'experimental-no-content',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'no_content',
    schemaVersions: [1, 2],
  },
  {
    name: 'experimental-span-only',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'span_only',
    schemaVersions: [1, 2],
  },
  {
    name: 'experimental-event-only',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'event_only',
    schemaVersions: [1, 2],
  },
  {
    name: 'experimental-span-and-event',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'span_and_event',
    schemaVersions: [1, 2],
  },
];

function semconvMatrix(scenario: Scenario): GoldenCase[] {
  return SEMCONV_CONFIGS.flatMap((config) =>
    config.schemaVersions.map((schemaVersion) => ({
      scenario,
      testId: `${config.name}-schema-v${schemaVersion}`,
      semconvOptIn: config.semconvOptIn,
      captureContent: config.captureContent,
      schemaVersion,
      experimentalTelemetry: false,
    })),
  );
}

function experimentalAdkMatrix(
  scenario: Scenario,
  schemaVersions: ReadonlyArray<1 | 2> = [1, 2],
): GoldenCase[] {
  return [true, false].flatMap((experimentalTelemetry) =>
    schemaVersions.map((schemaVersion) => ({
      scenario,
      testId: `${experimentalTelemetry ? '' : 'no-'}experimental-telemetry-schema-v${schemaVersion}`,
      captureContent: 'false',
      schemaVersion,
      experimentalTelemetry,
    })),
  );
}

const CASES: readonly GoldenCase[] = [
  ...semconvMatrix('agent'),
  {
    scenario: 'agent',
    testId: 'experimental-telemetry-no-capture-schema-v1',
    captureContent: 'false',
    schemaVersion: 1,
    experimentalTelemetry: true,
  },
  {
    scenario: 'agent',
    testId: 'experimental-telemetry-no-capture-schema-v2',
    captureContent: 'false',
    schemaVersion: 2,
    experimentalTelemetry: true,
  },
  ...experimentalAdkMatrix('multi_agent'),
  {
    scenario: 'agent',
    testId: 'inference-error-resource-exhausted-schema-v1',
    captureContent: 'false',
    schemaVersion: 1,
    experimentalTelemetry: false,
    modelError: 'resource_exhausted',
  },
  {
    scenario: 'agent',
    testId: 'inference-error-resource-exhausted-schema-v2',
    captureContent: 'false',
    schemaVersion: 2,
    experimentalTelemetry: false,
    modelError: 'resource_exhausted',
  },
  {
    scenario: 'agent',
    testId: 'inference-error-valueerror-schema-v2',
    captureContent: 'false',
    schemaVersion: 2,
    experimentalTelemetry: false,
    modelError: 'value_error',
  },
  {
    scenario: 'agent',
    testId: 'inference-error-valueerror-span-and-event-schema-v2',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'span_and_event',
    schemaVersion: 2,
    experimentalTelemetry: false,
    modelError: 'value_error',
  },
  ...semconvMatrix('streaming'),
  ...semconvMatrix('node'),
  ...experimentalAdkMatrix('agent_tool'),
  ...experimentalAdkMatrix('nested_agents_in_workflow', [2]),
];

/** An error whose class name, `ValueError`, is the one the goldens record. */
class ValueError extends Error {
  override readonly name = 'ValueError';
}

function modelErrorFor(kind: ModelErrorKind): Error {
  switch (kind) {
    case 'resource_exhausted':
      return new ApiError({
        message: JSON.stringify({
          error: {code: 429, status: 'RESOURCE_EXHAUSTED'},
        }),
        status: 429,
      });
    case 'value_error':
      return new ValueError('boom');
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown model error: ${String(exhaustive)}`);
    }
  }
}

/** A model that answers with canned turns, or fails with a canned error. */
class CannedLlm extends BaseLlm {
  private readonly pending: Turn[];

  constructor(
    turns: readonly Turn[],
    private readonly error?: Error,
  ) {
    super({model: MODEL_NAME});
    this.pending = [...turns];
  }

  override async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    if (this.error) {
      throw this.error;
    }
    const turn = this.pending.shift();
    if (!turn) {
      throw new Error('CannedLlm ran out of turns.');
    }
    yield {
      content: {role: 'model', parts: [structuredClone(turn.part)]},
      finishReason: FinishReason.STOP,
      usageMetadata: turn.usage,
    };
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('CannedLlm does not support live connections.');
  }
}

function toResponse(
  turn: Turn,
  finishReason: FinishReason,
): GenerateContentResponse {
  return Object.assign(new GenerateContentResponse(), {
    candidates: [
      {
        content: {role: 'model', parts: [structuredClone(turn.part)]},
        finishReason,
      },
    ],
    usageMetadata: turn.usage,
  });
}

async function* streamTurn(
  turn: readonly Turn[],
): AsyncGenerator<GenerateContentResponse> {
  for (const [index, chunk] of turn.entries()) {
    yield toResponse(
      chunk,
      index === turn.length - 1
        ? FinishReason.STOP
        : FinishReason.FINISH_REASON_UNSPECIFIED,
    );
  }
}

/**
 * A real `Gemini` whose SDK streaming call returns the canned chunks, so the
 * responses go through the same aggregation a live stream does.
 */
function streamingGemini(turns: readonly (readonly Turn[])[]): Gemini {
  const gemini = new Gemini({model: MODEL_NAME, apiKey: 'fake-api-key'});
  const pending = [...turns];
  vi.spyOn(gemini.apiClient.models, 'generateContentStream').mockImplementation(
    async () => {
      const turn = pending.shift();
      if (!turn) {
        throw new Error('The streaming model ran out of turns.');
      }
      return streamTurn(turn);
    },
  );
  return gemini;
}

function turnsFor(scenario: Scenario): readonly Turn[] {
  switch (scenario) {
    case 'multi_agent':
      return MULTI_AGENT_TURNS;
    case 'agent_tool':
      return AGENT_TOOL_TURNS;
    case 'nested_agents_in_workflow':
      return NESTED_WORKFLOW_TURNS;
    default:
      return TOOL_CALLING_TURNS;
  }
}

function buildModel(goldenCase: GoldenCase): BaseLlm {
  if (goldenCase.scenario === 'streaming') {
    return streamingGemini(STREAMING_TURNS);
  }
  return new CannedLlm(
    turnsFor(goldenCase.scenario),
    goldenCase.modelError ? modelErrorFor(goldenCase.modelError) : undefined,
  );
}

function buildTestAgent(model: BaseLlm): LlmAgent {
  return new LlmAgent({
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
    tools: [
      new FunctionTool({
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        parameters: z.object({arg1: z.string()}),
        execute: ({arg1}) => `${TOOL_RESULT_PREFIX}${arg1}`,
      }),
    ],
  });
}

function buildMultiAgent(model: BaseLlm): LlmAgent {
  return new LlmAgent({
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
    subAgents: [
      new LlmAgent({
        name: SPECIALIST_AGENT_NAME,
        description: SPECIALIST_AGENT_DESCRIPTION,
        instruction: BASE_INSTRUCTION,
        model,
      }),
    ],
  });
}

function buildNodeWorkflow(model: BaseLlm): Workflow {
  const nested = new Workflow({
    name: NESTED_WORKFLOW_NAME,
    edges: [['START', new FunctionNode(NODE_NAME, () => NODE_RESULT)]],
  });
  return new Workflow({
    name: WORKFLOW_NAME,
    edges: [['START', nested, buildTestAgent(model)]],
  });
}

function buildNestedAgentsWorkflow(model: BaseLlm): Workflow {
  const nested = new Workflow({
    name: NESTED_WORKFLOW_NAME,
    edges: [
      [
        'START',
        new LlmAgent({
          name: NESTED_AGENT_NAME,
          description: NESTED_AGENT_DESCRIPTION,
          instruction: BASE_INSTRUCTION,
          model,
        }),
      ],
    ],
  });
  return new Workflow({
    name: WORKFLOW_NAME,
    edges: [['START', nested, buildTestAgent(model)]],
  });
}

function buildAgentToolWorkflow(model: BaseLlm): Workflow {
  const delegate = new LlmAgent({
    name: DELEGATE_AGENT_NAME,
    description: DELEGATE_AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
  });
  const delegating = new LlmAgent({
    name: DELEGATING_AGENT_NAME,
    description: DELEGATING_AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
    tools: [new AgentTool({agent: delegate})],
  });
  return new Workflow({
    name: AGENT_TOOL_WORKFLOW_NAME,
    edges: [['START', delegating]],
  });
}

interface RunParams {
  root: RunnableNode;
  appName: string;
  userId: string;
  streaming?: boolean;
}

async function runToCompletion({
  root,
  appName,
  userId,
  streaming = false,
}: RunParams): Promise<void> {
  const sessionService = new InMemorySessionService();
  const runner = new Runner({appName, agent: root, sessionService});
  const session = await sessionService.createSession({appName, userId});
  for await (const _event of runner.runAsync({
    userId,
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: USER_PROMPT}]},
    runConfig: streaming ? {streamingMode: StreamingMode.SSE} : undefined,
  })) {
    // Drain the run.
  }
}

async function runScenario(goldenCase: GoldenCase): Promise<void> {
  const model = buildModel(goldenCase);
  switch (goldenCase.scenario) {
    case 'agent':
      return runToCompletion({
        root: buildTestAgent(model),
        appName: RUNNER_APP_NAME,
        userId: RUNNER_USER_ID,
      });
    case 'multi_agent':
      return runToCompletion({
        root: buildMultiAgent(model),
        appName: RUNNER_APP_NAME,
        userId: RUNNER_USER_ID,
      });
    case 'streaming':
      return runToCompletion({
        root: buildTestAgent(model),
        appName: RUNNER_APP_NAME,
        userId: RUNNER_USER_ID,
        streaming: true,
      });
    case 'node':
      return runToCompletion({
        root: buildNodeWorkflow(model),
        appName: NODE_APP_NAME,
        userId: NODE_USER_ID,
      });
    case 'agent_tool':
      return runToCompletion({
        root: buildAgentToolWorkflow(model),
        appName: NODE_APP_NAME,
        userId: NODE_USER_ID,
      });
    case 'nested_agents_in_workflow':
      return runToCompletion({
        root: buildNestedAgentsWorkflow(model),
        appName: NODE_APP_NAME,
        userId: NODE_USER_ID,
      });
    default: {
      const exhaustive: never = goldenCase.scenario;
      throw new Error(`Unknown scenario: ${String(exhaustive)}`);
    }
  }
}

function applyCaseEnv(goldenCase: GoldenCase): void {
  vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', goldenCase.semconvOptIn);
  vi.stubEnv(
    'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
    goldenCase.captureContent,
  );
  vi.stubEnv(
    'ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN',
    String(goldenCase.schemaVersion),
  );
  vi.stubEnv('ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS', 'false');
  vi.stubEnv(
    'ADK_EXPERIMENTAL_TELEMETRY',
    String(goldenCase.experimentalTelemetry),
  );
  vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', undefined);
  vi.stubEnv('ADK_TELEMETRY_IGNORE_RUN_CONFIG', undefined);
  vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'false');
  vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'false');
}

function caseKey(goldenCase: GoldenCase): string {
  return `${goldenCase.scenario}/${goldenCase.testId}`;
}

function loadGolden(goldenCase: GoldenCase): SpanDigest {
  const golden = JSON.parse(
    readFileSync(
      join(FIXTURES_DIR, goldenCase.scenario, `${goldenCase.testId}.json`),
      'utf8',
    ),
  ) as {root_span: SpanDigest};
  return golden.root_span;
}

type PathKey = string | number;

/**
 * A value that differs from the golden for a reason outside telemetry: the
 * run's inputs are built differently, or the agent handles an error
 * differently. An entry only ever replaces a value; it never renames, adds or
 * removes a span or an attribute key.
 */
interface KnownDifference {
  /** The case keys (`<scenario>/<case>`) the entry applies to. */
  readonly cases: RegExp;
  /** The spans the value is on. */
  readonly span: RegExp;
  /** The event name of the log records the value is on, if on a log. */
  readonly log?: string;
  /** The path to the value within the span or log digest. */
  readonly at: readonly PathKey[];
  readonly golden: unknown;
  readonly adkJs: unknown;
  readonly reason: string;
}

const GOLDEN_AGENT_INSTRUCTION =
  'you are helpful\n\nYou are an agent. Your internal name is "some_root_agent". The description about you is "A sample root agent.".';
const ADK_JS_AGENT_INSTRUCTION =
  'You are an agent. Your internal name is "some_root_agent".\n\nThe description about you is "A sample root agent."\n\nyou are helpful';
const IDENTITY_REASON =
  'adk-js places its identity preamble first, splits it into two paragraphs and adds it inside a workflow too.';

const GOLDEN_TOOL_PARAMETERS = {
  properties: {arg1: {title: 'Arg1', type: 'string'}},
  required: ['arg1'],
  title: 'some_toolParams',
  type: 'object',
};
const ADK_JS_TOOL_PARAMETERS = {
  type: 'OBJECT',
  properties: {arg1: {type: 'STRING'}},
  required: ['arg1'],
};
const TOOL_PARAMETERS_REASON =
  'adk-js declares FunctionTool parameters as a genai Schema rather than a JSON schema with titles.';

const GOLDEN_TRANSFER_DESCRIPTION =
  "Transfer the query to another agent.\n\nUse this tool to hand off control to another agent that is more suitable to\nanswer the user's query according to the agent's description.\n\nArgs:\n  agent_name: the agent name to transfer to.";
const ADK_JS_TRANSFER_DESCRIPTION =
  'Transfer the question to another agent. This tool hands off control to another agent when it is more suitable to answer the user question according to the agent description.';
const TRANSFER_REASON =
  'adk-js implements transfer_to_agent as a FunctionTool with its own description.';

const MODEL_ERROR_REASON =
  'adk-js turns an unhandled model error into an error event, so the error does not escape the agent or the invocation.';

const COMPLETION_DETAILS = 'gen_ai.client.inference.operation.details';
const GENERATE_CONTENT = /^generate_content /;
const SYSTEM_INSTRUCTION_AT = [
  'attributes',
  'gen_ai.system_instructions',
  0,
  'content',
];
const TOOL_PARAMETERS_AT = [
  'attributes',
  'gen_ai.tool.definitions',
  0,
  'parameters',
];
const TOOL_DESCRIPTION_AT = [
  'attributes',
  'gen_ai.tool.definitions',
  0,
  'description',
];

const KNOWN_DIFFERENCES: readonly KnownDifference[] = [
  ...[undefined, COMPLETION_DETAILS].flatMap((log) => [
    {
      cases: /^(agent|streaming)\//,
      span: GENERATE_CONTENT,
      log,
      at: SYSTEM_INSTRUCTION_AT,
      golden: GOLDEN_AGENT_INSTRUCTION,
      adkJs: ADK_JS_AGENT_INSTRUCTION,
      reason: IDENTITY_REASON,
    },
    {
      cases: /^node\//,
      span: GENERATE_CONTENT,
      log,
      at: SYSTEM_INSTRUCTION_AT,
      golden: BASE_INSTRUCTION,
      adkJs: ADK_JS_AGENT_INSTRUCTION,
      reason: IDENTITY_REASON,
    },
    {
      cases: /^(agent|streaming|node)\//,
      span: GENERATE_CONTENT,
      log,
      at: TOOL_PARAMETERS_AT,
      golden: GOLDEN_TOOL_PARAMETERS,
      adkJs: ADK_JS_TOOL_PARAMETERS,
      reason: TOOL_PARAMETERS_REASON,
    },
    {
      cases: /^multi_agent\//,
      span: GENERATE_CONTENT,
      log,
      at: TOOL_DESCRIPTION_AT,
      golden: GOLDEN_TRANSFER_DESCRIPTION,
      adkJs: ADK_JS_TRANSFER_DESCRIPTION,
      reason: TRANSFER_REASON,
    },
  ]),
  {
    cases: /^(agent|streaming)\/stable-capture-/,
    span: GENERATE_CONTENT,
    log: 'gen_ai.system.message',
    at: ['body', 'content'],
    golden: GOLDEN_AGENT_INSTRUCTION,
    adkJs: ADK_JS_AGENT_INSTRUCTION,
    reason: IDENTITY_REASON,
  },
  {
    cases: /^node\/stable-capture-/,
    span: GENERATE_CONTENT,
    log: 'gen_ai.system.message',
    at: ['body', 'content'],
    golden: BASE_INSTRUCTION,
    adkJs: ADK_JS_AGENT_INSTRUCTION,
    reason: IDENTITY_REASON,
  },
  {
    cases: /^multi_agent\//,
    span: /^execute_tool transfer_to_agent$/,
    at: ['attributes', 'gen_ai.tool.description'],
    golden: GOLDEN_TRANSFER_DESCRIPTION,
    adkJs: ADK_JS_TRANSFER_DESCRIPTION,
    reason: TRANSFER_REASON,
  },
  {
    cases: /^multi_agent\//,
    span: /^execute_tool transfer_to_agent$/,
    at: ['attributes', 'gen_ai.tool.type'],
    golden: 'TransferToAgentTool',
    adkJs: 'FunctionTool',
    reason: TRANSFER_REASON,
  },
  {
    cases: /^agent\/inference-error-/,
    span: /^(invocation|invoke_workflow some_root_agent|invoke_agent some_root_agent)$/,
    at: ['status'],
    golden: 'ERROR',
    adkJs: 'UNSET',
    reason: MODEL_ERROR_REASON,
  },
];

function getAt(value: unknown, path: readonly PathKey[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = Reflect.get(current, key);
  }
  return current;
}

function setAt(value: unknown, path: readonly PathKey[], next: unknown): void {
  const parent = getAt(value, path.slice(0, -1));
  if (typeof parent !== 'object' || parent === null) {
    throw new Error(`No value at ${path.join('.')}.`);
  }
  Reflect.set(parent, path[path.length - 1], next);
}

/** Every span or log digest a known difference addresses in `root`. */
function targetsOf(
  root: SpanDigest,
  difference: KnownDifference,
): readonly object[] {
  const spans: SpanDigest[] = [];
  const visit = (span: SpanDigest): void => {
    if (difference.span.test(span.name)) {
      spans.push(span);
    }
    span.children.forEach(visit);
  };
  visit(root);
  const targets: object[] = difference.log
    ? spans.flatMap((span) =>
        span.logs.filter((log) => log.event_name === difference.log),
      )
    : spans;
  return targets.filter((target) => getAt(target, difference.at) !== undefined);
}

/**
 * Returns a copy of the golden with each known difference applied, after
 * asserting that the golden holds exactly the value the entry records.
 */
function withKnownDifferences(goldenCase: GoldenCase): SpanDigest {
  const golden = structuredClone(loadGolden(goldenCase));
  for (const difference of KNOWN_DIFFERENCES) {
    if (!difference.cases.test(caseKey(goldenCase))) {
      continue;
    }
    for (const target of targetsOf(golden, difference)) {
      expect(getAt(target, difference.at), difference.reason).toEqual(
        difference.golden,
      );
      setAt(target, difference.at, difference.adkJs);
    }
  }
  return golden;
}

const spanExporter = new InMemorySpanExporter();
const startOrder = new StartOrderSpanProcessor();
const logExporter = new InMemoryLogRecordExporter();
const contextManager = new AsyncLocalStorageContextManager();
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [startOrder, new SimpleSpanProcessor(spanExporter)],
});
const loggerProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({exporter: logExporter})],
});

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(tracerProvider);
  logs.setGlobalLoggerProvider(loggerProvider);
});

afterAll(async () => {
  await tracerProvider.shutdown();
  await loggerProvider.shutdown();
  logs.disable();
  trace.disable();
  context.disable();
  contextManager.disable();
});

beforeEach(() => {
  spanExporter.reset();
  logExporter.reset();
  startOrder.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('functional telemetry goldens', () => {
  it('has a fixture for every case and a case for every fixture', () => {
    const fixtures = readdirSync(FIXTURES_DIR, {withFileTypes: true})
      .filter((entry) => entry.isDirectory())
      .flatMap((dir) =>
        readdirSync(join(FIXTURES_DIR, dir.name)).map(
          (file) => `${dir.name}/${file.replace(/\.json$/, '')}`,
        ),
      )
      .sort();
    expect(CASES.map(caseKey).sort()).toEqual(fixtures);
  });

  it.each(KNOWN_DIFFERENCES.map((difference, index) => [index, difference]))(
    'applies known difference %i to at least one golden',
    (_index, difference) => {
      const targets = CASES.filter((goldenCase) =>
        difference.cases.test(caseKey(goldenCase)),
      ).flatMap((goldenCase) => targetsOf(loadGolden(goldenCase), difference));
      expect(targets.length).toBeGreaterThan(0);
    },
  );

  it.each(CASES.map((goldenCase) => [caseKey(goldenCase), goldenCase]))(
    '%s matches its golden span tree',
    async (_key, goldenCase) => {
      applyCaseEnv(goldenCase);

      await runScenario(goldenCase);

      const digest = buildSpanDigest({
        spans: spanExporter.getFinishedSpans(),
        logs: logExporter.getFinishedLogRecords(),
        startOrder,
      });
      expect(digest).toEqual(withKnownDifferences(goldenCase));
    },
  );
});
