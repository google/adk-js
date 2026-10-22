/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';

import {BaseAgent, isBaseAgent} from '../agents/base_agent.js';
import {
  BeforeToolCallback,
  isLlmAgent,
  LlmAgent,
  SingleBeforeToolCallback,
} from '../agents/llm_agent.js';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {InMemoryArtifactService} from '../artifacts/in_memory_artifact_service.js';
import {Runner} from '../runner/runner.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {Session} from '../sessions/session.js';
import {logger} from '../utils/logger.js';
import {
  convertSessionToEvalFormat,
  createEmptyState,
  EvalCase,
  EvalSet,
  EvaluationItem,
  Invocation,
  ToolUseItem,
} from './utils/evals.js';

/**
 * Error message when evaluation dependencies are missing.
 */
export const MISSING_EVAL_DEPENDENCIES_MESSAGE =
  'Eval module is not installed, please install via `pip install google-adk[eval]`.';

/**
 * Metric key for average tool trajectory score.
 */
export const TOOL_TRAJECTORY_SCORE_KEY = 'tool_trajectory_avg_score';

/**
 * Metric key for response match (ROUGE-1) score.
 */
export const RESPONSE_MATCH_SCORE_KEY = 'response_match_score';

/**
 * Metric key for LLM-based response evaluation score.
 */
export const RESPONSE_EVALUATION_SCORE_KEY = 'response_evaluation_score';

/**
 * Prefix applied to session IDs generated during evaluation runs.
 */
export const EVAL_SESSION_ID_PREFIX = '___eval___session___';

/**
 * Default evaluation criteria thresholds when no config file is supplied.
 */
export const DEFAULT_CRITERIA: Record<string, number> = {
  [TOOL_TRAJECTORY_SCORE_KEY]: 1.0,
  [RESPONSE_MATCH_SCORE_KEY]: 0.8,
};

/**
 * Outcome status of an evaluation metric or case.
 */
export enum EvalStatus {
  PASSED = 1,
  FAILED = 2,
  NOT_EVALUATED = 3,
}

/**
 * An evaluation metric definition and its pass threshold.
 */
export interface EvalMetric {
  metric_name: string;
  threshold: number;
}

/**
 * Result of evaluating a single metric.
 */
export interface EvalMetricResult extends EvalMetric {
  score?: number;
  eval_status: EvalStatus;
}

/**
 * Per-invocation evaluation metric breakdown.
 */
export interface InvocationEvalMetricResult {
  actual_invocation: EvaluationItem;
  expected_invocation: EvaluationItem;
  eval_metric_results: EvalMetricResult[];
}

/**
 * Per-invocation evaluation metric breakdown for a single turn.
 */
export interface EvalMetricResultPerInvocation {
  actual_invocation: EvaluationItem;
  expected_invocation: EvaluationItem;
  eval_metric_results: EvalMetricResult[];
}

/**
 * Complete evaluation result for a single eval case in an evalset.
 */
export interface EvalResult {
  eval_set_file: string;
  eval_set_id?: string;
  eval_id: string;
  final_eval_status: EvalStatus;
  eval_metric_results: Array<[EvalMetric, EvalMetricResult]>;
  overall_eval_metric_results: EvalMetricResult[];
  eval_metric_result_per_invocation: InvocationEvalMetricResult[];
  session_id: string;
  session_details?: Session;
  user_id?: string;
}

/**
 * Evaluation result for a single evaluation case within an evaluation set.
 */
export interface EvalCaseResult extends EvalResult {
  eval_set_id: string;
  session_details?: Session;
}

/**
 * Aggregated evaluation result for an evaluation set run.
 */
export interface EvalSetResult {
  eval_set_result_id: string;
  eval_set_result_name: string;
  eval_set_id: string;
  eval_case_results: EvalCaseResult[];
  creation_timestamp?: number;
}

/**
 * Request payload for adding a session to an eval set (`add_session`).
 */
export interface AddSessionToEvalSetRequest {
  evalId: string;
  sessionId: string;
  userId: string;
}

/**
 * Request payload for running evaluations on an eval set (`run_eval`).
 */
export interface RunEvalRequest {
  evalIds: string[];
  evalMetrics: EvalMetric[];
}

/**
 * Result returned for a single evaluation case by the `run_eval` endpoint.
 */
export interface RunEvalResult extends EvalResult {
  evalSetFile: string;
  evalSetId: string;
  evalId: string;
  finalEvalStatus: EvalStatus;
  evalMetricResults: Array<[EvalMetric, EvalMetricResult]>;
  overallEvalMetricResults: EvalMetricResult[];
  evalMetricResultPerInvocation: InvocationEvalMetricResult[];
  userId?: string;
  sessionId: string;
}

/**
 * Initial session metadata for an evaluation case.
 */
export interface EvalInitialSession {
  state?: Record<string, unknown>;
  app_name?: string;
  user_id?: string;
}

/**
 * A named evaluation case within an evalset file.
 */
export interface EvalEntry {
  name: string;
  data: EvaluationItem[];
  initial_session?: EvalInitialSession;
}

/**
 * Alias for a single evaluation case entry in an evalset.
 */
export type EvalSetItem = EvalEntry;

/**
 * Supported evaluation case collection formats for a single evaluation set in `runEvals`.
 */
export type EvalSetSource = Array<EvalEntry | EvalCase> | EvalSet | string[];

/**
 * Options for running evaluations via `runEvals`.
 */
export interface RunEvalsOptions {
  evalCasesByEvalSetId: Record<string, EvalSetSource>;
  rootAgent: BaseAgent;
  resetFunc?: () => void | Promise<void>;
  evalMetrics?: EvalMetric[];
  printDetailedResults?: boolean;
  sessionService?: BaseSessionService;
  artifactService?: BaseArtifactService;
}

/**
 * Loads evaluation criteria from a JSON config file, or returns `DEFAULT_CRITERIA`
 * if no path is supplied.
 *
 * @param evalConfigFilePath Optional path to a `test_config.json` file.
 * @returns Map of metric names to numeric thresholds.
 */
export function getEvaluationCriteriaOrDefault(
  evalConfigFilePath?: string,
): Record<string, number> {
  if (evalConfigFilePath) {
    const content = fs.readFileSync(evalConfigFilePath, 'utf-8');
    const configData: unknown = JSON.parse(content);
    if (
      typeof configData === 'object' &&
      configData !== null &&
      'criteria' in configData &&
      typeof (configData as {criteria: unknown}).criteria === 'object' &&
      (configData as {criteria: unknown}).criteria !== null &&
      !Array.isArray((configData as {criteria: unknown}).criteria)
    ) {
      return (configData as {criteria: Record<string, number>}).criteria;
    }
    throw new Error(
      `Invalid format for test_config.json at ${evalConfigFilePath}. Expected a 'criteria' dictionary.`,
    );
  }

  logger.info('No config file supplied. Using default criteria.');
  return {...DEFAULT_CRITERIA};
}

function resolveAgentModulePath(agentModuleFilePath: string): string {
  const resolved = path.resolve(agentModuleFilePath);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const candidates = ['agent.js', 'agent.ts', 'index.js', 'index.ts'];
    for (const candidate of candidates) {
      const candidatePath = path.join(resolved, candidate);
      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
        return candidatePath;
      }
    }
  }
  return resolved;
}

/**
 * Dynamically imports an agent module and returns its `rootAgent`.
 *
 * @param agentModuleFilePath File or directory path to the agent module.
 * @returns The loaded `BaseAgent` instance.
 */
export async function getRootAgent(
  agentModuleFilePath: string,
): Promise<BaseAgent> {
  const resolvedPath = resolveAgentModulePath(agentModuleFilePath);
  const moduleUrl = pathToFileURL(resolvedPath).href;
  const mod = (await import(moduleUrl)) as Record<string, unknown>;
  const nestedAgent =
    typeof mod.agent === 'object' && mod.agent !== null
      ? (mod.agent as Record<string, unknown>)
      : undefined;

  const candidate =
    mod.rootAgent ??
    mod.root_agent ??
    mod.default ??
    nestedAgent?.rootAgent ??
    nestedAgent?.root_agent;

  if (isBaseAgent(candidate)) {
    return candidate;
  }

  throw new Error(
    `No rootAgent found in module ${agentModuleFilePath}. Export a BaseAgent as 'rootAgent'.`,
  );
}

/**
 * Attempts to retrieve an optional `reset_data` or `resetData` function from
 * the agent module.
 *
 * @param agentModuleFilePath File or directory path to the agent module.
 * @returns The reset function if exported, or `undefined`.
 */
export async function tryGetResetFunc(
  agentModuleFilePath: string,
): Promise<(() => void | Promise<void>) | undefined> {
  try {
    const resolvedPath = resolveAgentModulePath(agentModuleFilePath);
    const moduleUrl = pathToFileURL(resolvedPath).href;
    const mod = (await import(moduleUrl)) as Record<string, unknown>;
    const nestedAgent =
      typeof mod.agent === 'object' && mod.agent !== null
        ? (mod.agent as Record<string, unknown>)
        : undefined;

    const resetCandidate =
      mod.reset_data ??
      mod.resetData ??
      nestedAgent?.reset_data ??
      nestedAgent?.resetData;

    if (typeof resetCandidate === 'function') {
      return resetCandidate as () => void | Promise<void>;
    }
  } catch {
    // Ignore errors when optional reset function is not present.
  }
  return undefined;
}

/**
 * Parses CLI evalset file arguments of the form `file_path` or
 * `file_path:eval_1,eval_2` into a mapping from file path to requested eval IDs.
 *
 * @param evalSetFilePaths Array of evalset file specifications.
 * @returns Mapping of evalset file path to list of eval case names.
 */
export function parseAndGetEvalsToRun(
  evalSetFilePaths: string[],
): Record<string, string[]> {
  const evalSetToEvals: Record<string, string[]> = {};
  for (const inputEvalSet of evalSetFilePaths) {
    let evalSetFile: string;
    let evals: string[] = [];
    if (inputEvalSet.includes(':')) {
      const colonIndex = inputEvalSet.indexOf(':');
      evalSetFile = inputEvalSet.slice(0, colonIndex);
      evals = inputEvalSet
        .slice(colonIndex + 1)
        .split(',')
        .filter((s) => s.length > 0);
    } else {
      evalSetFile = inputEvalSet;
    }

    if (!Object.prototype.hasOwnProperty.call(evalSetToEvals, evalSetFile)) {
      evalSetToEvals[evalSetFile] = [];
    }
    evalSetToEvals[evalSetFile].push(...evals);
  }

  return evalSetToEvals;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(b, key) ||
      !deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
}

function toolUsesEqual(
  actual: ToolUseItem[],
  expected: ToolUseItem[],
): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  for (let i = 0; i < actual.length; i++) {
    if (
      actual[i].tool_name !== expected[i].tool_name ||
      !deepEqual(actual[i].tool_input, expected[i].tool_input)
    ) {
      return false;
    }
  }
  return true;
}

function computeRouge1FMeasure(target: string, prediction: string): number {
  const targetTokens = target.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const predictionTokens = prediction.toLowerCase().match(/[a-z0-9]+/g) ?? [];

  if (targetTokens.length === 0 && predictionTokens.length === 0) {
    return 1.0;
  }
  if (targetTokens.length === 0 || predictionTokens.length === 0) {
    return 0.0;
  }

  const targetCounts = new Map<string, number>();
  for (const token of targetTokens) {
    targetCounts.set(token, (targetCounts.get(token) ?? 0) + 1);
  }

  let overlap = 0;
  for (const token of predictionTokens) {
    const remaining = targetCounts.get(token) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      targetCounts.set(token, remaining - 1);
    }
  }

  const precision = overlap / predictionTokens.length;
  const recall = overlap / targetTokens.length;
  if (precision + recall === 0) {
    return 0.0;
  }
  return (2 * precision * recall) / (precision + recall);
}

function evaluateSingleMetric(
  metric: EvalMetric,
  actualInvocations: EvaluationItem[],
  expectedInvocations: EvaluationItem[],
): {
  overall: EvalMetricResult;
  perInvocation: EvalMetricResult[];
} {
  const numInvocations = Math.min(
    actualInvocations.length,
    expectedInvocations.length,
  );

  if (numInvocations === 0) {
    return {
      overall: {
        metric_name: metric.metric_name,
        threshold: metric.threshold,
        score: undefined,
        eval_status: EvalStatus.NOT_EVALUATED,
      },
      perInvocation: [],
    };
  }

  const perInvocation: EvalMetricResult[] = [];
  let totalScore = 0;

  for (let i = 0; i < numInvocations; i++) {
    const actual = actualInvocations[i];
    const expected = expectedInvocations[i];
    let score = 0;

    if (metric.metric_name === TOOL_TRAJECTORY_SCORE_KEY) {
      score = toolUsesEqual(
        actual.expected_tool_use ?? [],
        expected.expected_tool_use ?? [],
      )
        ? 1.0
        : 0.0;
    } else if (
      metric.metric_name === RESPONSE_MATCH_SCORE_KEY ||
      metric.metric_name === RESPONSE_EVALUATION_SCORE_KEY
    ) {
      score = computeRouge1FMeasure(
        expected.reference ?? '',
        actual.reference ?? '',
      );
    }

    totalScore += score;
    perInvocation.push({
      metric_name: metric.metric_name,
      threshold: metric.threshold,
      score,
      eval_status:
        score >= metric.threshold ? EvalStatus.PASSED : EvalStatus.FAILED,
    });
  }

  const avgScore = totalScore / numInvocations;
  return {
    overall: {
      metric_name: metric.metric_name,
      threshold: metric.threshold,
      score: avgScore,
      eval_status:
        avgScore >= metric.threshold ? EvalStatus.PASSED : EvalStatus.FAILED,
    },
    perInvocation,
  };
}

function installMockToolOutputCallbacks(
  agent: BaseAgent,
  interceptor: SingleBeforeToolCallback,
  savedCallbacks: Map<LlmAgent, BeforeToolCallback | undefined>,
): void {
  if (isLlmAgent(agent) && !savedCallbacks.has(agent)) {
    savedCallbacks.set(agent, agent.beforeToolCallback);
    const existing = agent.beforeToolCallback;
    agent.beforeToolCallback = existing
      ? [interceptor, ...(Array.isArray(existing) ? existing : [existing])]
      : interceptor;
  }
  for (const subAgent of agent.subAgents) {
    installMockToolOutputCallbacks(subAgent, interceptor, savedCallbacks);
  }
}

async function generateActualInvocations(
  rootAgent: BaseAgent,
  evalCase: EvalEntry,
  resetFunc?: () => void | Promise<void>,
  sessionService?: BaseSessionService,
  artifactService?: BaseArtifactService,
): Promise<{
  actualInvocations: EvaluationItem[];
  sessionId: string;
  sessionDetails?: Session;
  userId: string;
}> {
  if (resetFunc) {
    await resetFunc();
  }

  const appName = evalCase.initial_session?.app_name ?? 'EvaluationGenerator';
  const userId = evalCase.initial_session?.user_id ?? 'test_user_id';
  const sessionId = `${EVAL_SESSION_ID_PREFIX}${randomUUID()}`;
  const activeSessionService = sessionService ?? new InMemorySessionService();
  const activeArtifactService =
    artifactService ?? new InMemoryArtifactService();

  const initialState = createEmptyState(
    rootAgent,
    evalCase.initial_session?.state ?? {},
  );

  await activeSessionService.createSession({
    appName,
    userId,
    sessionId,
    state: initialState,
  });

  const pendingMockToolUses: ToolUseItem[] = [];
  for (const turn of evalCase.data) {
    for (const expectedTool of turn.expected_tool_use ?? []) {
      if (expectedTool.mock_tool_output !== undefined) {
        pendingMockToolUses.push({...expectedTool});
      }
    }
  }

  const savedCallbacks = new Map<LlmAgent, BeforeToolCallback | undefined>();
  if (pendingMockToolUses.length > 0) {
    const interceptor: SingleBeforeToolCallback = ({tool, args}) => {
      const idx = pendingMockToolUses.findIndex(
        (expected) =>
          expected.mock_tool_output !== undefined &&
          tool.name === expected.tool_name &&
          deepEqual(args, expected.tool_input ?? {}),
      );
      if (idx !== -1) {
        const [matched] = pendingMockToolUses.splice(idx, 1);
        return {result: matched.mock_tool_output};
      }
      return undefined;
    };
    installMockToolOutputCallbacks(rootAgent, interceptor, savedCallbacks);
  }

  const runner = new Runner({
    appName,
    agent: rootAgent,
    sessionService: activeSessionService,
    artifactService: activeArtifactService,
  });

  try {
    for (const turn of evalCase.data) {
      for await (const _event of runner.runAsync({
        userId,
        sessionId,
        newMessage: {
          role: 'user',
          parts: [{text: turn.query}],
        },
      })) {
        // Consume all events produced for this turn.
      }
    }
  } finally {
    for (const [llmAgent, originalCallback] of savedCallbacks.entries()) {
      llmAgent.beforeToolCallback = originalCallback;
    }
  }

  const recordedSession = await activeSessionService.getSession({
    appName,
    userId,
    sessionId,
  });
  const actualInvocations = convertSessionToEvalFormat(recordedSession);

  // Pad if fewer invocations were recorded than expected turns.
  while (actualInvocations.length < evalCase.data.length) {
    const idx = actualInvocations.length;
    actualInvocations.push({
      query: evalCase.data[idx].query,
      expected_tool_use: [],
      expected_intermediate_agent_responses: [],
      reference: '',
    });
  }

  return {
    actualInvocations,
    sessionId,
    sessionDetails: recordedSession,
    userId,
  };
}

function invocationToEvaluationItem(invocation: Invocation): EvaluationItem {
  const query =
    invocation.user_content?.parts
      ?.filter((part) => Boolean(part.text))
      .map((part) => part.text ?? '')
      .join('') ?? '';
  const expectedToolUse: ToolUseItem[] = (
    invocation.intermediate_data?.tool_uses ?? []
  ).map((fc) => ({
    tool_name: fc.name ?? '',
    tool_input: (fc.args ?? {}) as Record<string, unknown>,
  }));
  const expectedIntermediateAgentResponses =
    invocation.intermediate_data?.intermediate_responses ?? [];
  const reference =
    invocation.final_response?.parts
      ?.filter((part) => Boolean(part.text))
      .map((part) => part.text ?? '')
      .join('') ?? '';

  return {
    query,
    expected_tool_use: expectedToolUse,
    expected_intermediate_agent_responses: expectedIntermediateAgentResponses,
    reference,
  };
}

function normalizeEvalCase(entry: EvalEntry | EvalCase): EvalEntry {
  if ('eval_id' in entry && 'conversation' in entry) {
    return {
      name: entry.eval_id,
      data: entry.conversation.map(invocationToEvaluationItem),
      initial_session: entry.session_input
        ? {
            app_name: entry.session_input.app_name,
            user_id: entry.session_input.user_id,
            state: entry.session_input.state,
          }
        : undefined,
    };
  }
  return entry;
}

function extractRawEvalCases(rawData: unknown): Array<EvalEntry | EvalCase> {
  if (Array.isArray(rawData)) {
    return rawData as Array<EvalEntry | EvalCase>;
  }
  if (
    typeof rawData === 'object' &&
    rawData !== null &&
    'eval_cases' in rawData &&
    Array.isArray((rawData as {eval_cases: unknown}).eval_cases)
  ) {
    return (rawData as EvalSet).eval_cases;
  }
  return [];
}

function resolveEvalCasesForSet(
  evalSetId: string,
  entries: EvalSetSource,
): EvalEntry[] {
  if (!Array.isArray(entries)) {
    return extractRawEvalCases(entries).map(normalizeEvalCase);
  }
  if (entries.length > 0 && typeof entries[0] === 'string') {
    const filterNames = entries as string[];
    const fileData: unknown = JSON.parse(fs.readFileSync(evalSetId, 'utf-8'));
    return extractRawEvalCases(fileData)
      .map(normalizeEvalCase)
      .filter((e) => filterNames.includes(e.name));
  }
  if (
    entries.length === 0 &&
    fs.existsSync(evalSetId) &&
    fs.statSync(evalSetId).isFile()
  ) {
    const fileData: unknown = JSON.parse(fs.readFileSync(evalSetId, 'utf-8'));
    return extractRawEvalCases(fileData).map(normalizeEvalCase);
  }
  return (entries as Array<EvalEntry | EvalCase>).map(normalizeEvalCase);
}

function printCaseDetailedResults(result: EvalResult): void {
  logger.info(
    `Eval result for ${result.eval_set_file}:${result.eval_id}: ${EvalStatus[result.final_eval_status]}`,
  );
  for (const metricResult of result.overall_eval_metric_results) {
    logger.info(
      `  Metric ${metricResult.metric_name}: score=${metricResult.score ?? 'N/A'} threshold=${metricResult.threshold} status=${EvalStatus[metricResult.eval_status]}`,
    );
  }
}

/**
 * Runs a collection of evaluation cases against `rootAgent` and yields an
 * `EvalCaseResult` for each case.
 */
export async function* runEvals(
  optionsOrMap: RunEvalsOptions | Record<string, EvalSetSource>,
  rootAgentArg?: BaseAgent,
  resetFuncArg?: () => void | Promise<void>,
  evalMetricsArg?: EvalMetric[],
  printDetailedResultsArg = false,
  sessionServiceArg?: BaseSessionService,
  artifactServiceArg?: BaseArtifactService,
): AsyncGenerator<EvalCaseResult, void, void> {
  let evalCasesByEvalSetId: Record<string, EvalSetSource>;
  let rootAgent: BaseAgent;
  let resetFunc: (() => void | Promise<void>) | undefined;
  let evalMetrics: EvalMetric[];
  let printDetailedResults: boolean;
  let sessionService: BaseSessionService | undefined;
  let artifactService: BaseArtifactService | undefined;

  if (
    rootAgentArg === undefined &&
    'evalCasesByEvalSetId' in optionsOrMap &&
    'rootAgent' in optionsOrMap &&
    isBaseAgent((optionsOrMap as RunEvalsOptions).rootAgent)
  ) {
    const opts = optionsOrMap as RunEvalsOptions;
    evalCasesByEvalSetId = opts.evalCasesByEvalSetId;
    rootAgent = opts.rootAgent;
    resetFunc = opts.resetFunc;
    evalMetrics =
      opts.evalMetrics ??
      Object.entries(DEFAULT_CRITERIA).map(([metric_name, threshold]) => ({
        metric_name,
        threshold,
      }));
    printDetailedResults = opts.printDetailedResults ?? false;
    sessionService = opts.sessionService;
    artifactService = opts.artifactService;
  } else {
    evalCasesByEvalSetId = optionsOrMap as Record<string, EvalSetSource>;
    if (!rootAgentArg) {
      throw new Error('rootAgent is required to run evaluations.');
    }
    rootAgent = rootAgentArg;
    resetFunc = resetFuncArg;
    evalMetrics =
      evalMetricsArg ??
      Object.entries(DEFAULT_CRITERIA).map(([metric_name, threshold]) => ({
        metric_name,
        threshold,
      }));
    printDetailedResults = printDetailedResultsArg;
    sessionService = sessionServiceArg;
    artifactService = artifactServiceArg;
  }

  for (const [evalSetId, rawEntries] of Object.entries(evalCasesByEvalSetId)) {
    const evalCases = resolveEvalCasesForSet(evalSetId, rawEntries);
    for (const evalCase of evalCases) {
      const evalName = evalCase.name;
      try {
        logger.info(`Running Eval: ${evalSetId}:${evalName}`);
        const {actualInvocations, sessionId, sessionDetails, userId} =
          await generateActualInvocations(
            rootAgent,
            evalCase,
            resetFunc,
            sessionService,
            artifactService,
          );

        const overallEvalMetricResults: EvalMetricResult[] = [];
        const evalMetricResultsPairs: Array<[EvalMetric, EvalMetricResult]> =
          [];
        const perInvocationMap: InvocationEvalMetricResult[] =
          evalCase.data.map((expectedInvocation, idx) => ({
            actual_invocation: actualInvocations[idx],
            expected_invocation: expectedInvocation,
            eval_metric_results: [],
          }));

        for (const metric of evalMetrics) {
          const {overall, perInvocation} = evaluateSingleMetric(
            metric,
            actualInvocations,
            evalCase.data,
          );
          overallEvalMetricResults.push(overall);
          evalMetricResultsPairs.push([metric, overall]);
          for (let i = 0; i < perInvocation.length; i++) {
            if (perInvocationMap[i]) {
              perInvocationMap[i].eval_metric_results.push(perInvocation[i]);
            }
          }
        }

        let finalEvalStatus = EvalStatus.NOT_EVALUATED;
        for (const overallMetricResult of overallEvalMetricResults) {
          if (overallMetricResult.eval_status === EvalStatus.PASSED) {
            if (finalEvalStatus === EvalStatus.NOT_EVALUATED) {
              finalEvalStatus = EvalStatus.PASSED;
            }
          } else if (overallMetricResult.eval_status === EvalStatus.FAILED) {
            finalEvalStatus = EvalStatus.FAILED;
            break;
          }
        }

        const result: EvalCaseResult = {
          eval_set_file: evalSetId,
          eval_set_id: evalSetId,
          eval_id: evalName,
          final_eval_status: finalEvalStatus,
          eval_metric_results: evalMetricResultsPairs,
          overall_eval_metric_results: overallEvalMetricResults,
          eval_metric_result_per_invocation: perInvocationMap,
          session_id: sessionId,
          session_details: sessionDetails,
          user_id: userId,
        };

        if (printDetailedResults) {
          printCaseDetailedResults(result);
        }

        yield result;
      } catch (e: unknown) {
        logger.error(`Eval failed for \`${evalSetId}:${evalName}\`: ${e}`);
      }
    }
  }
}
