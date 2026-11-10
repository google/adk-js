/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  type BaseLlmConnection,
  type Event,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  type StreamingMode,
  type Workflow,
} from '@google/adk';
import {
  FinishReason,
  type GenerateContentResponseUsageMetadata,
  type GroundingMetadata,
  type Part,
} from '@google/genai';
import {context, metrics, trace} from '@opentelemetry/api';
import {logs} from '@opentelemetry/api-logs';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {expect} from 'vitest';
import {z} from 'zod';

import {buildTelemetryDigest, type TelemetryDigest} from './digests.js';

export const USER_PROMPT = 'hello';
export const SECOND_USER_PROMPT = 'and again';
export const AGENT_NAME = 'some_root_agent';
export const AGENT_DESCRIPTION = 'A sample root agent.';
export const BASE_INSTRUCTION = 'you are helpful';
export const FINAL_TEXT = 'text response';
export const MODEL_NAME = 'gemini-2.5-flash';

export const TOOL_NAME = 'some_tool';
export const TOOL_DESCRIPTION = 'A sample tool.';
export const TOOL_ARGS: Readonly<Record<string, unknown>> = {arg1: 'val1'};
export const TOOL_RESULT_PREFIX = 'processed ';
export const TOOL_RESULT = `${TOOL_RESULT_PREFIX}val1`;
export const TOOL_ERROR = new Error('This tool always fails');

export const WORKFLOW_NAME = 'my_workflow';
export const NESTED_WORKFLOW_NAME = 'my_nested_workflow';
export const NODE_RESULT = 'some result';
export const NODE_USER_ID = 'some_user';
export const NODE_APP_NAME = 'some_app';

export const FIRST_TURN_PROMPT_TOKEN_COUNT = 100;
export const FIRST_TURN_CACHED_TOKEN_COUNT = 40;
export const FIRST_TURN_CANDIDATES_TOKEN_COUNT = 20;
export const FIRST_TURN_THOUGHTS_TOKEN_COUNT = 5;
export const FIRST_TURN_TOTAL_TOKEN_COUNT = 125;

export const SECOND_TURN_PROMPT_TOKEN_COUNT = 150;
export const SECOND_TURN_CACHED_TOKEN_COUNT = 60;
export const SECOND_TURN_CANDIDATES_TOKEN_COUNT = 35;
export const SECOND_TURN_THOUGHTS_TOKEN_COUNT = 15;
export const SECOND_TURN_TOTAL_TOKEN_COUNT = 200;

export const NESTED_TURN_PROMPT_TOKEN_COUNT = 70;
export const NESTED_TURN_CACHED_TOKEN_COUNT = 30;
export const NESTED_TURN_CANDIDATES_TOKEN_COUNT = 10;
export const NESTED_TURN_THOUGHTS_TOKEN_COUNT = 3;
export const NESTED_TURN_TOTAL_TOKEN_COUNT = 83;

export const FIRST_TURN_USAGE: GenerateContentResponseUsageMetadata = {
  promptTokenCount: FIRST_TURN_PROMPT_TOKEN_COUNT,
  cachedContentTokenCount: FIRST_TURN_CACHED_TOKEN_COUNT,
  candidatesTokenCount: FIRST_TURN_CANDIDATES_TOKEN_COUNT,
  thoughtsTokenCount: FIRST_TURN_THOUGHTS_TOKEN_COUNT,
  totalTokenCount: FIRST_TURN_TOTAL_TOKEN_COUNT,
};

export const SECOND_TURN_USAGE: GenerateContentResponseUsageMetadata = {
  promptTokenCount: SECOND_TURN_PROMPT_TOKEN_COUNT,
  cachedContentTokenCount: SECOND_TURN_CACHED_TOKEN_COUNT,
  candidatesTokenCount: SECOND_TURN_CANDIDATES_TOKEN_COUNT,
  thoughtsTokenCount: SECOND_TURN_THOUGHTS_TOKEN_COUNT,
  totalTokenCount: SECOND_TURN_TOTAL_TOKEN_COUNT,
};

export const NESTED_TURN_USAGE: GenerateContentResponseUsageMetadata = {
  promptTokenCount: NESTED_TURN_PROMPT_TOKEN_COUNT,
  cachedContentTokenCount: NESTED_TURN_CACHED_TOKEN_COUNT,
  candidatesTokenCount: NESTED_TURN_CANDIDATES_TOKEN_COUNT,
  thoughtsTokenCount: NESTED_TURN_THOUGHTS_TOKEN_COUNT,
  totalTokenCount: NESTED_TURN_TOTAL_TOKEN_COUNT,
};

export const EXPERIMENTAL_OPT_IN = 'gen_ai_latest_experimental';

/**
 * Definition of one telemetry golden test case.
 */
export interface TelemetryTestCase {
  /** Case identifier matching `<testId>.json` in the scenario directory. */
  readonly testId: string;
  /** Value for `OTEL_SEMCONV_STABILITY_OPT_IN`, or `undefined` to unset. */
  readonly semconvOptIn?: string;
  /**
   * Value for `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, or
   * `undefined` to unset.
   */
  readonly captureContent?: string;
  /** Whether `ADK_EXPERIMENTAL_TELEMETRY` is enabled for the run. */
  readonly experimentalTelemetry?: boolean;
  /** Whether the scenario is expected to throw during execution. */
  readonly expectError?: boolean;
  /** Additional environment variables to set for the duration of the run. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Standard semantic-convention content-capture matrix shared by scenarios.
 */
export const SEMCONV_TEST_CASES: readonly TelemetryTestCase[] = [
  {
    testId: 'experimental-no-content',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'no_content',
  },
  {
    testId: 'experimental-span-only',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'span_only',
  },
  {
    testId: 'experimental-event-only',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'event_only',
  },
  {
    testId: 'experimental-span-and-event',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'span_and_event',
  },
];

/**
 * Standard experimental-telemetry on/off matrix shared by scenarios.
 */
export const EXPERIMENTAL_TELEMETRY_TEST_CASES: readonly TelemetryTestCase[] = [
  {
    testId: 'experimental-telemetry',
    captureContent: 'false',
    experimentalTelemetry: true,
  },
  {
    testId: 'no-experimental-telemetry',
    captureContent: 'false',
    experimentalTelemetry: false,
  },
];

/**
 * One scripted turn for {@link ScriptedModel}: either a single response, a
 * sequence of streaming chunks, or an error to throw.
 */
export type ScriptedTurn = LlmResponse | readonly LlmResponse[] | Error;

/**
 * Builds an {@link LlmResponse} containing a single model {@link Part}.
 */
export function makePartResponse(options: {
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

/**
 * Builds the canonical 2-turn tool-calling scripted conversation.
 */
export function buildToolCallingTurns(options?: {
  groundingMetadata?: GroundingMetadata;
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
      groundingMetadata: options?.groundingMetadata,
    }),
  ];
}

/**
 * Builds the canonical `some_tool` {@link FunctionTool}.
 */
export function buildSampleTool(toolException?: Error) {
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

/**
 * Builds the canonical `some_root_agent` {@link LlmAgent} with `some_tool`.
 */
export function buildTestAgent(
  model: BaseLlm,
  toolException?: Error,
): LlmAgent {
  return new LlmAgent({
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
    tools: [buildSampleTool(toolException)],
  });
}

/**
 * Runs an {@link LlmAgent} or {@link Workflow} to completion through
 * {@link InMemoryRunner}.
 */
export async function runWithInMemoryRunner(
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

class ScenarioMetricReader extends MetricReader {
  constructor() {
    super({
      aggregationTemporalitySelector: () => AggregationTemporality.DELTA,
    });
  }

  protected override async onForceFlush(): Promise<void> {}

  protected override async onShutdown(): Promise<void> {}
}

interface TelemetryHarness {
  readonly contextManager: AsyncLocalStorageContextManager;
  readonly tracerProvider: BasicTracerProvider;
  readonly spanExporter: InMemorySpanExporter;
  readonly loggerProvider: LoggerProvider;
  readonly logExporter: InMemoryLogRecordExporter;
  readonly meterProvider: MeterProvider;
  readonly metricReader: ScenarioMetricReader;
  shutdown(): Promise<void>;
}

/**
 * Installs a fresh set of in-memory OpenTelemetry providers for one test run.
 *
 * `core/src/telemetry/api/internal/` resolves the active tracer, logger, and
 * meter per call, so disabling and re-registering global providers isolates
 * each scenario without leaking exporters between tests.
 */
export function getOrCreateTelemetryHarness(): TelemetryHarness {
  trace.disable();
  logs.disable();
  metrics.disable();
  context.disable();

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  const logExporter = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({exporter: logExporter})],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  const metricReader = new ScenarioMetricReader();
  const meterProvider = new MeterProvider({
    readers: [metricReader],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  return {
    contextManager,
    tracerProvider,
    spanExporter,
    loggerProvider,
    logExporter,
    meterProvider,
    metricReader,
    async shutdown(): Promise<void> {
      await tracerProvider.shutdown();
      await loggerProvider.shutdown();
      await meterProvider.shutdown();
      trace.disable();
      logs.disable();
      metrics.disable();
      context.disable();
      contextManager.disable();
    },
  };
}

const MANAGED_ENV_KEYS = [
  'OTEL_SEMCONV_STABILITY_OPT_IN',
  'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
  'ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN',
  'ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS',
  'ADK_EXPERIMENTAL_TELEMETRY',
  'ADK_EXPERIMENTAL_TELEMETRY_FEATURES',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_ENTERPRISE',
  'ADK_CAPTURE_MCP_HTTP_BODIES',
  'ADK_CAPTURE_MCP_HTTP_EXCHANGE',
  'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_REQUEST',
  'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_RESPONSE',
] as const;

function setOrDeleteEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/**
 * Applies the telemetry environment variables for `tc` around `fn`, restoring
 * the original `process.env` entries in a `finally` block.
 */
export async function applyEnv<T>(
  tc: TelemetryTestCase,
  fn: () => Promise<T>,
): Promise<T> {
  const extraKeys = tc.env ? Object.keys(tc.env) : [];
  const allKeys = Array.from(new Set([...MANAGED_ENV_KEYS, ...extraKeys]));
  const previousValues = new Map<string, string | undefined>();
  for (const key of allKeys) {
    previousValues.set(key, process.env[key]);
  }

  try {
    setOrDeleteEnv('OTEL_SEMCONV_STABILITY_OPT_IN', tc.semconvOptIn);
    setOrDeleteEnv(
      'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
      tc.captureContent,
    );
    setOrDeleteEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '2');
    setOrDeleteEnv('ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS', 'false');
    setOrDeleteEnv(
      'ADK_EXPERIMENTAL_TELEMETRY',
      String(tc.experimentalTelemetry ?? false),
    );
    setOrDeleteEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', undefined);
    // The provider name follows the Gemini backend in use, so it is pinned.
    setOrDeleteEnv('GOOGLE_GENAI_USE_VERTEXAI', undefined);
    setOrDeleteEnv('GOOGLE_GENAI_USE_ENTERPRISE', undefined);
    if (tc.env) {
      for (const [key, value] of Object.entries(tc.env)) {
        setOrDeleteEnv(key, value);
      }
    }
    return await fn();
  } finally {
    for (const [key, value] of previousValues.entries()) {
      setOrDeleteEnv(key, value);
    }
  }
}

/**
 * Resets the in-memory telemetry exporters, runs `scenarioRunner` under `tc`'s
 * environment configuration, flushes all providers, and returns the resulting
 * {@link TelemetryDigest}.
 */
export async function recordScenario(
  tc: TelemetryTestCase,
  scenarioRunner: () => Promise<void>,
): Promise<TelemetryDigest> {
  const harness = getOrCreateTelemetryHarness();
  try {
    await harness.metricReader.collect();
    await applyEnv(tc, async () => {
      try {
        await scenarioRunner();
      } catch (error: unknown) {
        if (!tc.expectError) {
          throw error;
        }
      }
      await harness.tracerProvider.forceFlush();
      await harness.loggerProvider.forceFlush();
      await harness.meterProvider.forceFlush();
    });
    const {resourceMetrics} = await harness.metricReader.collect();

    return buildTelemetryDigest(
      harness.spanExporter.getFinishedSpans(),
      harness.logExporter.getFinishedLogRecords(),
      [resourceMetrics],
    );
  } finally {
    await harness.shutdown();
  }
}

/**
 * Records a scenario under `testCase`, updates the golden file when
 * `ADK_UPDATE_TELEMETRY_GOLDENS=1` is set, and asserts that the recorded
 * {@link TelemetryDigest} equals `<scenarioDir>/<testCase.testId>.json`.
 */
export async function assertTelemetryGolden(options: {
  scenarioDir: string;
  testCase: TelemetryTestCase;
  run: () => Promise<void>;
}): Promise<void> {
  const {scenarioDir, testCase, run} = options;
  const digest = await recordScenario(testCase, run);
  const goldenPath = path.join(scenarioDir, `${testCase.testId}.json`);

  if (process.env.ADK_UPDATE_TELEMETRY_GOLDENS === '1') {
    await fs.mkdir(path.dirname(goldenPath), {recursive: true});
    await fs.writeFile(
      goldenPath,
      `${JSON.stringify(digest, null, 2)}\n`,
      'utf8',
    );
  }

  const rawGolden = await fs.readFile(goldenPath, 'utf8');
  const expected = JSON.parse(rawGolden) as TelemetryDigest;
  expect(digest).toEqual(expected);
}

/**
 * Asserts that every `.json` file in `scenarioDir` corresponds to one of
 * `testCases`.
 */
export async function assertNoOrphanedGoldens(
  scenarioDir: string,
  testCases: readonly TelemetryTestCase[],
): Promise<void> {
  const entries = await fs.readdir(scenarioDir, {withFileTypes: true});
  const actualFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  const expectedFiles = testCases.map((tc) => `${tc.testId}.json`).sort();
  expect(actualFiles).toEqual(expectedFiles);
}
