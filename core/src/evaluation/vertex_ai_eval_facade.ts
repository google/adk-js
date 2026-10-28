/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {protos} from '@google-cloud/aiplatform';
import {Content} from '@google/genai';

import {loadOptionalPeer} from '../utils/optional_peer.js';
import {AgentDetails} from './app_details.js';
import {
  ConversationScenario,
  Invocation,
  isInvocationEvents,
} from './eval_case.js';
import {RubricScore} from './eval_rubrics.js';
import {
  EvalStatus,
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
  validateInvocationLengths,
} from './evaluator.js';
import {toVertexContent, toVertexTools} from './vertex_ai_converters.js';

type EvaluateInstancesRequest =
  protos.google.cloud.aiplatform.v1beta1.IEvaluateInstancesRequest;
type EvaluateInstancesResponse =
  protos.google.cloud.aiplatform.v1beta1.IEvaluateInstancesResponse;
type VertexMetricResult = protos.google.cloud.aiplatform.v1beta1.IMetricResult;
type VertexRubricVerdict =
  protos.google.cloud.aiplatform.v1beta1.IRubricVerdict;
type VertexAgentData = protos.google.cloud.aiplatform.v1beta1.IAgentData;
type VertexAgentConfig = protos.google.cloud.aiplatform.v1beta1.IAgentConfig;
type VertexConversationTurn =
  protos.google.cloud.aiplatform.v1beta1.IConversationTurn;
type VertexAgentEvent = protos.google.cloud.aiplatform.v1beta1.IAgentEvent;

/**
 * `rubricId` of the {@link RubricScore} that carries the judge's overall
 * explanation of a metric, as opposed to its verdict on one specific rubric.
 */
const EXPLANATION_RUBRIC_ID = 'explanation';

/**
 * `rubricId` of the {@link RubricScore} that carries the error Vertex AI
 * reported when it could not score a metric.
 */
const ERROR_RUBRIC_ID = 'error';

const MISSING_CONFIG_MESSAGE_SUFFIX =
  ' Vertex AI evaluation needs both a Google Cloud project id and a location,' +
  ' and Google Cloud credentials. Pass `projectId` and `location`, or set the' +
  ' GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION environment variables.';

/**
 * The part of the Vertex AI `EvaluationServiceClient` that the facades use.
 *
 * The `v1beta1.EvaluationServiceClient` of `@google-cloud/aiplatform`
 * satisfies it. Pass another implementation to control the calls, for example
 * in tests.
 */
export interface VertexAiEvaluationClient {
  /** Evaluates one instance against the first metric in the request. */
  evaluateInstances(
    request: EvaluateInstancesRequest,
  ): Promise<[EvaluateInstancesResponse, ...unknown[]]>;
}

/** Options for the Vertex AI evaluation facades. */
export interface VertexAiEvalFacadeOptions {
  /** The score at or above which an invocation passes. */
  threshold: number;

  /**
   * The name of the Vertex AI predefined metric spec, for example
   * `safety_v1` or `multi_turn_task_success_v1`.
   */
  metricName: string;

  /**
   * Whether the metric needs expected invocations. When true, an evaluation
   * without them throws.
   */
  expectedInvocationsRequired?: boolean;

  /**
   * The Google Cloud project id. Defaults to the GOOGLE_CLOUD_PROJECT
   * environment variable.
   */
  projectId?: string;

  /**
   * The Google Cloud location. Defaults to the GOOGLE_CLOUD_LOCATION
   * environment variable.
   */
  location?: string;

  /**
   * The client used to call Vertex AI. Defaults to a
   * `v1beta1.EvaluationServiceClient` for `location`, created on first use.
   */
  client?: VertexAiEvaluationClient;
}

/**
 * Resolves the Google Cloud project id and location from explicit values or
 * from the environment.
 *
 * @throws If either value is missing.
 */
export function resolveVertexAiProject(options: {
  projectId?: string;
  location?: string;
}): {projectId: string; location: string} {
  const projectId = options.projectId ?? process.env['GOOGLE_CLOUD_PROJECT'];
  const location = options.location ?? process.env['GOOGLE_CLOUD_LOCATION'];
  const missing = [
    ...(projectId ? [] : ['project id']),
    ...(location ? [] : ['location']),
  ];
  if (!projectId || !location) {
    throw new Error(
      `Missing ${missing.join(' and ')}.${MISSING_CONFIG_MESSAGE_SUFFIX}`,
    );
  }
  return {projectId, location};
}

/**
 * Evaluator backed by the Vertex AI evaluation service.
 *
 * The Vertex AI evaluation service exposes many metrics that are valuable for
 * agent evaluation; this class gives access to them. Using it requires a
 * Google Cloud project and location, see {@link VertexAiEvalFacadeOptions}.
 */
export abstract class VertexAiEvalFacade extends Evaluator {
  protected readonly threshold: number;
  protected readonly metricName: string;
  protected readonly expectedInvocationsRequired: boolean;
  private readonly projectId: string;
  private readonly location: string;
  private clientPromise?: Promise<VertexAiEvaluationClient>;

  /**
   * @throws If the project id or the location is neither given nor set in the
   *   environment.
   */
  constructor(options: VertexAiEvalFacadeOptions) {
    super();
    const {projectId, location} = resolveVertexAiProject(options);
    this.threshold = options.threshold;
    this.metricName = options.metricName;
    this.expectedInvocationsRequired =
      options.expectedInvocationsRequired ?? false;
    this.projectId = projectId;
    this.location = location;
    if (options.client) {
      this.clientPromise = Promise.resolve(options.client);
    }
  }

  /** Returns the status of `score` against the threshold. */
  protected getEvalStatus(score: number | undefined): EvalStatus {
    if (score === undefined) {
      return EvalStatus.NOT_EVALUATED;
    }
    return score >= this.threshold ? EvalStatus.PASSED : EvalStatus.FAILED;
  }

  /**
   * Sends `instance` to Vertex AI for evaluation against this facade's metric
   * and returns the metric result.
   */
  protected async performEval(
    instance: EvaluateInstancesRequest['instance'],
  ): Promise<VertexMetricResult | undefined> {
    const client = await this.getClient();
    const [response] = await client.evaluateInstances({
      location: `projects/${this.projectId}/locations/${this.location}`,
      metrics: [{predefinedMetricSpec: {metricSpecName: this.metricName}}],
      instance,
    });
    return response.metricResults?.[0] ?? undefined;
  }

  private getClient(): Promise<VertexAiEvaluationClient> {
    this.clientPromise ??= createEvaluationClient(this.location);
    // A failed load is not cached, so a later evaluation can retry it.
    this.clientPromise.catch(() => {
      this.clientPromise = undefined;
    });
    return this.clientPromise;
  }
}

async function createEvaluationClient(
  location: string,
): Promise<VertexAiEvaluationClient> {
  const {v1beta1} = await loadOptionalPeer(
    {packageName: '@google-cloud/aiplatform', feature: 'VertexAiEvalFacade'},
    () => import('@google-cloud/aiplatform'),
  );
  return new v1beta1.EvaluationServiceClient({
    apiEndpoint: `${location}-aiplatform.googleapis.com`,
  });
}

/**
 * Returns the score of a Vertex AI metric result, or undefined when Vertex AI
 * did not produce a usable number.
 */
function getScore(result: VertexMetricResult | undefined): number | undefined {
  const score = result?.score;
  if (typeof score !== 'number' || Number.isNaN(score)) {
    return undefined;
  }
  return score;
}

/**
 * Returns the judge's rubric verdicts and explanation as {@link RubricScore}
 * objects.
 *
 * Each rubric verdict (returned by adaptive-rubric metrics such as
 * `multi_turn_task_success_v1`) becomes one rubric score. The metric's
 * explanation, and its error message when Vertex AI could not score it, are
 * appended as extra rubric scores that only carry a rationale.
 *
 * Returns undefined when Vertex AI returned none of these details.
 */
function getRubricScores(
  result: VertexMetricResult | undefined,
): RubricScore[] | undefined {
  if (!result) {
    return undefined;
  }
  const rubricScores = (result.rubricVerdicts ?? []).map(toRubricScore);
  if (result.explanation) {
    rubricScores.push({
      rubricId: EXPLANATION_RUBRIC_ID,
      rationale: result.explanation,
    });
  }
  if (result.error?.message) {
    rubricScores.push({
      rubricId: ERROR_RUBRIC_ID,
      rationale: result.error.message,
    });
  }
  return rubricScores.length > 0 ? rubricScores : undefined;
}

function toRubricScore(
  verdict: VertexRubricVerdict,
  index: number,
): RubricScore {
  const rubric = verdict.evaluatedRubric;
  return {
    rubricId:
      rubric?.content?.property?.description ||
      rubric?.rubricId ||
      `rubric_${index}`,
    rationale: verdict.reasoning ?? undefined,
    // Vertex AI omits `verdict` when a rubric is not met.
    score: verdict.verdict ? 1.0 : 0.0,
  };
}

function getText(content: Content | undefined): string {
  return (content?.parts ?? [])
    .filter((part) => part.text)
    .map((part) => part.text)
    .join('\n');
}

/**
 * A facade for the single-turn metrics of the Vertex AI evaluation service.
 *
 * Each invocation is sent as its own instance, with the user content as the
 * prompt, the final response as the response, and the final response of the
 * matching expected invocation, if any, as the reference.
 */
export class SingleTurnVertexAiEvalFacade extends VertexAiEvalFacade {
  override async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    // Not supported for per-invocation evaluation.
    _conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult> {
    if (this.expectedInvocationsRequired && !expectedInvocations) {
      throw new Error(
        `expectedInvocations is needed by the ${this.metricName} metric.`,
      );
    }
    validateInvocationLengths(actualInvocations, expectedInvocations);

    const perInvocationResults: PerInvocationResult[] = [];
    // Requests are sent one at a time on purpose: parallel calls can exceed
    // the evaluation service quota on long eval sets.
    for (const [index, actual] of actualInvocations.entries()) {
      const expected = expectedInvocations?.[index];
      const result = await this.performEval({
        prompt: {text: getText(actual.userContent)},
        response: {text: getText(actual.finalResponse)},
        reference: expected
          ? {text: getText(expected.finalResponse)}
          : undefined,
      });
      const score = getScore(result);
      // Each invocation is judged separately, so its explanation and verdicts
      // stay on that invocation and are not aggregated into
      // `overallRubricScores`.
      perInvocationResults.push({
        actualInvocation: actual,
        expectedInvocation: expected,
        score,
        evalStatus: this.getEvalStatus(score),
        rubricScores: getRubricScores(result),
      });
    }

    const scores = perInvocationResults.flatMap((result) =>
      result.score === undefined ? [] : [result.score],
    );
    const overallScore =
      scores.length > 0
        ? scores.reduce((sum, score) => sum + score, 0) / scores.length
        : undefined;
    return {
      overallScore,
      overallEvalStatus: this.getEvalStatus(overallScore),
      perInvocationResults,
    };
  }
}

/**
 * A facade for the multi-turn metrics of the Vertex AI evaluation service.
 *
 * The whole conversation is sent as one instance and judged once. The score
 * is attached to the last invocation; the earlier invocations are marked
 * {@link EvalStatus.NOT_EVALUATED}.
 */
export class MultiTurnVertexAiEvalFacade extends VertexAiEvalFacade {
  override async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    _conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult> {
    validateInvocationLengths(actualInvocations, expectedInvocations);
    if (actualInvocations.length === 0) {
      return {
        overallEvalStatus: EvalStatus.NOT_EVALUATED,
        perInvocationResults: [],
      };
    }
    const result = await this.performEval({
      agentEvalData: toAgentData(actualInvocations),
    });
    const score = getScore(result);
    const rubricScores = getRubricScores(result);
    const lastIndex = actualInvocations.length - 1;
    const perInvocationResults: PerInvocationResult[] = actualInvocations.map(
      (actual, index) => ({
        actualInvocation: actual,
        expectedInvocation: expectedInvocations?.[index],
        ...(index === lastIndex
          ? {score, evalStatus: this.getEvalStatus(score), rubricScores}
          : {evalStatus: EvalStatus.NOT_EVALUATED}),
      }),
    );

    if (score === undefined && rubricScores === undefined) {
      return {
        overallEvalStatus: EvalStatus.NOT_EVALUATED,
        perInvocationResults: [],
      };
    }
    // The whole conversation is judged once, so the verdicts attached to the
    // last turn are also the overall verdicts. They are kept even without a
    // score, since they then carry the reason Vertex AI could not score it.
    return {
      overallScore: score,
      overallEvalStatus: this.getEvalStatus(score),
      perInvocationResults,
      overallRubricScores: rubricScores,
    };
  }
}

function toAgentData(invocations: readonly Invocation[]): VertexAgentData {
  const agents: Record<string, VertexAgentConfig> = {};
  for (const invocation of invocations) {
    for (const [name, details] of Object.entries(
      invocation.appDetails?.agentDetails ?? {},
    )) {
      agents[name] ??= toAgentConfig(details);
    }
  }
  return {agents, turns: invocations.map(toConversationTurn)};
}

function toAgentConfig(details: AgentDetails): VertexAgentConfig {
  return {
    agentId: details.name,
    instruction: details.instructions,
    tools: toVertexTools(details.toolDeclarations),
  };
}

function toConversationTurn(
  invocation: Invocation,
  turnIndex: number,
): VertexConversationTurn {
  // Only `InvocationEvents` carry the full content and author of each step;
  // `IntermediateData` from eval sets is not sent as turn events.
  const intermediateEvents: VertexAgentEvent[] = isInvocationEvents(
    invocation.intermediateData,
  )
    ? invocation.intermediateData.invocationEvents.flatMap((event) =>
        event.content
          ? [{author: event.author, content: toVertexContent(event.content)}]
          : [],
      )
    : [];
  return {
    turnIndex,
    turnId: invocation.invocationId,
    events: [
      {author: 'user', content: toVertexContent(invocation.userContent)},
      ...intermediateEvents,
      // The agent event closes every turn, also when the agent gave no final
      // response.
      {
        author: 'agent',
        content: invocation.finalResponse
          ? toVertexContent(invocation.finalResponse)
          : undefined,
      },
    ],
  };
}
