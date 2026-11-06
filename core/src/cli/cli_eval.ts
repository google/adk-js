/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionCall, Part} from '@google/genai';
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
import {InputValidationError} from '../errors/input_validation_error.js';
import {NotFoundError} from '../errors/not_found_error.js';
import {Runner} from '../runner/runner.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {Session} from '../sessions/session.js';
import {logger} from '../utils/logger.js';
import {
  convertSessionToEvalFormat,
  createEmptyState,
  EvalCase,
  EvalIntermediateData,
  EvalInvocation,
  EvalSessionInput,
  EvalSet,
  EvaluationItem,
  IntermediateAgentResponseItem,
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
 * Complete evaluation result for a single eval case in an evalset.
 */
export interface EvalResult {
  /**
   * @deprecated Use {@link eval_set_id} instead.
   */
  eval_set_file?: string;
  eval_set_id: string;
  eval_id: string;
  final_eval_status: EvalStatus;
  /**
   * @deprecated Use {@link overall_eval_metric_results} instead.
   */
  eval_metric_results?: Array<[EvalMetric, EvalMetricResult]>;
  overall_eval_metric_results: EvalMetricResult[];
  eval_metric_result_per_invocation: InvocationEvalMetricResult[];
  session_id: string;
  session_details?: Session;
  user_id?: string;
}

/**
 * Case-level evaluation result alias matching the persisted eval set schema.
 */
export type EvalCaseResult = EvalResult;

/**
 * Eval-set-level evaluation result persisted by {@link LocalEvalSetResultsManager}.
 */
export interface EvalSetResult {
  evalSetResultId: string;
  evalSetResultName: string;
  evalSetId: string;
  evalCaseResults: EvalCaseResult[];
  /** Creation time in seconds since the Unix epoch, as used in result IDs. */
  creationTimestamp: number;
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
  /**
   * @deprecated Use {@link evalSetId} instead.
   */
  evalSetFile?: string;
  evalSetId: string;
  evalId: string;
  finalEvalStatus: EvalStatus;
  /**
   * @deprecated Use {@link overallEvalMetricResults} instead.
   */
  evalMetricResults?: Array<[EvalMetric, EvalMetricResult]>;
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
 * Options for running evaluations via `runEvals`.
 */
export interface RunEvalsOptions {
  evalCasesByEvalSetId: Record<string, EvalEntry[] | EvalCase[] | string[]>;
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
 * Returns the index of the colon that separates an evalset file path from its
 * eval case list, or -1 when there is none. Colons inside the path, such as a
 * Windows drive letter (`C:\evals\set.json`), are not separators.
 */
function findEvalListSeparator(inputEvalSet: string): number {
  const lastPathSeparator = Math.max(
    inputEvalSet.lastIndexOf('/'),
    inputEvalSet.lastIndexOf('\\'),
  );
  const colonIndex = inputEvalSet.indexOf(':', lastPathSeparator + 1);
  if (colonIndex === 1 && /^[A-Za-z]:/.test(inputEvalSet)) {
    // A drive-relative path such as `C:set.json` has no path separator.
    return inputEvalSet.indexOf(':', colonIndex + 1);
  }
  return colonIndex;
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
    const colonIndex = findEvalListSeparator(inputEvalSet);
    if (colonIndex !== -1) {
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
  userId: string;
  recordedSession?: Session;
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

  return {actualInvocations, sessionId, userId, recordedSession};
}

function isEvalCase(item: EvalEntry | EvalCase): item is EvalCase {
  return 'evalId' in item && 'conversation' in item;
}

function evalCaseToEvalEntry(evalCase: EvalCase): EvalEntry {
  const data: EvaluationItem[] = evalCase.conversation.map((invocation) => {
    const query =
      invocation.userContent?.parts?.map((part) => part.text ?? '').join('') ??
      '';
    const expectedToolUse: ToolUseItem[] = (
      invocation.intermediateData?.toolUses ?? []
    ).map((fc) => ({
      tool_name: fc.name ?? '',
      tool_input: (fc.args ?? {}) as Record<string, unknown>,
    }));
    const expectedIntermediateAgentResponses: IntermediateAgentResponseItem[] =
      invocation.intermediateData?.intermediateResponses ?? [];
    const reference =
      invocation.finalResponse?.parts
        ?.filter((part) => Boolean(part.text))
        .map((part) => part.text ?? '')
        .join('') ?? '';
    return {
      query,
      expected_tool_use: expectedToolUse,
      expected_intermediate_agent_responses: expectedIntermediateAgentResponses,
      reference,
    };
  });

  return {
    name: evalCase.evalId,
    data,
    ...(evalCase.sessionInput
      ? {
          initial_session: {
            app_name: evalCase.sessionInput.appName,
            user_id: evalCase.sessionInput.userId,
            state: evalCase.sessionInput.state,
          },
        }
      : {}),
  };
}

function readEvalEntriesFromFile(evalSetFilePath: string): EvalEntry[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(evalSetFilePath, 'utf-8'));
  if (Array.isArray(parsed)) {
    return (parsed as Array<EvalEntry | EvalCase>).map((item) =>
      isEvalCase(item) ? evalCaseToEvalEntry(item) : item,
    );
  }
  const evalSetId = path.basename(evalSetFilePath, EVAL_SET_FILE_EXTENSION);
  const evalSet = loadEvalSetFromFile(evalSetFilePath, evalSetId);
  return evalSet.evalCases.map(evalCaseToEvalEntry);
}

function resolveEvalCasesForSet(
  evalSetId: string,
  entries: EvalEntry[] | EvalCase[] | string[],
): EvalEntry[] {
  if (entries.length > 0 && typeof entries[0] === 'string') {
    const filterNames = entries as string[];
    const fileData = readEvalEntriesFromFile(evalSetId);
    return fileData.filter((e) => filterNames.includes(e.name));
  }
  if (
    entries.length === 0 &&
    fs.existsSync(evalSetId) &&
    fs.statSync(evalSetId).isFile()
  ) {
    return readEvalEntriesFromFile(evalSetId);
  }
  return (entries as Array<EvalEntry | EvalCase>).map((item) =>
    isEvalCase(item) ? evalCaseToEvalEntry(item) : item,
  );
}

function printCaseDetailedResults(result: EvalResult): void {
  logger.info(
    `Eval result for ${result.eval_set_id}:${result.eval_id}: ${EvalStatus[result.final_eval_status]}`,
  );
  for (const metricResult of result.overall_eval_metric_results) {
    logger.info(
      `  Metric ${metricResult.metric_name}: score=${metricResult.score ?? 'N/A'} threshold=${metricResult.threshold} status=${EvalStatus[metricResult.eval_status]}`,
    );
  }
}

/**
 * Runs a collection of evaluation cases against `rootAgent` and yields an
 * `EvalResult` for each case.
 */
export async function* runEvals(
  optionsOrMap:
    RunEvalsOptions | Record<string, EvalEntry[] | EvalCase[] | string[]>,
  rootAgentArg?: BaseAgent,
  resetFuncArg?: () => void | Promise<void>,
  evalMetricsArg?: EvalMetric[],
  printDetailedResultsArg = false,
  sessionServiceArg?: BaseSessionService,
  artifactServiceArg?: BaseArtifactService,
): AsyncGenerator<EvalResult, void, void> {
  let evalCasesByEvalSetId: Record<string, EvalEntry[] | EvalCase[] | string[]>;
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
    evalCasesByEvalSetId = optionsOrMap as Record<
      string,
      EvalEntry[] | EvalCase[] | string[]
    >;
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
      const {actualInvocations, sessionId, userId, recordedSession} =
        await generateActualInvocations(
          rootAgent,
          evalCase,
          resetFunc,
          sessionService,
          artifactService,
        );

      const overallEvalMetricResults: EvalMetricResult[] = [];
      const evalMetricResultsPairs: Array<[EvalMetric, EvalMetricResult]> = [];
      const perInvocationMap: InvocationEvalMetricResult[] = evalCase.data.map(
        (expectedInvocation, idx) => ({
          actual_invocation: actualInvocations[idx],
          expected_invocation: expectedInvocation,
          eval_metric_results: [],
        }),
      );

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

      const result: EvalResult = {
        eval_set_file: evalSetId,
        eval_set_id: evalSetId,
        eval_id: evalName,
        final_eval_status: finalEvalStatus,
        eval_metric_results: evalMetricResultsPairs,
        overall_eval_metric_results: overallEvalMetricResults,
        eval_metric_result_per_invocation: perInvocationMap,
        session_id: sessionId,
        session_details: recordedSession,
        user_id: userId,
      };

      if (printDetailedResults) {
        printCaseDetailedResults(result);
      }

      yield result;
    }
  }
}

const ADK_EVAL_HISTORY_DIR = '.adk/eval_history';
const EVAL_SET_RESULT_FILE_EXTENSION = '.evalset_result.json';
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

/**
 * Validates that a caller-supplied identifier is a safe single path segment and
 * cannot traverse directories.
 *
 * @param value The caller-supplied identifier.
 * @param fieldName Human-readable field name used in error messages.
 */
export function validatePathSegment(value: string, fieldName: string): void {
  if (!value) {
    throw new InputValidationError(`${fieldName} must not be empty.`);
  }
  if (value.includes('\x00')) {
    throw new InputValidationError(`${fieldName} must not contain null bytes.`);
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new InputValidationError(
      `${fieldName} '${value}' must not contain path separators.`,
    );
  }
  if (WINDOWS_DRIVE_RE.test(value)) {
    throw new InputValidationError(
      `${fieldName} '${value}' must not be drive-qualified.`,
    );
  }
  if (value === '.' || value === '..') {
    throw new InputValidationError(
      `${fieldName} '${value}' must not contain traversal segments.`,
    );
  }
}

function sanitizeEvalSetResultName(evalSetResultName: string): string {
  return evalSetResultName.replace(/\//g, '_');
}

/** Parameters for {@link createEvalSetResult}. */
export interface CreateEvalSetResultParams {
  appName: string;
  evalSetId: string;
  evalCaseResults: EvalCaseResult[];
  /**
   * Creation time in seconds since the Unix epoch. Seconds, not milliseconds,
   * keep result IDs and file names in the format the ADK web UI reads.
   * Defaults to the current time.
   */
  creationTimestamp?: number;
}

/**
 * Creates a new {@link EvalSetResult} for the given application, eval set ID,
 * and case results.
 */
export function createEvalSetResult({
  appName,
  evalSetId,
  evalCaseResults,
  creationTimestamp = (performance.timeOrigin + performance.now()) / 1000,
}: CreateEvalSetResultParams): EvalSetResult {
  const evalSetResultId = `${appName}_${evalSetId}_${creationTimestamp}`;
  const evalSetResultName = sanitizeEvalSetResultName(evalSetResultId);
  return {
    evalSetResultId,
    evalSetResultName,
    evalSetId,
    evalCaseResults,
    creationTimestamp,
  };
}

/**
 * Parses an {@link EvalSetResult} from JSON text. Accepts camelCase or
 * snake_case keys, and both plain JSON objects and legacy double-encoded JSON
 * strings.
 */
export function parseEvalSetResultJson(
  evalSetResultJson: string,
): EvalSetResult {
  const decoded: unknown = JSON.parse(evalSetResultJson);
  const target: unknown =
    typeof decoded === 'string' ? JSON.parse(decoded) : decoded;

  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    throw new Error('Invalid EvalSetResult JSON: expected an object.');
  }

  const record = target as Record<string, unknown>;
  const evalSetResultId =
    typeof record.evalSetResultId === 'string'
      ? record.evalSetResultId
      : typeof record.eval_set_result_id === 'string'
        ? record.eval_set_result_id
        : undefined;
  const evalSetId =
    typeof record.evalSetId === 'string'
      ? record.evalSetId
      : typeof record.eval_set_id === 'string'
        ? record.eval_set_id
        : undefined;

  if (!evalSetResultId || !evalSetId) {
    throw new Error(
      'Invalid EvalSetResult JSON: missing evalSetResultId or evalSetId.',
    );
  }

  const evalSetResultName =
    typeof record.evalSetResultName === 'string'
      ? record.evalSetResultName
      : typeof record.eval_set_result_name === 'string'
        ? record.eval_set_result_name
        : sanitizeEvalSetResultName(evalSetResultId);

  const rawCases = record.evalCaseResults ?? record.eval_case_results ?? [];
  if (!Array.isArray(rawCases)) {
    throw new Error(
      'Invalid EvalSetResult JSON: evalCaseResults must be an array.',
    );
  }
  const evalCaseResults = rawCases as EvalCaseResult[];

  const creationTimestamp =
    typeof record.creationTimestamp === 'number'
      ? record.creationTimestamp
      : typeof record.creation_timestamp === 'number'
        ? record.creation_timestamp
        : 0;

  return {
    evalSetResultId,
    evalSetResultName,
    evalSetId,
    evalCaseResults,
    creationTimestamp,
  };
}

/** Parameters for {@link LocalEvalSetResultsManager.saveEvalSetResult}. */
export interface SaveEvalSetResultParams {
  appName: string;
  evalSetId: string;
  evalCaseResults: EvalCaseResult[];
}

/**
 * Manages persistence of {@link EvalSetResult} objects on the local filesystem
 * under `<agentsDir>/<appName>/.adk/eval_history/`.
 */
export class LocalEvalSetResultsManager {
  constructor(private readonly agentsDir: string) {}

  /**
   * Creates and saves a new {@link EvalSetResult} for `evalCaseResults`.
   */
  saveEvalSetResult({
    appName,
    evalSetId,
    evalCaseResults,
  }: SaveEvalSetResultParams): EvalSetResult {
    validatePathSegment(appName, 'appName');
    validatePathSegment(evalSetId, 'evalSetId');
    const evalSetResult = createEvalSetResult({
      appName,
      evalSetId,
      evalCaseResults,
    });
    const appEvalHistoryDir = this.getEvalHistoryDir(appName);
    if (!fs.existsSync(appEvalHistoryDir)) {
      fs.mkdirSync(appEvalHistoryDir, {recursive: true});
    }
    const evalSetResultFilePath = path.join(
      appEvalHistoryDir,
      `${evalSetResult.evalSetResultName}${EVAL_SET_RESULT_FILE_EXTENSION}`,
    );
    logger.info(`Writing eval result to file: ${evalSetResultFilePath}`);
    fs.writeFileSync(
      evalSetResultFilePath,
      JSON.stringify(evalSetResult, null, 2),
      'utf-8',
    );
    return evalSetResult;
  }

  /**
   * Loads an {@link EvalSetResult} by `appName` and `evalSetResultId`.
   *
   * @throws {NotFoundError} If the result file does not exist.
   */
  getEvalSetResult(appName: string, evalSetResultId: string): EvalSetResult {
    const appEvalHistoryDir = this.getEvalHistoryDir(appName);
    validatePathSegment(evalSetResultId, 'evalSetResultId');
    const filePath = path.join(
      appEvalHistoryDir,
      `${evalSetResultId}${EVAL_SET_RESULT_FILE_EXTENSION}`,
    );
    if (!fs.existsSync(filePath)) {
      throw new NotFoundError(
        `Eval set result \`${evalSetResultId}\` not found.`,
      );
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return parseEvalSetResultJson(content);
  }

  /**
   * Lists all saved eval set result IDs for `appName`.
   */
  listEvalSetResults(appName: string): string[] {
    const appEvalHistoryDir = this.getEvalHistoryDir(appName);
    if (!fs.existsSync(appEvalHistoryDir)) {
      return [];
    }
    return fs
      .readdirSync(appEvalHistoryDir)
      .filter((file) => file.endsWith(EVAL_SET_RESULT_FILE_EXTENSION))
      .map((file) => file.slice(0, -EVAL_SET_RESULT_FILE_EXTENSION.length));
  }

  private getEvalHistoryDir(appName: string): string {
    validatePathSegment(appName, 'appName');
    return path.join(this.agentsDir, appName, ADK_EVAL_HISTORY_DIR);
  }
}

const EVAL_SET_FILE_EXTENSION = '.evalset.json';
const VALID_EVAL_ID_PATTERN = /^[a-zA-Z0-9_]+$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function convertInvocationToSchema(
  invocationInJsonFormat: unknown,
): EvalInvocation {
  if (
    !isPlainRecord(invocationInJsonFormat) ||
    typeof invocationInJsonFormat.query !== 'string'
  ) {
    throw new InputValidationError(
      'Invalid invocation in eval set: expected an object with a string query.',
    );
  }
  const query = invocationInJsonFormat.query;
  const rawReference = invocationInJsonFormat.reference;
  if (rawReference !== undefined && typeof rawReference !== 'string') {
    throw new InputValidationError(
      'Invalid invocation in eval set: reference must be a string.',
    );
  }
  const reference = rawReference ?? '';

  const rawToolUse =
    invocationInJsonFormat.expected_tool_use ??
    invocationInJsonFormat.expectedToolUse ??
    [];
  if (!Array.isArray(rawToolUse)) {
    throw new InputValidationError(
      'Invalid invocation in eval set: expected_tool_use must be an array.',
    );
  }
  const toolUses: FunctionCall[] = [];
  for (const oldToolUse of rawToolUse) {
    if (
      !isPlainRecord(oldToolUse) ||
      typeof oldToolUse.tool_name !== 'string' ||
      !isPlainRecord(oldToolUse.tool_input)
    ) {
      throw new InputValidationError(
        'Invalid tool use in eval set: expected string tool_name and object tool_input.',
      );
    }
    toolUses.push({
      name: oldToolUse.tool_name,
      args: oldToolUse.tool_input,
    });
  }

  const rawIntermediateResponses =
    invocationInJsonFormat.expected_intermediate_agent_responses ??
    invocationInJsonFormat.expectedIntermediateAgentResponses ??
    [];
  if (!Array.isArray(rawIntermediateResponses)) {
    throw new InputValidationError(
      'Invalid invocation in eval set: expected_intermediate_agent_responses must be an array.',
    );
  }
  const intermediateResponses: IntermediateAgentResponseItem[] = [];
  for (const oldResp of rawIntermediateResponses) {
    if (
      Array.isArray(oldResp) &&
      oldResp.length === 2 &&
      typeof oldResp[0] === 'string' &&
      Array.isArray(oldResp[1])
    ) {
      intermediateResponses.push([oldResp[0], oldResp[1] as Part[]]);
    } else if (
      isPlainRecord(oldResp) &&
      typeof oldResp.author === 'string' &&
      typeof oldResp.text === 'string'
    ) {
      intermediateResponses.push([oldResp.author, [{text: oldResp.text}]]);
    } else {
      throw new InputValidationError(
        'Invalid intermediate response in eval set: expected [author, Part[]] or {author, text}.',
      );
    }
  }

  return {
    invocationId: randomUUID(),
    userContent: {
      role: 'user',
      parts: [{text: query}],
    },
    finalResponse: {
      role: 'model',
      parts: [{text: reference}],
    },
    intermediateData: {
      toolUses,
      intermediateResponses,
    },
    creationTimestamp: (performance.timeOrigin + performance.now()) / 1000,
  };
}

/**
 * Converts a legacy array of {@link EvalEntry} records into a structured
 * {@link EvalSet} object.
 *
 * @param evalSetId Unique identifier for the eval set.
 * @param evalSetInJsonFormat Array of legacy evaluation case entries.
 * @returns The converted {@link EvalSet}.
 */
export function convertEvalSetToSchema(
  evalSetId: string,
  evalSetInJsonFormat: unknown,
): EvalSet {
  if (!Array.isArray(evalSetInJsonFormat)) {
    throw new InputValidationError(
      'Invalid eval set JSON format: expected an array of eval entries.',
    );
  }

  const evalCases: EvalCase[] = [];
  for (const oldEvalCase of evalSetInJsonFormat) {
    if (
      !isPlainRecord(oldEvalCase) ||
      typeof oldEvalCase.name !== 'string' ||
      !Array.isArray(oldEvalCase.data)
    ) {
      throw new InputValidationError(
        'Invalid eval case in eval set: expected string name and array data.',
      );
    }

    const newInvocations: EvalInvocation[] = [];
    for (const oldInvocation of oldEvalCase.data) {
      newInvocations.push(convertInvocationToSchema(oldInvocation));
    }

    let sessionInput: EvalSessionInput | undefined;
    const rawInitialSession =
      oldEvalCase.initial_session ?? oldEvalCase.initialSession;
    if (rawInitialSession !== undefined) {
      if (!isPlainRecord(rawInitialSession)) {
        throw new InputValidationError(
          'Invalid eval case in eval set: initial_session must be an object.',
        );
      }
      if (Object.keys(rawInitialSession).length > 0) {
        const rawAppName =
          rawInitialSession.app_name ?? rawInitialSession.appName ?? '';
        const rawUserId =
          rawInitialSession.user_id ?? rawInitialSession.userId ?? '';
        const rawState = rawInitialSession.state ?? {};
        if (
          typeof rawAppName !== 'string' ||
          typeof rawUserId !== 'string' ||
          !isPlainRecord(rawState)
        ) {
          throw new InputValidationError(
            'Invalid initial_session in eval set: expected string app_name, string user_id, and object state.',
          );
        }
        sessionInput = {
          appName: rawAppName,
          userId: rawUserId,
          state: rawState,
        };
      }
    }

    evalCases.push({
      evalId: oldEvalCase.name,
      conversation: newInvocations,
      ...(sessionInput ? {sessionInput} : {}),
      creationTimestamp: (performance.timeOrigin + performance.now()) / 1000,
    });
  }

  return {
    evalSetId,
    name: evalSetId,
    evalCases,
    creationTimestamp: (performance.timeOrigin + performance.now()) / 1000,
  };
}

function normalizeEvalIntermediateData(
  raw: unknown,
): EvalIntermediateData | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isPlainRecord(raw)) {
    throw new InputValidationError(
      'Invalid EvalIntermediateData: expected an object.',
    );
  }
  const rawToolUses = raw.toolUses ?? raw.tool_uses ?? [];
  const rawIntermediateResponses =
    raw.intermediateResponses ?? raw.intermediate_responses ?? [];
  if (!Array.isArray(rawToolUses) || !Array.isArray(rawIntermediateResponses)) {
    throw new InputValidationError(
      'Invalid EvalIntermediateData: toolUses and intermediateResponses must be arrays.',
    );
  }
  return {
    toolUses: rawToolUses as FunctionCall[],
    intermediateResponses:
      rawIntermediateResponses as IntermediateAgentResponseItem[],
  };
}

function normalizeEvalInvocation(raw: unknown): EvalInvocation {
  if (!isPlainRecord(raw)) {
    throw new InputValidationError(
      'Invalid EvalInvocation: expected an object.',
    );
  }
  const userContent = raw.userContent ?? raw.user_content;
  if (!isPlainRecord(userContent)) {
    throw new InputValidationError(
      'Invalid EvalInvocation: userContent is required.',
    );
  }
  const invocationId = raw.invocationId ?? raw.invocation_id;
  const finalResponse = raw.finalResponse ?? raw.final_response;
  const intermediateData = normalizeEvalIntermediateData(
    raw.intermediateData ?? raw.intermediate_data,
  );
  const creationTimestamp = raw.creationTimestamp ?? raw.creation_timestamp;

  return {
    ...(typeof invocationId === 'string' ? {invocationId} : {}),
    userContent: userContent as Content,
    ...(isPlainRecord(finalResponse)
      ? {finalResponse: finalResponse as Content}
      : {}),
    ...(intermediateData ? {intermediateData} : {}),
    ...(typeof creationTimestamp === 'number' ? {creationTimestamp} : {}),
  };
}

/**
 * Normalizes a raw parsed JSON object into an {@link EvalCase}, accepting both
 * camelCase and snake_case field names.
 */
export function normalizeEvalCase(raw: unknown): EvalCase {
  if (!isPlainRecord(raw)) {
    throw new InputValidationError('Invalid EvalCase: expected an object.');
  }
  const rawEvalId = raw.evalId ?? raw.eval_id;
  const evalId = typeof rawEvalId === 'string' ? rawEvalId : '';
  if (!Array.isArray(raw.conversation)) {
    throw new InputValidationError(
      'Invalid EvalCase: conversation must be an array.',
    );
  }
  const conversation = raw.conversation.map(normalizeEvalInvocation);
  const rawSessionInput = raw.sessionInput ?? raw.session_input;
  let sessionInput: EvalSessionInput | undefined;
  if (rawSessionInput !== undefined && rawSessionInput !== null) {
    if (!isPlainRecord(rawSessionInput)) {
      throw new InputValidationError(
        'Invalid EvalCase: sessionInput must be an object.',
      );
    }
    const appName = rawSessionInput.appName ?? rawSessionInput.app_name ?? '';
    const userId = rawSessionInput.userId ?? rawSessionInput.user_id ?? '';
    const state = rawSessionInput.state;
    if (typeof appName !== 'string' || typeof userId !== 'string') {
      throw new InputValidationError(
        'Invalid EvalSessionInput: appName and userId must be strings.',
      );
    }
    sessionInput = {
      appName,
      userId,
      ...(isPlainRecord(state) ? {state} : {}),
    };
  }
  const creationTimestamp = raw.creationTimestamp ?? raw.creation_timestamp;

  return {
    evalId,
    conversation,
    ...(sessionInput ? {sessionInput} : {}),
    ...(typeof creationTimestamp === 'number' ? {creationTimestamp} : {}),
  };
}

function tryParseStructuredEvalSet(raw: unknown): EvalSet | undefined {
  if (!isPlainRecord(raw)) {
    return undefined;
  }
  const evalSetId = raw.evalSetId ?? raw.eval_set_id;
  const rawEvalCases = raw.evalCases ?? raw.eval_cases;
  if (typeof evalSetId !== 'string' || !Array.isArray(rawEvalCases)) {
    return undefined;
  }
  const evalCases = rawEvalCases.map(normalizeEvalCase);
  const name = raw.name;
  const description = raw.description;
  const creationTimestamp = raw.creationTimestamp ?? raw.creation_timestamp;

  return {
    evalSetId,
    ...(typeof name === 'string' ? {name} : {}),
    ...(typeof description === 'string' ? {description} : {}),
    evalCases,
    ...(typeof creationTimestamp === 'number' ? {creationTimestamp} : {}),
  };
}

/**
 * Loads an {@link EvalSet} from a JSON file on disk, automatically converting
 * legacy {@link EvalEntry} arrays via {@link convertEvalSetToSchema}.
 *
 * @param evalSetFilePath Path to the `.evalset.json` file.
 * @param evalSetId Identifier of the eval set.
 * @returns The loaded {@link EvalSet}.
 */
export function loadEvalSetFromFile(
  evalSetFilePath: string,
  evalSetId: string,
): EvalSet {
  const content = fs.readFileSync(evalSetFilePath, 'utf-8');
  const parsed: unknown = JSON.parse(content);
  const structured = tryParseStructuredEvalSet(parsed);
  if (structured) {
    return structured;
  }
  return convertEvalSetToSchema(evalSetId, parsed);
}

/**
 * Manages persistence of {@link EvalSet} files (`<evalSetId>.evalset.json`)
 * on the local filesystem under `<agentsDir>/<appName>/`.
 */
export class LocalEvalSetsManager {
  constructor(private readonly agentsDir: string = process.cwd()) {}

  /**
   * Loads an {@link EvalSet} by `appName` and `evalSetId`, or returns
   * `undefined` when the file does not exist.
   */
  getEvalSet(appName: string, evalSetId: string): EvalSet | undefined {
    const evalSetFilePath = this.getEvalSetFilePath(appName, evalSetId);
    if (!fs.existsSync(evalSetFilePath)) {
      return undefined;
    }
    return loadEvalSetFromFile(evalSetFilePath, evalSetId);
  }

  /**
   * Creates and persists an empty {@link EvalSet} for `appName` and `evalSetId`.
   *
   * @throws {InputValidationError} If `evalSetId` has an invalid format or already exists.
   */
  createEvalSet(appName: string, evalSetId: string): EvalSet {
    validateId('Eval Set ID', evalSetId);
    const newEvalSetPath = this.getEvalSetFilePath(appName, evalSetId);
    logger.info(`Creating eval set file \`${newEvalSetPath}\``);

    if (!fs.existsSync(newEvalSetPath)) {
      logger.info("Eval set file doesn't exist, we will create a new one.");
      const newEvalSet: EvalSet = {
        evalSetId,
        name: evalSetId,
        evalCases: [],
        creationTimestamp: (performance.timeOrigin + performance.now()) / 1000,
      };
      writeEvalSet(newEvalSetPath, newEvalSet);
      return newEvalSet;
    }

    throw new InputValidationError(
      `EvalSet ${evalSetId} already exists for app ${appName}.`,
    );
  }

  /**
   * Lists all eval set IDs stored for `appName`, sorted alphabetically.
   */
  listEvalSets(appName: string): string[] {
    validatePathSegment(appName, 'appName');
    const evalSetFolderPath = path.join(this.agentsDir, appName);
    if (!fs.existsSync(evalSetFolderPath)) {
      return [];
    }
    const evalSets: string[] = [];
    for (const file of fs.readdirSync(evalSetFolderPath)) {
      if (file.endsWith(EVAL_SET_FILE_EXTENSION)) {
        evalSets.push(path.basename(file, EVAL_SET_FILE_EXTENSION));
      }
    }
    return evalSets.sort();
  }

  /**
   * Adds an {@link EvalCase} to an existing {@link EvalSet}.
   *
   * @throws {NotFoundError} If the eval set does not exist.
   * @throws {InputValidationError} If the eval case ID is invalid or already exists in the set.
   */
  addEvalCase(appName: string, evalSetId: string, evalCase: EvalCase): void {
    const evalCaseId = evalCase.evalId;
    validateId('Eval Case ID', evalCaseId);

    const evalSet = this.getEvalSet(appName, evalSetId);
    if (!evalSet) {
      throw new NotFoundError(`Eval set \`${evalSetId}\` not found.`);
    }

    if (evalSet.evalCases.some((x) => x.evalId === evalCaseId)) {
      throw new InputValidationError(
        `Eval id \`${evalCaseId}\` already exists in \`${evalSetId}\` eval set.`,
      );
    }

    evalSet.evalCases.push(evalCase);
    const evalSetFilePath = this.getEvalSetFilePath(appName, evalSetId);
    writeEvalSet(evalSetFilePath, evalSet);
  }

  /**
   * Returns a single {@link EvalCase} from `evalSetId`, or `undefined` if the
   * eval set or eval case does not exist.
   */
  getEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): EvalCase | undefined {
    const evalSet = this.getEvalSet(appName, evalSetId);
    if (!evalSet) {
      return undefined;
    }
    return evalSet.evalCases.find((x) => x.evalId === evalCaseId);
  }

  /**
   * Updates an existing {@link EvalCase} within `evalSetId`.
   *
   * @throws {NotFoundError} If the eval set or eval case does not exist.
   */
  updateEvalCase(
    appName: string,
    evalSetId: string,
    updatedEvalCase: EvalCase,
  ): void {
    const evalCaseId = updatedEvalCase.evalId;
    const evalSet = this.getEvalSet(appName, evalSetId);
    if (!evalSet) {
      throw new NotFoundError(
        `Eval Set \`${evalSetId}\` or Eval id \`${evalCaseId}\` not found.`,
      );
    }

    const index = evalSet.evalCases.findIndex((x) => x.evalId === evalCaseId);
    if (index === -1) {
      throw new NotFoundError(
        `Eval Set \`${evalSetId}\` or Eval id \`${evalCaseId}\` not found.`,
      );
    }

    evalSet.evalCases[index] = updatedEvalCase;
    const evalSetFilePath = this.getEvalSetFilePath(appName, evalSetId);
    writeEvalSet(evalSetFilePath, evalSet);
  }

  /**
   * Deletes an {@link EvalCase} identified by `evalCaseId` from `evalSetId`.
   *
   * @throws {NotFoundError} If the eval set or eval case does not exist.
   */
  deleteEvalCase(appName: string, evalSetId: string, evalCaseId: string): void {
    const evalSet = this.getEvalSet(appName, evalSetId);
    if (!evalSet) {
      throw new NotFoundError(
        `Eval Set \`${evalSetId}\` or Eval id \`${evalCaseId}\` not found.`,
      );
    }

    const index = evalSet.evalCases.findIndex((x) => x.evalId === evalCaseId);
    if (index === -1) {
      throw new NotFoundError(
        `Eval Set \`${evalSetId}\` or Eval id \`${evalCaseId}\` not found.`,
      );
    }

    logger.info(
      `EvalCase \`${evalCaseId}\` was found in the eval set. It will be removed permanently.`,
    );
    evalSet.evalCases.splice(index, 1);
    const evalSetFilePath = this.getEvalSetFilePath(appName, evalSetId);
    writeEvalSet(evalSetFilePath, evalSet);
  }

  private getEvalSetFilePath(appName: string, evalSetId: string): string {
    validatePathSegment(appName, 'appName');
    validatePathSegment(evalSetId, 'evalSetId');
    return path.join(
      this.agentsDir,
      appName,
      `${evalSetId}${EVAL_SET_FILE_EXTENSION}`,
    );
  }
}

function validateId(idName: string, idValue: string): void {
  if (!VALID_EVAL_ID_PATTERN.test(idValue)) {
    throw new InputValidationError(
      `Invalid ${idName}. ${idName} should have the \`${VALID_EVAL_ID_PATTERN}\` format`,
    );
  }
}

function writeEvalSet(evalSetPath: string, evalSet: EvalSet): void {
  fs.mkdirSync(path.dirname(evalSetPath), {recursive: true});
  fs.writeFileSync(evalSetPath, JSON.stringify(evalSet, null, 2), 'utf-8');
}
