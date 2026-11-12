/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionCall, FunctionResponse, Part} from '@google/genai';
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
import {publicSession} from '../events/internal_metadata.js';
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
  evalCaseResults: RunEvalResult[];
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
 * Result returned for a single evaluation case by the `run_eval` and
 * `eval_results` endpoints.
 */
export interface RunEvalResult {
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
  sessionDetails?: Session;
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
  evalCasesByEvalSetId: Record<string, Array<EvalEntry | EvalCase> | string[]>;
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
    // Skip the colon of a Windows drive prefix (`C:\` or `C:/`), so an
    // absolute Windows path is not split at the drive.
    const hasDrivePrefix = /^[A-Za-z]:[\\/]/.test(inputEvalSet);
    const colonIndex = inputEvalSet.indexOf(':', hasDrivePrefix ? 3 : 0);
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

/**
 * The key that wraps a mock tool output in the response a stubbed tool call
 * returns, and in the matching structured tool response.
 */
const MOCK_TOOL_OUTPUT_RESPONSE_KEY = 'result';

/**
 * Tool responses declared by structured eval cases, keyed by the tool use they
 * answer. A stubbed tool call returns the declared response unchanged.
 */
const declaredToolResponses = new WeakMap<
  ToolUseItem,
  Record<string, unknown>
>();

/**
 * Returns the response a stubbed tool call returns for `toolUse`, or
 * `undefined` when the tool use has no mock output.
 */
function getMockToolResponse(
  toolUse: ToolUseItem,
): Record<string, unknown> | undefined {
  const declared = declaredToolResponses.get(toolUse);
  if (declared !== undefined) {
    return declared;
  }
  if (toolUse.mock_tool_output !== undefined) {
    return {[MOCK_TOOL_OUTPUT_RESPONSE_KEY]: toolUse.mock_tool_output};
  }
  return undefined;
}

interface PendingMockToolUse {
  toolName: string;
  toolInput: Record<string, unknown>;
  response: Record<string, unknown>;
}

function isEvalEntry(evalCase: EvalCase | EvalEntry): evalCase is EvalEntry {
  return 'data' in evalCase && Array.isArray(evalCase.data);
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

  const pendingMockToolUses: PendingMockToolUse[] = [];
  for (const turn of evalCase.data) {
    for (const expectedTool of turn.expected_tool_use ?? []) {
      const response = getMockToolResponse(expectedTool);
      if (response !== undefined) {
        pendingMockToolUses.push({
          toolName: expectedTool.tool_name,
          toolInput: expectedTool.tool_input ?? {},
          response,
        });
      }
    }
  }

  const savedCallbacks = new Map<LlmAgent, BeforeToolCallback | undefined>();
  if (pendingMockToolUses.length > 0) {
    const interceptor: SingleBeforeToolCallback = ({tool, args}) => {
      const idx = pendingMockToolUses.findIndex(
        (expected) =>
          tool.name === expected.toolName &&
          deepEqual(args, expected.toolInput),
      );
      if (idx !== -1) {
        const [matched] = pendingMockToolUses.splice(idx, 1);
        return matched.response;
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

function evalCaseToEvalEntry(evalCase: EvalCase | EvalEntry): EvalEntry {
  if (isEvalEntry(evalCase)) {
    return evalCase;
  }
  const structured = evalCase;
  const data: EvaluationItem[] = structured.conversation.map((invocation) => {
    const query =
      invocation.userContent?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const reference =
      invocation.finalResponse?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const toolResponsesById = new Map<string, FunctionResponse>();
    for (const toolResponse of invocation.intermediateData?.toolResponses ??
      []) {
      if (toolResponse.id) {
        toolResponsesById.set(toolResponse.id, toolResponse);
      }
    }
    const expected_tool_use: ToolUseItem[] = (
      invocation.intermediateData?.toolUses ?? []
    ).map((fc) => {
      const toolUse: ToolUseItem = {
        tool_name: fc.name ?? '',
        tool_input: (fc.args ?? {}) as Record<string, unknown>,
      };
      const toolResponse = fc.id ? toolResponsesById.get(fc.id) : undefined;
      if (toolResponse?.response !== undefined) {
        declaredToolResponses.set(toolUse, toolResponse.response);
      }
      return toolUse;
    });
    const expected_intermediate_agent_responses: IntermediateAgentResponseItem[] =
      (invocation.intermediateData?.intermediateResponses ?? []).map(
        ([author, parts]) => [author, parts],
      );
    return {
      query,
      expected_tool_use,
      expected_intermediate_agent_responses,
      reference,
    };
  });

  // An empty app name or user ID means "not set", so leave it out and let the
  // eval runner use its defaults.
  const sessionInput = structured.sessionInput;
  return {
    name: structured.evalId,
    data,
    ...(sessionInput
      ? {
          initial_session: {
            ...(sessionInput.appName ? {app_name: sessionInput.appName} : {}),
            ...(sessionInput.userId ? {user_id: sessionInput.userId} : {}),
            state: sessionInput.state,
          },
        }
      : {}),
  };
}

function resolveEvalCasesForSet(
  evalSetId: string,
  entries: Array<EvalEntry | EvalCase> | string[],
): EvalEntry[] {
  if (entries.length > 0 && typeof entries[0] === 'string') {
    const filterNames = entries as string[];
    const rawFileData: unknown = JSON.parse(
      fs.readFileSync(evalSetId, 'utf-8'),
    );
    if (Array.isArray(rawFileData)) {
      return (rawFileData as EvalEntry[]).filter((e) =>
        filterNames.includes(e.name),
      );
    }
    const loadedSet = loadEvalSetFromFile(evalSetId, evalSetId);
    return loadedSet.evalCases
      .filter((e) => filterNames.includes(e.evalId))
      .map(evalCaseToEvalEntry);
  }
  if (
    entries.length === 0 &&
    fs.existsSync(evalSetId) &&
    fs.statSync(evalSetId).isFile()
  ) {
    const rawFileData: unknown = JSON.parse(
      fs.readFileSync(evalSetId, 'utf-8'),
    );
    if (Array.isArray(rawFileData)) {
      return rawFileData as EvalEntry[];
    }
    const loadedSet = loadEvalSetFromFile(evalSetId, evalSetId);
    return loadedSet.evalCases.map(evalCaseToEvalEntry);
  }
  return (entries as Array<EvalEntry | EvalCase>).map(evalCaseToEvalEntry);
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
    RunEvalsOptions | Record<string, Array<EvalEntry | EvalCase> | string[]>,
  rootAgentArg?: BaseAgent,
  resetFuncArg?: () => void | Promise<void>,
  evalMetricsArg?: EvalMetric[],
  printDetailedResultsArg = false,
  sessionServiceArg?: BaseSessionService,
  artifactServiceArg?: BaseArtifactService,
): AsyncGenerator<EvalResult, void, void> {
  let evalCasesByEvalSetId: Record<
    string,
    Array<EvalEntry | EvalCase> | string[]
  >;
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
      Array<EvalEntry | EvalCase> | string[]
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
        session_details: recordedSession && publicSession(recordedSession),
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

function toRunEvalResult(
  caseResult: EvalCaseResult | RunEvalResult | Record<string, unknown>,
  fallbackEvalSetId?: string,
): RunEvalResult {
  const record = caseResult as Record<string, unknown>;
  const evalSetFile =
    typeof record.evalSetFile === 'string'
      ? record.evalSetFile
      : typeof record.eval_set_file === 'string'
        ? record.eval_set_file
        : undefined;
  const evalSetId =
    typeof record.evalSetId === 'string'
      ? record.evalSetId
      : typeof record.eval_set_id === 'string'
        ? record.eval_set_id
        : (fallbackEvalSetId ?? '');
  const evalId =
    typeof record.evalId === 'string'
      ? record.evalId
      : typeof record.eval_id === 'string'
        ? record.eval_id
        : '';
  const finalEvalStatus =
    typeof record.finalEvalStatus === 'number'
      ? (record.finalEvalStatus as EvalStatus)
      : typeof record.final_eval_status === 'number'
        ? (record.final_eval_status as EvalStatus)
        : EvalStatus.NOT_EVALUATED;
  const evalMetricResults = Array.isArray(record.evalMetricResults)
    ? (record.evalMetricResults as Array<[EvalMetric, EvalMetricResult]>)
    : Array.isArray(record.eval_metric_results)
      ? (record.eval_metric_results as Array<[EvalMetric, EvalMetricResult]>)
      : undefined;
  const overallEvalMetricResults = Array.isArray(
    record.overallEvalMetricResults,
  )
    ? (record.overallEvalMetricResults as EvalMetricResult[])
    : Array.isArray(record.overall_eval_metric_results)
      ? (record.overall_eval_metric_results as EvalMetricResult[])
      : [];
  const evalMetricResultPerInvocation = Array.isArray(
    record.evalMetricResultPerInvocation,
  )
    ? (record.evalMetricResultPerInvocation as InvocationEvalMetricResult[])
    : Array.isArray(record.eval_metric_result_per_invocation)
      ? (record.eval_metric_result_per_invocation as InvocationEvalMetricResult[])
      : [];
  const sessionId =
    typeof record.sessionId === 'string'
      ? record.sessionId
      : typeof record.session_id === 'string'
        ? record.session_id
        : '';
  const rawSessionDetails =
    record.sessionDetails !== undefined && record.sessionDetails !== null
      ? (record.sessionDetails as Session)
      : record.session_details !== undefined && record.session_details !== null
        ? (record.session_details as Session)
        : undefined;
  const sessionDetails = rawSessionDetails && publicSession(rawSessionDetails);
  const userId =
    typeof record.userId === 'string'
      ? record.userId
      : typeof record.user_id === 'string'
        ? record.user_id
        : undefined;

  return {
    ...(evalSetFile !== undefined ? {evalSetFile} : {}),
    evalSetId,
    evalId,
    finalEvalStatus,
    ...(evalMetricResults !== undefined ? {evalMetricResults} : {}),
    overallEvalMetricResults,
    evalMetricResultPerInvocation,
    sessionId,
    ...(sessionDetails !== undefined ? {sessionDetails} : {}),
    ...(userId !== undefined ? {userId} : {}),
  };
}

/** Parameters for {@link createEvalSetResult}. */
export interface CreateEvalSetResultParams {
  appName: string;
  evalSetId: string;
  evalCaseResults: ReadonlyArray<EvalCaseResult | RunEvalResult>;
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
    evalCaseResults: evalCaseResults.map((caseResult) =>
      toRunEvalResult(caseResult, evalSetId),
    ),
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
  const evalCaseResults = rawCases.map((rawCase) => {
    if (
      typeof rawCase !== 'object' ||
      rawCase === null ||
      Array.isArray(rawCase)
    ) {
      throw new Error(
        'Invalid EvalSetResult JSON: each evalCaseResult must be an object.',
      );
    }
    return toRunEvalResult(rawCase as Record<string, unknown>, evalSetId);
  });

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
  evalCaseResults: ReadonlyArray<EvalCaseResult | RunEvalResult>;
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

function validateEvalId(idName: string, idValue: string): void {
  if (!VALID_EVAL_ID_PATTERN.test(idValue)) {
    throw new InputValidationError(
      `Invalid ${idName}. ${idName} should have the \`${VALID_EVAL_ID_PATTERN.source}\` format`,
    );
  }
}

/**
 * Reads `creationTimestamp` (or `creation_timestamp`) from a parsed JSON
 * record, or returns `undefined` when neither key holds a number.
 */
function readCreationTimestamp(
  record: Record<string, unknown>,
): number | undefined {
  if (typeof record.creationTimestamp === 'number') {
    return record.creationTimestamp;
  }
  if (typeof record.creation_timestamp === 'number') {
    return record.creation_timestamp;
  }
  return undefined;
}

function normalizeContent(raw: unknown, defaultRole?: string): Content {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InputValidationError('Invalid Content: expected an object.');
  }
  const record = raw as Record<string, unknown>;
  if (record.parts !== undefined && !Array.isArray(record.parts)) {
    throw new InputValidationError(
      'Invalid Content: parts must be an array when provided.',
    );
  }
  const parts = Array.isArray(record.parts) ? (record.parts as Part[]) : [];
  const role =
    typeof record.role === 'string'
      ? record.role
      : defaultRole !== undefined
        ? defaultRole
        : undefined;
  return {
    parts,
    ...(role !== undefined ? {role} : {}),
  };
}

function normalizeIntermediateData(raw: unknown): EvalIntermediateData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InputValidationError(
      'Invalid EvalIntermediateData: expected an object.',
    );
  }
  const record = raw as Record<string, unknown>;
  const rawToolUses = record.toolUses ?? record.tool_uses ?? [];
  if (!Array.isArray(rawToolUses)) {
    throw new InputValidationError(
      'Invalid EvalIntermediateData: toolUses must be an array.',
    );
  }
  const toolUses: FunctionCall[] = rawToolUses.map((tu) => {
    if (typeof tu !== 'object' || tu === null || Array.isArray(tu)) {
      throw new InputValidationError(
        'Invalid FunctionCall in toolUses: expected an object.',
      );
    }
    const fc = tu as Record<string, unknown>;
    if (fc.name !== undefined && typeof fc.name !== 'string') {
      throw new InputValidationError(
        'Invalid FunctionCall: name must be a string.',
      );
    }
    if (
      fc.args !== undefined &&
      (typeof fc.args !== 'object' ||
        fc.args === null ||
        Array.isArray(fc.args))
    ) {
      throw new InputValidationError(
        'Invalid FunctionCall: args must be an object.',
      );
    }
    return {
      ...(typeof fc.id === 'string' ? {id: fc.id} : {}),
      ...(typeof fc.name === 'string' ? {name: fc.name} : {}),
      ...(fc.args !== undefined
        ? {args: fc.args as Record<string, unknown>}
        : {}),
    };
  });

  const rawToolResponses = record.toolResponses ?? record.tool_responses ?? [];
  if (!Array.isArray(rawToolResponses)) {
    throw new InputValidationError(
      'Invalid EvalIntermediateData: toolResponses must be an array.',
    );
  }
  const toolResponses: FunctionResponse[] = rawToolResponses.map((tr) => {
    if (typeof tr !== 'object' || tr === null || Array.isArray(tr)) {
      throw new InputValidationError(
        'Invalid FunctionResponse in toolResponses: expected an object.',
      );
    }
    const fr = tr as Record<string, unknown>;
    if (fr.id !== undefined && typeof fr.id !== 'string') {
      throw new InputValidationError(
        'Invalid FunctionResponse: id must be a string.',
      );
    }
    if (fr.name !== undefined && typeof fr.name !== 'string') {
      throw new InputValidationError(
        'Invalid FunctionResponse: name must be a string.',
      );
    }
    if (
      fr.response !== undefined &&
      (typeof fr.response !== 'object' ||
        fr.response === null ||
        Array.isArray(fr.response))
    ) {
      throw new InputValidationError(
        'Invalid FunctionResponse: response must be an object.',
      );
    }
    return {
      ...(typeof fr.id === 'string' ? {id: fr.id} : {}),
      ...(typeof fr.name === 'string' ? {name: fr.name} : {}),
      ...(fr.response !== undefined
        ? {response: fr.response as Record<string, unknown>}
        : {}),
    };
  });

  const rawIntermediate =
    record.intermediateResponses ?? record.intermediate_responses ?? [];
  if (!Array.isArray(rawIntermediate)) {
    throw new InputValidationError(
      'Invalid EvalIntermediateData: intermediateResponses must be an array.',
    );
  }
  const intermediateResponses: IntermediateAgentResponseItem[] =
    rawIntermediate.map((entry) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        !Array.isArray(entry[1])
      ) {
        throw new InputValidationError(
          'Invalid intermediateResponses entry: expected [author, Part[]].',
        );
      }
      return [entry[0], entry[1] as Part[]];
    });

  return {
    toolUses,
    ...(toolResponses.length > 0 ? {toolResponses} : {}),
    intermediateResponses,
  };
}

function normalizeInvocation(raw: unknown): EvalInvocation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InputValidationError(
      'Invalid EvalInvocation: expected an object.',
    );
  }
  const record = raw as Record<string, unknown>;
  const rawUserContent = record.userContent ?? record.user_content;
  if (rawUserContent === undefined) {
    throw new InputValidationError(
      'Invalid EvalInvocation: userContent is required.',
    );
  }
  const userContent = normalizeContent(rawUserContent);

  const rawFinalResponse = record.finalResponse ?? record.final_response;
  const finalResponse =
    rawFinalResponse !== undefined && rawFinalResponse !== null
      ? normalizeContent(rawFinalResponse)
      : undefined;

  const rawIntermediateData =
    record.intermediateData ?? record.intermediate_data;
  const intermediateData =
    rawIntermediateData !== undefined && rawIntermediateData !== null
      ? normalizeIntermediateData(rawIntermediateData)
      : undefined;

  const invocationId =
    typeof record.invocationId === 'string'
      ? record.invocationId
      : typeof record.invocation_id === 'string'
        ? record.invocation_id
        : undefined;

  const creationTimestamp = readCreationTimestamp(record);

  return {
    ...(invocationId !== undefined ? {invocationId} : {}),
    userContent,
    ...(finalResponse !== undefined ? {finalResponse} : {}),
    ...(intermediateData !== undefined ? {intermediateData} : {}),
    ...(creationTimestamp !== undefined ? {creationTimestamp} : {}),
  };
}

function normalizeSessionInput(raw: unknown): EvalSessionInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InputValidationError(
      'Invalid EvalSessionInput: expected an object.',
    );
  }
  const record = raw as Record<string, unknown>;
  const rawAppName = record.appName ?? record.app_name ?? '';
  const rawUserId = record.userId ?? record.user_id ?? '';
  const rawState = record.state ?? {};
  if (typeof rawAppName !== 'string') {
    throw new InputValidationError(
      'Invalid EvalSessionInput: appName must be a string.',
    );
  }
  if (typeof rawUserId !== 'string') {
    throw new InputValidationError(
      'Invalid EvalSessionInput: userId must be a string.',
    );
  }
  if (
    typeof rawState !== 'object' ||
    rawState === null ||
    Array.isArray(rawState)
  ) {
    throw new InputValidationError(
      'Invalid EvalSessionInput: state must be an object.',
    );
  }
  return {
    appName: rawAppName,
    userId: rawUserId,
    state: rawState as Record<string, unknown>,
  };
}

/**
 * Normalizes an arbitrary parsed JSON object into an {@link EvalCase},
 * accepting both camelCase and snake_case keys.
 *
 * @throws {InputValidationError} If required fields are missing or invalid.
 */
export function normalizeEvalCase(raw: unknown): EvalCase {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InputValidationError('Invalid EvalCase: expected an object.');
  }
  const record = raw as Record<string, unknown>;
  const rawEvalId = record.evalId ?? record.eval_id;
  if (typeof rawEvalId !== 'string') {
    throw new InputValidationError(
      'Invalid EvalCase: evalId must be a string.',
    );
  }
  if (!Array.isArray(record.conversation)) {
    throw new InputValidationError(
      'Invalid EvalCase: conversation must be an array.',
    );
  }
  const conversation = record.conversation.map(normalizeInvocation);

  const rawSessionInput = record.sessionInput ?? record.session_input;
  const sessionInput =
    rawSessionInput !== undefined && rawSessionInput !== null
      ? normalizeSessionInput(rawSessionInput)
      : undefined;

  const creationTimestamp = readCreationTimestamp(record);

  return {
    evalId: rawEvalId,
    conversation,
    ...(sessionInput !== undefined ? {sessionInput} : {}),
    ...(creationTimestamp !== undefined ? {creationTimestamp} : {}),
  };
}

function convertLegacyInvocationToSchema(
  rawInvocation: unknown,
): EvalInvocation {
  if (
    typeof rawInvocation !== 'object' ||
    rawInvocation === null ||
    Array.isArray(rawInvocation)
  ) {
    throw new InputValidationError(
      'Invalid legacy invocation: expected an object.',
    );
  }
  const record = rawInvocation as Record<string, unknown>;
  if (typeof record.query !== 'string') {
    throw new InputValidationError(
      'Invalid legacy invocation: query must be a string.',
    );
  }
  const query = record.query;
  const rawReference = record.reference ?? '';
  if (typeof rawReference !== 'string') {
    throw new InputValidationError(
      'Invalid legacy invocation: reference must be a string.',
    );
  }

  const rawExpectedToolUse = record.expected_tool_use ?? [];
  if (!Array.isArray(rawExpectedToolUse)) {
    throw new InputValidationError(
      'Invalid legacy invocation: expected_tool_use must be an array.',
    );
  }
  const toolResponses: FunctionResponse[] = [];
  const toolUses: FunctionCall[] = rawExpectedToolUse.map((oldToolUse) => {
    if (
      typeof oldToolUse !== 'object' ||
      oldToolUse === null ||
      Array.isArray(oldToolUse)
    ) {
      throw new InputValidationError(
        'Invalid legacy tool_use entry: expected an object.',
      );
    }
    const tu = oldToolUse as Record<string, unknown>;
    if (typeof tu.tool_name !== 'string') {
      throw new InputValidationError(
        'Invalid legacy tool_use: tool_name must be a string.',
      );
    }
    if (
      tu.tool_input !== undefined &&
      (typeof tu.tool_input !== 'object' ||
        tu.tool_input === null ||
        Array.isArray(tu.tool_input))
    ) {
      throw new InputValidationError(
        'Invalid legacy tool_use: tool_input must be an object.',
      );
    }
    const toolUse: FunctionCall = {
      name: tu.tool_name,
      args: (tu.tool_input ?? {}) as Record<string, unknown>,
    };
    if (tu.mock_tool_output !== undefined) {
      // The structured schema keeps a mock tool output as a tool response
      // that is linked to its tool use by id.
      toolUse.id = randomUUID();
      toolResponses.push({
        id: toolUse.id,
        name: tu.tool_name,
        response: {[MOCK_TOOL_OUTPUT_RESPONSE_KEY]: tu.mock_tool_output},
      });
    }
    return toolUse;
  });

  const rawExpectedIntermediate =
    record.expected_intermediate_agent_responses ?? [];
  if (!Array.isArray(rawExpectedIntermediate)) {
    throw new InputValidationError(
      'Invalid legacy invocation: expected_intermediate_agent_responses must be an array.',
    );
  }
  const intermediateResponses: IntermediateAgentResponseItem[] =
    rawExpectedIntermediate.map((oldIntermediate) => {
      if (Array.isArray(oldIntermediate)) {
        if (
          oldIntermediate.length !== 2 ||
          typeof oldIntermediate[0] !== 'string' ||
          !Array.isArray(oldIntermediate[1])
        ) {
          throw new InputValidationError(
            'Invalid legacy intermediate response tuple: expected [author, Part[]].',
          );
        }
        return [oldIntermediate[0], oldIntermediate[1] as Part[]];
      }
      if (typeof oldIntermediate === 'object' && oldIntermediate !== null) {
        const ir = oldIntermediate as Record<string, unknown>;
        if (typeof ir.author !== 'string' || typeof ir.text !== 'string') {
          throw new InputValidationError(
            'Invalid legacy intermediate response: author and text must be strings.',
          );
        }
        return [ir.author, [{text: ir.text}]];
      }
      throw new InputValidationError(
        'Invalid legacy intermediate response: expected an object or tuple.',
      );
    });

  return {
    invocationId: randomUUID(),
    userContent: {
      parts: [{text: query}],
      role: 'user',
    },
    finalResponse: {
      parts: [{text: rawReference}],
      role: 'model',
    },
    intermediateData: {
      toolUses,
      ...(toolResponses.length > 0 ? {toolResponses} : {}),
      intermediateResponses,
    },
    creationTimestamp: Date.now() / 1000,
  };
}

/**
 * Converts a legacy array of {@link EvalEntry} JSON objects into a structured
 * {@link EvalSet}.
 *
 * @param evalSetId The identifier for the resulting eval set.
 * @param evalSetInJsonFormat Array of legacy eval case objects.
 * @returns The converted {@link EvalSet}.
 * @throws {InputValidationError} If the input array or any entry is malformed.
 */
export function convertEvalSetToSchema(
  evalSetId: string,
  evalSetInJsonFormat: unknown,
): EvalSet {
  if (!Array.isArray(evalSetInJsonFormat)) {
    throw new InputValidationError(
      'Invalid legacy eval set JSON: expected an array of eval entries.',
    );
  }

  const evalCases: EvalCase[] = [];
  for (const rawEvalCase of evalSetInJsonFormat) {
    if (
      typeof rawEvalCase !== 'object' ||
      rawEvalCase === null ||
      Array.isArray(rawEvalCase)
    ) {
      throw new InputValidationError(
        'Invalid legacy eval case: expected an object.',
      );
    }
    const oldEvalCase = rawEvalCase as Record<string, unknown>;
    if (typeof oldEvalCase.name !== 'string') {
      throw new InputValidationError(
        'Invalid legacy eval case: name must be a string.',
      );
    }
    if (!Array.isArray(oldEvalCase.data)) {
      throw new InputValidationError(
        'Invalid legacy eval case: data must be an array.',
      );
    }

    const newInvocations = oldEvalCase.data.map(
      convertLegacyInvocationToSchema,
    );

    let sessionInput: EvalSessionInput | undefined;
    if (
      oldEvalCase.initial_session !== undefined &&
      oldEvalCase.initial_session !== null
    ) {
      if (
        typeof oldEvalCase.initial_session !== 'object' ||
        Array.isArray(oldEvalCase.initial_session)
      ) {
        throw new InputValidationError(
          'Invalid legacy eval case: initial_session must be an object.',
        );
      }
      const initSess = oldEvalCase.initial_session as Record<string, unknown>;
      if (Object.keys(initSess).length > 0) {
        sessionInput = normalizeSessionInput(initSess);
      }
    }

    evalCases.push({
      evalId: oldEvalCase.name,
      conversation: newInvocations,
      ...(sessionInput !== undefined ? {sessionInput} : {}),
      creationTimestamp: Date.now() / 1000,
    });
  }

  return {
    evalSetId,
    name: evalSetId,
    creationTimestamp: Date.now() / 1000,
    evalCases,
  };
}

function parseEvalSetObject(raw: Record<string, unknown>): EvalSet {
  const rawEvalSetId = raw.evalSetId ?? raw.eval_set_id;
  const rawEvalCases = raw.evalCases ?? raw.eval_cases;
  if (typeof rawEvalSetId !== 'string' || !Array.isArray(rawEvalCases)) {
    throw new InputValidationError(
      'Invalid EvalSet JSON: missing evalSetId or evalCases.',
    );
  }
  const name = typeof raw.name === 'string' ? raw.name : undefined;
  const description =
    typeof raw.description === 'string' ? raw.description : undefined;
  const creationTimestamp = readCreationTimestamp(raw);
  return {
    evalSetId: rawEvalSetId,
    ...(name !== undefined ? {name} : {}),
    ...(description !== undefined ? {description} : {}),
    evalCases: rawEvalCases.map(normalizeEvalCase),
    ...(creationTimestamp !== undefined ? {creationTimestamp} : {}),
  };
}

/**
 * Loads an {@link EvalSet} from a file on disk, supporting both the structured
 * {@link EvalSet} JSON format and the legacy {@link EvalEntry} array format.
 *
 * @param evalSetFilePath Path to the `.evalset.json` file.
 * @param evalSetId Fallback eval set ID used when converting legacy arrays.
 * @returns The parsed {@link EvalSet}.
 */
export function loadEvalSetFromFile(
  evalSetFilePath: string,
  evalSetId: string,
): EvalSet {
  const content = fs.readFileSync(evalSetFilePath, 'utf-8');
  const parsed: unknown = JSON.parse(content);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    ('evalSetId' in parsed ||
      'eval_set_id' in parsed ||
      'evalCases' in parsed ||
      'eval_cases' in parsed)
  ) {
    return parseEvalSetObject(parsed as Record<string, unknown>);
  }
  return convertEvalSetToSchema(evalSetId, parsed);
}

/**
 * Manages local {@link EvalSet} files on disk under
 * `<agentsDir>/<appName>/<evalSetId>.evalset.json`.
 */
export class LocalEvalSetsManager {
  constructor(private readonly agentsDir: string) {}

  /**
   * Loads an {@link EvalSet} identified by `appName` and `evalSetId`, or
   * returns `undefined` if the file does not exist.
   */
  getEvalSet(appName: string, evalSetId: string): EvalSet | undefined {
    const evalSetFilePath = this.getEvalSetFilePath(appName, evalSetId);
    if (!fs.existsSync(evalSetFilePath)) {
      return undefined;
    }
    return loadEvalSetFromFile(evalSetFilePath, evalSetId);
  }

  /**
   * Creates an empty {@link EvalSet} file for `appName` and `evalSetId`.
   *
   * @throws {InputValidationError} If `evalSetId` is invalid or the eval set
   *     already exists.
   */
  createEvalSet(appName: string, evalSetId: string): EvalSet {
    validateEvalId('Eval Set ID', evalSetId);
    const newEvalSetPath = this.getEvalSetFilePath(appName, evalSetId);
    if (fs.existsSync(newEvalSetPath)) {
      throw new InputValidationError(
        `EvalSet ${evalSetId} already exists for app ${appName}.`,
      );
    }
    logger.info(`Creating eval set file \`${newEvalSetPath}\``);

    const newEvalSet: EvalSet = {
      evalSetId,
      name: evalSetId,
      evalCases: [],
      creationTimestamp: Date.now() / 1000,
    };
    this.writeEvalSet(newEvalSetPath, newEvalSet);
    return newEvalSet;
  }

  /**
   * Lists all eval set IDs stored under `appName`, sorted alphabetically.
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
        evalSets.push(file.slice(0, -EVAL_SET_FILE_EXTENSION.length));
      }
    }
    return evalSets.sort();
  }

  /**
   * Adds `evalCase` to the {@link EvalSet} identified by `appName` and
   * `evalSetId`.
   *
   * @throws {NotFoundError} If the eval set does not exist.
   * @throws {InputValidationError} If `evalCase.evalId` is invalid or already exists.
   */
  addEvalCase(appName: string, evalSetId: string, evalCase: EvalCase): void {
    const normalizedCase = normalizeEvalCase(evalCase);
    const evalCaseId = normalizedCase.evalId;
    validateEvalId('Eval Case ID', evalCaseId);

    const evalSet = this.getEvalSet(appName, evalSetId);
    if (!evalSet) {
      throw new NotFoundError(`Eval set \`${evalSetId}\` not found.`);
    }

    if (evalSet.evalCases.some((x) => x.evalId === evalCaseId)) {
      throw new InputValidationError(
        `Eval id \`${evalCaseId}\` already exists in \`${evalSetId}\` eval set.`,
      );
    }

    evalSet.evalCases.push(normalizedCase);
    const evalSetFilePath = this.getEvalSetFilePath(appName, evalSetId);
    this.writeEvalSet(evalSetFilePath, evalSet);
  }

  /**
   * Returns a single {@link EvalCase} by `appName`, `evalSetId`, and
   * `evalCaseId`, or `undefined` if not found.
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
    return evalSet.evalCases.find((c) => c.evalId === evalCaseId);
  }

  /**
   * Updates an existing {@link EvalCase} in the {@link EvalSet} identified by
   * `appName` and `evalSetId`.
   *
   * @throws {NotFoundError} If the eval set or eval case is not found.
   */
  updateEvalCase(
    appName: string,
    evalSetId: string,
    updatedEvalCase: EvalCase,
  ): void {
    const normalizedCase = normalizeEvalCase(updatedEvalCase);
    const evalCaseId = normalizedCase.evalId;
    const evalSet = this.getEvalSet(appName, evalSetId);
    if (!evalSet || !evalSet.evalCases.some((c) => c.evalId === evalCaseId)) {
      throw new NotFoundError(
        `Eval Set \`${evalSetId}\` or Eval id \`${evalCaseId}\` not found.`,
      );
    }

    evalSet.evalCases = evalSet.evalCases.filter(
      (c) => c.evalId !== evalCaseId,
    );
    evalSet.evalCases.push(normalizedCase);

    const evalSetFilePath = this.getEvalSetFilePath(appName, evalSetId);
    this.writeEvalSet(evalSetFilePath, evalSet);
  }

  /**
   * Deletes an {@link EvalCase} identified by `appName`, `evalSetId`, and
   * `evalCaseId`.
   *
   * @throws {NotFoundError} If the eval set or eval case to delete is not found.
   */
  deleteEvalCase(appName: string, evalSetId: string, evalCaseId: string): void {
    const evalSet = this.getEvalSet(appName, evalSetId);
    if (!evalSet || !evalSet.evalCases.some((c) => c.evalId === evalCaseId)) {
      throw new NotFoundError(
        `Eval Set \`${evalSetId}\` or Eval id \`${evalCaseId}\` not found.`,
      );
    }

    logger.info(
      `EvalCase \`${evalCaseId}\` was found in the eval set. It will be removed permanently.`,
    );
    evalSet.evalCases = evalSet.evalCases.filter(
      (c) => c.evalId !== evalCaseId,
    );

    const evalSetFilePath = this.getEvalSetFilePath(appName, evalSetId);
    this.writeEvalSet(evalSetFilePath, evalSet);
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

  private writeEvalSet(evalSetPath: string, evalSet: EvalSet): void {
    fs.mkdirSync(path.dirname(evalSetPath), {recursive: true});
    fs.writeFileSync(evalSetPath, JSON.stringify(evalSet, null, 2), 'utf-8');
  }
}
