/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import {buildTelemetryDigest, TelemetryDigest} from './digests.js';

/**
 * Scenario category exercised by the functional telemetry golden suite.
 */
export type ScenarioName =
  | 'agent'
  | 'agent_tool'
  | 'conversational_agent_compaction'
  | 'mcp'
  | 'multi_agent'
  | 'nested_agents_in_workflow'
  | 'node'
  | 'skill'
  | 'streaming';

/**
 * Compaction trigger configuration for compaction scenarios.
 */
export type CompactionSetup = 'token_threshold' | 'untriggered';

/**
 * Skill source category exercised by the skill scenario.
 */
export type SkillType = 'local' | 'registry' | 'nonexistent';

/**
 * Skill resource category exercised by the skill scenario.
 */
export type SkillResourceType =
  'references' | 'assets' | 'scripts' | 'wrong_type' | 'wrong_name';

/**
 * Definition of one functional telemetry golden test case.
 */
export interface FunctionalTestCase {
  /** Case identifier matching `<case>.json` under the scenario directory. */
  readonly testId: string;
  /** Scenario directory under `core/test/telemetry/goldens/`. */
  readonly scenario: ScenarioName;
  /** Value for `OTEL_SEMCONV_STABILITY_OPT_IN`, or `undefined` to unset. */
  readonly semconvOptIn?: string;
  /**
   * Value for `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, or
   * `undefined` to unset.
   */
  readonly captureContent?: string;
  /** Whether `ADK_ENABLE_EXPERIMENTAL_TELEMETRY` is enabled for the run. */
  readonly experimentalTelemetry?: boolean;
  /** Error for the scripted model to throw on its first call. */
  readonly modelException?: Error;
  /** Error for `some_tool` to throw when invoked. */
  readonly toolException?: Error;
  /** Whether the final model response includes grounding metadata. */
  readonly grounding?: boolean;
  /** Compaction trigger setup for compaction scenarios. */
  readonly compactionSetup?: CompactionSetup;
  /** Skills to load via `load_skill` in the skill scenario. */
  readonly loadedSkills?: readonly SkillType[];
  /** Skill resources to load via `load_skill_resource` in the skill scenario. */
  readonly loadedResources?: readonly SkillResourceType[];
  /** Exit codes to simulate via `run_skill_script` in the skill scenario. */
  readonly scriptReturnExitCodes?: readonly number[];
  /** Whether the MCP scenario routes tool calls over an HTTP transport. */
  readonly mcpOverHttp?: boolean;
  /** Whether the scenario is expected to throw during execution. */
  readonly expectError?: boolean;
  /** Additional environment variables to set for the duration of the run. */
  readonly env?: Readonly<Record<string, string>>;
}

interface TelemetryHarness {
  readonly contextManager: AsyncLocalStorageContextManager;
  readonly tracerProvider: BasicTracerProvider;
  readonly spanExporter: InMemorySpanExporter;
  readonly loggerProvider: LoggerProvider;
  readonly logExporter: InMemoryLogRecordExporter;
  readonly meterProvider: MeterProvider;
  readonly metricExporter: InMemoryMetricExporter;
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

  const metricExporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });
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
    metricExporter,
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
  'ADK_ENABLE_EXPERIMENTAL_TELEMETRY',
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
  tc: FunctionalTestCase,
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
      'ADK_ENABLE_EXPERIMENTAL_TELEMETRY',
      tc.experimentalTelemetry === false ? undefined : 'true',
    );
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
  tc: FunctionalTestCase,
  scenarioRunner: (tc: FunctionalTestCase) => Promise<void>,
): Promise<TelemetryDigest> {
  const harness = getOrCreateTelemetryHarness();
  try {
    await applyEnv(tc, async () => {
      try {
        await scenarioRunner(tc);
      } catch (error: unknown) {
        if (!tc.expectError && !tc.modelException && !tc.toolException) {
          throw error;
        }
      }
      await harness.tracerProvider.forceFlush();
      await harness.loggerProvider.forceFlush();
      await harness.meterProvider.forceFlush();
    });

    return buildTelemetryDigest(
      harness.spanExporter.getFinishedSpans(),
      harness.logExporter.getFinishedLogRecords(),
      harness.metricExporter.getMetrics(),
    );
  } finally {
    await harness.shutdown();
  }
}
