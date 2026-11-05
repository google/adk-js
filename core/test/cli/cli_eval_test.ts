/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {protos} from '@google-cloud/aiplatform';
import {
  BaseAgent,
  BaseTool,
  Context,
  createEvent,
  DEFAULT_CRITERIA,
  EVAL_SESSION_ID_PREFIX,
  EvalEntry,
  EvalResult,
  EvalStatus,
  Event,
  getEvaluationCriteriaOrDefault,
  getRootAgent,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  MISSING_EVAL_DEPENDENCIES_MESSAGE,
  MULTI_TURN_TASK_SUCCESS_V1_KEY,
  MULTI_TURN_TOOL_USE_QUALITY_V1_KEY,
  MULTI_TURN_TRAJECTORY_QUALITY_V1_KEY,
  parseAndGetEvalsToRun,
  RESPONSE_EVALUATION_SCORE_KEY,
  RESPONSE_MATCH_SCORE_KEY,
  runEvals,
  SAFETY_V1_KEY,
  TOOL_TRAJECTORY_SCORE_KEY,
  tryGetResetFunc,
  VertexAiEvaluationClient,
} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

class DeterministicEvalAgent extends BaseAgent {
  constructor() {
    super({name: 'deterministic_eval_agent'});
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const query =
      ctx.userContent?.parts?.map((p) => p.text ?? '').join('') ?? '';

    if (query.includes('use_tool')) {
      yield createEvent({
        invocationId: ctx.invocationId,
        author: this.name,
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'lookup_item', args: {id: 42}}}],
        },
      });
      yield createEvent({
        invocationId: ctx.invocationId,
        author: this.name,
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'lookup_item',
                response: {status: 'ok'},
              },
            },
          ],
        },
      });
    }

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [{text: `Echo: ${query}`}],
      },
    });
  }

  protected override async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(ctx);
  }
}

type EvaluateInstancesRequest =
  protos.google.cloud.aiplatform.v1beta1.IEvaluateInstancesRequest;
type MetricResult = protos.google.cloud.aiplatform.v1beta1.IMetricResult;

/** Records each request and answers with the next queued metric result. */
class FakeEvaluationClient implements VertexAiEvaluationClient {
  readonly requests: EvaluateInstancesRequest[] = [];

  constructor(private readonly results: MetricResult[] = []) {}

  async evaluateInstances(
    request: EvaluateInstancesRequest,
  ): Promise<
    [protos.google.cloud.aiplatform.v1beta1.IEvaluateInstancesResponse]
  > {
    this.requests.push(request);
    return [{metricResults: [this.results.shift() ?? {}]}];
  }
}

describe('cli/cli_eval', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-cli-eval-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  it('exports expected constants and enum values', () => {
    expect(EVAL_SESSION_ID_PREFIX).toBe('___eval___session___');
    expect(TOOL_TRAJECTORY_SCORE_KEY).toBe('tool_trajectory_avg_score');
    expect(RESPONSE_MATCH_SCORE_KEY).toBe('response_match_score');
    expect(MISSING_EVAL_DEPENDENCIES_MESSAGE).toContain('google-adk[eval]');
    expect(DEFAULT_CRITERIA).toEqual({
      tool_trajectory_avg_score: 1.0,
      response_match_score: 0.8,
    });
    expect(EvalStatus.PASSED).toBe(1);
    expect(EvalStatus.FAILED).toBe(2);
    expect(EvalStatus.NOT_EVALUATED).toBe(3);
  });

  describe('getEvaluationCriteriaOrDefault', () => {
    it('returns DEFAULT_CRITERIA when no config file is provided', () => {
      expect(getEvaluationCriteriaOrDefault()).toEqual(DEFAULT_CRITERIA);
      expect(getEvaluationCriteriaOrDefault('')).toEqual(DEFAULT_CRITERIA);
    });

    it('loads criteria from a valid JSON config file', () => {
      const configPath = path.join(tempDir, 'test_config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          criteria: {
            tool_trajectory_avg_score: 0.9,
            response_match_score: 0.5,
          },
        }),
      );

      expect(getEvaluationCriteriaOrDefault(configPath)).toEqual({
        tool_trajectory_avg_score: 0.9,
        response_match_score: 0.5,
      });
    });

    it('throws when the config file does not contain a criteria dictionary', () => {
      const configPath = path.join(tempDir, 'bad_config.json');
      fs.writeFileSync(configPath, JSON.stringify({wrong: 123}));

      expect(() => getEvaluationCriteriaOrDefault(configPath)).toThrow(
        /Expected a 'criteria' dictionary/,
      );
    });
  });

  describe('parseAndGetEvalsToRun', () => {
    it('parses bare file paths and colon-separated eval case lists', () => {
      const parsed = parseAndGetEvalsToRun([
        'set1.evalset.json',
        'set2.evalset.json:case_a,case_b',
        'set2.evalset.json:case_c',
      ]);

      expect(parsed).toEqual({
        'set1.evalset.json': [],
        'set2.evalset.json': ['case_a', 'case_b', 'case_c'],
      });
    });
  });

  describe('getRootAgent and tryGetResetFunc', () => {
    it('loads rootAgent and reset_data from a module file or directory', async () => {
      const agentFile = path.join(tempDir, 'agent.js');
      fs.writeFileSync(
        agentFile,
        [
          `const brand = Symbol.for('google.adk.baseAgent');`,
          `export const rootAgent = { [brand]: true, name: 'stub_agent', subAgents: [] };`,
          `export function reset_data() { return 'reset-called'; }`,
        ].join('\n'),
      );

      const loadedAgent = await getRootAgent(tempDir);
      expect(loadedAgent.name).toBe('stub_agent');

      const resetFn = await tryGetResetFunc(tempDir);
      expect(typeof resetFn).toBe('function');
    });

    it('throws when module does not export a BaseAgent', async () => {
      const badFile = path.join(tempDir, 'empty_agent.js');
      fs.writeFileSync(badFile, 'export const notAnAgent = 123;\n');

      await expect(getRootAgent(badFile)).rejects.toThrow(
        /No rootAgent found in module/,
      );
      expect(await tryGetResetFunc(badFile)).toBeUndefined();
    });
  });

  describe('runEvals', () => {
    it('evaluates tool trajectory and response match scores and records eval sessions', async () => {
      const agent = new DeterministicEvalAgent();
      const sessionService = new InMemorySessionService();
      let resetCalls = 0;

      const evalCases: Record<string, EvalEntry[]> = {
        'sample.evalset.json': [
          {
            name: 'passing_case',
            data: [
              {
                query: 'please use_tool now',
                expected_tool_use: [
                  {tool_name: 'lookup_item', tool_input: {id: 42}},
                ],
                expected_intermediate_agent_responses: [],
                reference: 'Echo: please use_tool now',
              },
            ],
            initial_session: {
              app_name: 'eval_app',
              user_id: 'eval_user',
              state: {},
            },
          },
          {
            name: 'failing_case',
            data: [
              {
                query: 'hello world',
                expected_tool_use: [
                  {tool_name: 'missing_tool', tool_input: {}},
                ],
                expected_intermediate_agent_responses: [],
                reference: 'completely different unrelated text',
              },
            ],
          },
        ],
      };

      const results: EvalResult[] = [];
      for await (const res of runEvals({
        evalCasesByEvalSetId: evalCases,
        rootAgent: agent,
        resetFunc: () => {
          resetCalls += 1;
        },
        sessionService,
      })) {
        results.push(res);
      }

      expect(resetCalls).toBe(2);
      expect(results).toHaveLength(2);

      expect(results[0].eval_id).toBe('passing_case');
      expect(results[0].final_eval_status).toBe(EvalStatus.PASSED);
      expect(results[0].session_id.startsWith(EVAL_SESSION_ID_PREFIX)).toBe(
        true,
      );

      expect(results[1].eval_id).toBe('failing_case');
      expect(results[1].final_eval_status).toBe(EvalStatus.FAILED);
    });

    it('intercepts mock_tool_output via beforeToolCallback and restores callbacks after run', async () => {
      let interceptedOutput: Record<string, unknown> | undefined;
      const subLlmAgent = new LlmAgent({
        name: 'sub_llm',
        model: 'gemini-2.5-flash',
      });

      class CallbackCheckingAgent extends BaseAgent {
        constructor() {
          super({name: 'callback_checking_agent', subAgents: [subLlmAgent]});
        }

        protected override async *runAsyncImpl(
          ctx: InvocationContext,
        ): AsyncGenerator<Event, void, void> {
          const cb = subLlmAgent.beforeToolCallback;
          if (typeof cb === 'function') {
            interceptedOutput = await cb({
              tool: {name: 'lookup_item'} as BaseTool,
              args: {id: 42},
              context: {} as Context,
            });
          }
          yield createEvent({
            invocationId: ctx.invocationId,
            author: this.name,
            content: {
              role: 'model',
              parts: [{text: `Result: ${JSON.stringify(interceptedOutput)}`}],
            },
          });
        }

        protected override async *runLiveImpl(
          ctx: InvocationContext,
        ): AsyncGenerator<Event, void, void> {
          yield* this.runAsyncImpl(ctx);
        }
      }

      const evalSetPath = path.join(tempDir, 'mock_tool.evalset.json');
      const fileEntries: EvalEntry[] = [
        {
          name: 'mocked_case',
          data: [
            {
              query: 'check item',
              expected_tool_use: [
                {
                  tool_name: 'lookup_item',
                  tool_input: {id: 42},
                  mock_tool_output: 'mocked_value_42',
                },
              ],
              expected_intermediate_agent_responses: [],
              reference: 'Result: {"result":"mocked_value_42"}',
            },
          ],
        },
      ];
      fs.writeFileSync(evalSetPath, JSON.stringify(fileEntries), 'utf-8');

      const root = new CallbackCheckingAgent();
      const results: EvalResult[] = [];
      for await (const res of runEvals(
        {[evalSetPath]: ['mocked_case']},
        root,
      )) {
        results.push(res);
      }

      expect(results).toHaveLength(1);
      expect(interceptedOutput).toEqual({result: 'mocked_value_42'});
      expect(subLlmAgent.beforeToolCallback).toBeUndefined();
    });
  });

  describe('runEvals with Vertex AI metrics', () => {
    const twoTurnCase: EvalEntry = {
      name: 'two_turns',
      data: [
        {
          query: 'please use_tool now',
          expected_tool_use: [{tool_name: 'lookup_item', tool_input: {id: 42}}],
          expected_intermediate_agent_responses: [],
          reference: 'Echo: please use_tool now',
        },
        {
          query: 'thanks',
          expected_tool_use: [],
          expected_intermediate_agent_responses: [],
          reference: 'Echo: thanks',
        },
      ],
    };

    beforeEach(() => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'eval-project');
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function collect(
      options: Parameters<typeof runEvals>[0],
    ): Promise<EvalResult[]> {
      const results: EvalResult[] = [];
      for await (const result of runEvals(options)) {
        results.push(result);
      }
      return results;
    }

    it('exports the Vertex AI metric keys', () => {
      expect(SAFETY_V1_KEY).toBe('safety_v1');
      expect(MULTI_TURN_TASK_SUCCESS_V1_KEY).toBe('multi_turn_task_success_v1');
      expect(MULTI_TURN_TRAJECTORY_QUALITY_V1_KEY).toBe(
        'multi_turn_trajectory_quality_v1',
      );
      expect(MULTI_TURN_TOOL_USE_QUALITY_V1_KEY).toBe(
        'multi_turn_tool_use_quality_v1',
      );
    });

    it('scores response_evaluation_score offline without calling Vertex AI', async () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);
      const evalClient = new FakeEvaluationClient();

      const [result] = await collect({
        evalCasesByEvalSetId: {'set.evalset.json': [twoTurnCase]},
        rootAgent: new DeterministicEvalAgent(),
        evalMetrics: [
          {metric_name: RESPONSE_EVALUATION_SCORE_KEY, threshold: 0.8},
        ],
        evalClient,
      });

      expect(evalClient.requests).toEqual([]);
      expect(result.overall_eval_metric_results).toEqual([
        {
          metric_name: RESPONSE_EVALUATION_SCORE_KEY,
          threshold: 0.8,
          score: 1,
          eval_status: EvalStatus.PASSED,
        },
      ]);
    });

    it('evaluates safety_v1 per invocation and reports rubric details', async () => {
      const evalClient = new FakeEvaluationClient([
        {score: 1},
        {score: 0, explanation: 'Unsafe advice.'},
      ]);

      const [result] = await collect({
        evalCasesByEvalSetId: {'set.evalset.json': [twoTurnCase]},
        rootAgent: new DeterministicEvalAgent(),
        evalMetrics: [{metric_name: SAFETY_V1_KEY, threshold: 1}],
        evalClient,
      });

      expect(
        evalClient.requests.map(
          (request) =>
            request.metrics?.[0].predefinedMetricSpec?.metricSpecName,
        ),
      ).toEqual(['safety_v1', 'safety_v1']);
      expect(result.overall_eval_metric_results[0]).toMatchObject({
        score: 0.5,
        eval_status: EvalStatus.FAILED,
      });
      expect(
        result.eval_metric_result_per_invocation[1].eval_metric_results[0],
      ).toEqual({
        metric_name: SAFETY_V1_KEY,
        threshold: 1,
        score: 0,
        eval_status: EvalStatus.FAILED,
        rubric_scores: [{rubricId: 'explanation', rationale: 'Unsafe advice.'}],
      });
      expect(result.final_eval_status).toBe(EvalStatus.FAILED);
    });

    it.each([
      MULTI_TURN_TASK_SUCCESS_V1_KEY,
      MULTI_TURN_TRAJECTORY_QUALITY_V1_KEY,
      MULTI_TURN_TOOL_USE_QUALITY_V1_KEY,
    ])(
      'evaluates %s once over the recorded conversation',
      async (metricName) => {
        const evalClient = new FakeEvaluationClient([
          {
            score: 1,
            rubricVerdicts: [
              {evaluatedRubric: {rubricId: 'goal'}, verdict: true},
            ],
          },
        ]);

        const [result] = await collect({
          evalCasesByEvalSetId: {'set.evalset.json': [twoTurnCase]},
          rootAgent: new DeterministicEvalAgent(),
          evalMetrics: [{metric_name: metricName, threshold: 0.5}],
          evalClient,
        });

        expect(evalClient.requests).toHaveLength(1);
        const [request] = evalClient.requests;
        expect(request.metrics).toEqual([
          {predefinedMetricSpec: {metricSpecName: metricName}},
        ]);
        const agentData = request.instance?.agentEvalData;
        expect(agentData?.agents).toEqual({
          deterministic_eval_agent: {
            agentId: 'deterministic_eval_agent',
            instruction: '',
            tools: [],
          },
        });
        expect(agentData?.turns?.map((turn) => turn.turnIndex)).toEqual([0, 1]);
        expect(
          agentData?.turns?.[0].events?.map((event) => [
            event.author,
            Object.keys(event.content?.parts?.[0] ?? {})[0],
          ]),
        ).toEqual([
          ['user', 'text'],
          ['deterministic_eval_agent', 'functionCall'],
          ['deterministic_eval_agent', 'functionResponse'],
          ['agent', 'text'],
        ]);

        expect(result.overall_eval_metric_results).toEqual([
          {
            metric_name: metricName,
            threshold: 0.5,
            score: 1,
            eval_status: EvalStatus.PASSED,
            rubric_scores: [{rubricId: 'goal', rationale: undefined, score: 1}],
          },
        ]);
        expect(
          result.eval_metric_result_per_invocation.map(
            (perInvocation) => perInvocation.eval_metric_results[0].eval_status,
          ),
        ).toEqual([EvalStatus.NOT_EVALUATED, EvalStatus.PASSED]);
        expect(result.final_eval_status).toBe(EvalStatus.PASSED);
      },
    );

    it('fails before running the agent when a Vertex AI metric has no project', async () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
      let resetCalls = 0;

      await expect(
        collect({
          evalCasesByEvalSetId: {'set.evalset.json': [twoTurnCase]},
          rootAgent: new DeterministicEvalAgent(),
          resetFunc: () => {
            resetCalls += 1;
          },
          evalMetrics: [{metric_name: SAFETY_V1_KEY, threshold: 1}],
          evalClient: new FakeEvaluationClient(),
        }),
      ).rejects.toThrow(/^Missing project id\. /);
      expect(resetCalls).toBe(0);
    });

    it('does not need a Google Cloud project for local metrics', async () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);

      const [result] = await collect({
        evalCasesByEvalSetId: {'set.evalset.json': [twoTurnCase]},
        rootAgent: new DeterministicEvalAgent(),
        evalMetrics: [{metric_name: RESPONSE_MATCH_SCORE_KEY, threshold: 0.8}],
      });

      expect(result.final_eval_status).toBe(EvalStatus.PASSED);
    });
  });
});
