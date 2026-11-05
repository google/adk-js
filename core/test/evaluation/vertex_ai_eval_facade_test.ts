/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {protos} from '@google-cloud/aiplatform';
import {
  AppDetails,
  EvalStatus,
  Invocation,
  MultiTurnVertexAiEvalFacade,
  SingleTurnVertexAiEvalFacade,
  VertexAiEvaluationClient,
} from '@google/adk';
import {Type} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

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

function textInvocation({
  query,
  response,
  appDetails,
}: {
  query: string;
  response?: string;
  appDetails?: AppDetails;
}): Invocation {
  return {
    userContent: {role: 'user', parts: [{text: query}]},
    finalResponse:
      response === undefined
        ? undefined
        : {role: 'model', parts: [{text: response}]},
    appDetails,
  };
}

const APP_DETAILS: AppDetails = {
  agentDetails: {
    root_agent: {
      name: 'root_agent',
      instructions: 'Look up items.',
      toolDeclarations: [
        {
          functionDeclarations: [
            {
              name: 'lookup_item',
              description: 'Looks up an item by id.',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  id: {type: Type.INTEGER, default: 1},
                  note: {type: Type.NULL},
                },
              },
            },
          ],
        },
      ],
    },
  },
};

describe('VertexAiEvalFacade', () => {
  beforeEach(() => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'env-location');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('project and location', () => {
    it('throws when neither the options nor the environment give a project id', () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);

      expect(
        () =>
          new SingleTurnVertexAiEvalFacade({
            threshold: 0.5,
            metricName: 'safety_v1',
            client: new FakeEvaluationClient(),
          }),
      ).toThrow(/^Missing project id\. /);
    });

    it('throws when neither the options nor the environment give a location', () => {
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);

      expect(
        () =>
          new MultiTurnVertexAiEvalFacade({
            threshold: 0.5,
            metricName: 'multi_turn_task_success_v1',
            client: new FakeEvaluationClient(),
          }),
      ).toThrow(/^Missing location\. /);
    });

    it('names both values when both are missing', () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);

      expect(
        () =>
          new SingleTurnVertexAiEvalFacade({
            threshold: 0.5,
            metricName: 'safety_v1',
          }),
      ).toThrow(/^Missing project id and location\. /);
    });

    it('prefers explicit options over the environment', async () => {
      const client = new FakeEvaluationClient([{score: 1}]);
      const facade = new SingleTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'safety_v1',
        projectId: 'my-project',
        location: 'europe-west4',
        client,
      });

      await facade.evaluateInvocations([textInvocation({query: 'hi'})]);

      expect(client.requests[0].location).toBe(
        'projects/my-project/locations/europe-west4',
      );
    });
  });

  describe('SingleTurnVertexAiEvalFacade', () => {
    it('sends one request per invocation with prompt, response and reference', async () => {
      const client = new FakeEvaluationClient([{score: 4}, {score: 2}]);
      const facade = new SingleTurnVertexAiEvalFacade({
        threshold: 3,
        metricName: 'coherence_v1',
        client,
      });

      await facade.evaluateInvocations(
        [
          textInvocation({query: 'first', response: 'answer one'}),
          {
            userContent: {role: 'user', parts: [{text: 'a'}, {text: 'b'}]},
            finalResponse: {
              role: 'model',
              parts: [
                {text: 'line 1'},
                {functionCall: {name: 'f'}},
                {text: 'line 2'},
              ],
            },
          },
        ],
        [
          textInvocation({query: 'first', response: 'golden one'}),
          textInvocation({query: 'a', response: 'golden two'}),
        ],
      );

      expect(client.requests).toEqual([
        {
          location: 'projects/env-project/locations/env-location',
          metrics: [{predefinedMetricSpec: {metricSpecName: 'coherence_v1'}}],
          instance: {
            prompt: {text: 'first'},
            response: {text: 'answer one'},
            reference: {text: 'golden one'},
          },
        },
        {
          location: 'projects/env-project/locations/env-location',
          metrics: [{predefinedMetricSpec: {metricSpecName: 'coherence_v1'}}],
          instance: {
            prompt: {text: 'a\nb'},
            response: {text: 'line 1\nline 2'},
            reference: {text: 'golden two'},
          },
        },
      ]);
    });

    it('omits the reference when there are no expected invocations', async () => {
      const client = new FakeEvaluationClient([{score: 1}]);
      const facade = new SingleTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'safety_v1',
        client,
      });

      await facade.evaluateInvocations([
        textInvocation({query: 'hi', response: 'hello'}),
      ]);

      expect(client.requests[0].instance).toEqual({
        prompt: {text: 'hi'},
        response: {text: 'hello'},
        reference: undefined,
      });
    });

    it('averages the scores and derives each status from the threshold', async () => {
      const client = new FakeEvaluationClient([{score: 0.9}, {score: 0.3}]);
      const facade = new SingleTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'safety_v1',
        client,
      });

      const result = await facade.evaluateInvocations([
        textInvocation({query: 'one'}),
        textInvocation({query: 'two'}),
      ]);

      expect(result.overallScore).toBeCloseTo(0.6);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
      expect(
        result.perInvocationResults.map((r) => [r.score, r.evalStatus]),
      ).toEqual([
        [0.9, EvalStatus.PASSED],
        [0.3, EvalStatus.FAILED],
      ]);
    });

    it('leaves NaN, null and missing scores out of the average', async () => {
      const client = new FakeEvaluationClient([
        {score: Number.NaN},
        {score: null},
        {},
        {score: 0.2},
      ]);
      const facade = new SingleTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'safety_v1',
        client,
      });

      const result = await facade.evaluateInvocations([
        textInvocation({query: 'one'}),
        textInvocation({query: 'two'}),
        textInvocation({query: 'three'}),
        textInvocation({query: 'four'}),
      ]);

      expect(result.overallScore).toBe(0.2);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
      expect(
        result.perInvocationResults.map((r) => [r.score, r.evalStatus]),
      ).toEqual([
        [undefined, EvalStatus.NOT_EVALUATED],
        [undefined, EvalStatus.NOT_EVALUATED],
        [undefined, EvalStatus.NOT_EVALUATED],
        [0.2, EvalStatus.FAILED],
      ]);
    });

    it('reports NOT_EVALUATED when no invocation has a score', async () => {
      const client = new FakeEvaluationClient([{score: Number.NaN}]);
      const facade = new SingleTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'safety_v1',
        client,
      });

      const result = await facade.evaluateInvocations([
        textInvocation({query: 'one'}),
      ]);

      expect(result.overallScore).toBeUndefined();
      expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    });

    it('returns an empty NOT_EVALUATED result for no invocations', async () => {
      const client = new FakeEvaluationClient();
      const facade = new SingleTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'safety_v1',
        client,
      });

      const result = await facade.evaluateInvocations([]);

      expect(result).toEqual({
        overallScore: undefined,
        overallEvalStatus: EvalStatus.NOT_EVALUATED,
        perInvocationResults: [],
      });
      expect(client.requests).toEqual([]);
    });

    it('keeps rubric verdicts, the explanation and the error on the invocation', async () => {
      const client = new FakeEvaluationClient([
        {
          score: 0.5,
          rubricVerdicts: [
            {
              evaluatedRubric: {
                rubricId: 'r1',
                content: {property: {description: 'Is polite.'}},
              },
              verdict: true,
              reasoning: 'It says please.',
            },
            {evaluatedRubric: {rubricId: 'r2'}, verdict: false},
            {verdict: true},
          ],
          explanation: 'Mostly fine.',
          error: {message: 'Partial quota.'},
        },
      ]);
      const facade = new SingleTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'safety_v1',
        client,
      });

      const result = await facade.evaluateInvocations([
        textInvocation({query: 'one'}),
      ]);

      expect(result.perInvocationResults[0].rubricScores).toEqual([
        {rubricId: 'Is polite.', rationale: 'It says please.', score: 1},
        {rubricId: 'r2', rationale: undefined, score: 0},
        {rubricId: 'rubric_2', rationale: undefined, score: 1},
        {rubricId: 'explanation', rationale: 'Mostly fine.'},
        {rubricId: 'error', rationale: 'Partial quota.'},
      ]);
      expect(result.overallRubricScores).toBeUndefined();
    });

    it('carries the error message as a rubric score when Vertex AI cannot score', async () => {
      const client = new FakeEvaluationClient([
        {error: {code: 8, message: 'Quota exceeded.'}},
      ]);
      const facade = new SingleTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'safety_v1',
        client,
      });

      const result = await facade.evaluateInvocations([
        textInvocation({query: 'one'}),
      ]);

      expect(result.perInvocationResults[0]).toMatchObject({
        score: undefined,
        evalStatus: EvalStatus.NOT_EVALUATED,
        rubricScores: [{rubricId: 'error', rationale: 'Quota exceeded.'}],
      });
    });

    it('throws when the invocation lists differ in length', async () => {
      const client = new FakeEvaluationClient();
      const facade = new SingleTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'coherence_v1',
        client,
      });

      await expect(
        facade.evaluateInvocations(
          [textInvocation({query: 'one'}), textInvocation({query: 'two'})],
          [textInvocation({query: 'one'})],
        ),
      ).rejects.toThrow(
        'actualInvocations and expectedInvocations must have the same length; got 2 and 1.',
      );
      expect(client.requests).toEqual([]);
    });

    it('throws when the metric needs expected invocations and none are given', async () => {
      const client = new FakeEvaluationClient();
      const facade = new SingleTurnVertexAiEvalFacade({
        threshold: 3,
        metricName: 'coherence_v1',
        expectedInvocationsRequired: true,
        client,
      });

      await expect(
        facade.evaluateInvocations([textInvocation({query: 'one'})]),
      ).rejects.toThrow(
        'expectedInvocations is needed by the coherence_v1 metric.',
      );
    });

    it('surfaces a failed Vertex AI call', async () => {
      const client: VertexAiEvaluationClient = {
        evaluateInstances: async () => {
          throw new Error('PERMISSION_DENIED');
        },
      };
      const facade = new SingleTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'safety_v1',
        client,
      });

      await expect(
        facade.evaluateInvocations([textInvocation({query: 'one'})]),
      ).rejects.toThrow('PERMISSION_DENIED');
    });
  });

  describe('MultiTurnVertexAiEvalFacade', () => {
    it('sends the whole conversation, with its agents, as one instance', async () => {
      const client = new FakeEvaluationClient([{score: 1}]);
      const facade = new MultiTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'multi_turn_trajectory_quality_v1',
        client,
      });

      await facade.evaluateInvocations([
        {
          invocationId: 'inv-1',
          userContent: {role: 'user', parts: [{text: 'find item 42'}]},
          intermediateData: {
            invocationEvents: [
              {
                author: 'root_agent',
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        id: 'call-1',
                        name: 'lookup_item',
                        args: {id: 42, tags: ['a'], extra: null},
                      },
                    },
                  ],
                },
              },
              {author: 'root_agent'},
              {
                author: 'root_agent',
                content: {
                  role: 'user',
                  parts: [
                    {
                      functionResponse: {
                        id: 'call-1',
                        name: 'lookup_item',
                        response: {found: true},
                      },
                    },
                  ],
                },
              },
            ],
          },
          finalResponse: {role: 'model', parts: [{text: 'Found it.'}]},
          appDetails: APP_DETAILS,
        },
        {
          invocationId: 'inv-2',
          userContent: {role: 'user', parts: [{text: 'thanks'}]},
          intermediateData: {
            toolUses: [{name: 'log', args: {level: 'info'}}],
            toolResponses: [{name: 'log', response: {ok: true}}],
            intermediateResponses: [['helper', [{text: 'logging'}]]],
          },
          appDetails: APP_DETAILS,
        },
      ]);

      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]).toEqual({
        location: 'projects/env-project/locations/env-location',
        metrics: [
          {
            predefinedMetricSpec: {
              metricSpecName: 'multi_turn_trajectory_quality_v1',
            },
          },
        ],
        instance: {
          agentEvalData: {
            agents: {
              root_agent: {
                agentId: 'root_agent',
                instruction: 'Look up items.',
                tools: [
                  {
                    functionDeclarations: [
                      {
                        name: 'lookup_item',
                        description: 'Looks up an item by id.',
                        parametersJsonSchema: undefined,
                        parameters: {
                          type: Type.OBJECT,
                          nullable: undefined,
                          items: undefined,
                          anyOf: undefined,
                          default: undefined,
                          example: undefined,
                          properties: {
                            id: {
                              type: Type.INTEGER,
                              nullable: undefined,
                              items: undefined,
                              properties: undefined,
                              anyOf: undefined,
                              default: {numberValue: 1},
                              example: undefined,
                            },
                            note: {
                              type: undefined,
                              nullable: true,
                              items: undefined,
                              properties: undefined,
                              anyOf: undefined,
                              default: undefined,
                              example: undefined,
                            },
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            },
            turns: [
              {
                turnIndex: 0,
                turnId: 'inv-1',
                events: [
                  {
                    author: 'user',
                    content: {role: 'user', parts: [{text: 'find item 42'}]},
                  },
                  {
                    author: 'root_agent',
                    content: {
                      role: 'model',
                      parts: [
                        {
                          functionCall: {
                            id: 'call-1',
                            name: 'lookup_item',
                            args: {
                              fields: {
                                id: {numberValue: 42},
                                tags: {
                                  listValue: {values: [{stringValue: 'a'}]},
                                },
                                extra: {nullValue: 'NULL_VALUE'},
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                  {
                    author: 'root_agent',
                    content: {
                      role: 'user',
                      parts: [
                        {
                          functionResponse: {
                            id: 'call-1',
                            name: 'lookup_item',
                            response: {
                              fields: {found: {boolValue: true}},
                            },
                          },
                        },
                      ],
                    },
                  },
                  {
                    author: 'agent',
                    content: {role: 'model', parts: [{text: 'Found it.'}]},
                  },
                ],
              },
              {
                turnIndex: 1,
                turnId: 'inv-2',
                events: [
                  {
                    author: 'user',
                    content: {role: 'user', parts: [{text: 'thanks'}]},
                  },
                  {author: 'agent', content: undefined},
                ],
              },
            ],
          },
        },
      });
    });

    it('sends the response schemas of tool declarations', async () => {
      const client = new FakeEvaluationClient([{score: 1}]);
      const facade = new MultiTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'multi_turn_tool_use_quality_v1',
        client,
      });

      await facade.evaluateInvocations([
        {
          invocationId: 'inv-1',
          userContent: {role: 'user', parts: [{text: 'find item 42'}]},
          appDetails: {
            agentDetails: {
              root_agent: {
                name: 'root_agent',
                instructions: '',
                toolDeclarations: [
                  {
                    functionDeclarations: [
                      {
                        name: 'lookup_item',
                        response: {type: Type.STRING},
                      },
                      {
                        name: 'list_items',
                        responseJsonSchema: {type: 'array'},
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      ]);

      const declarations =
        client.requests[0].instance?.agentEvalData?.agents?.['root_agent']
          ?.tools?.[0]?.functionDeclarations;
      expect(declarations?.[0]?.response).toEqual({type: Type.STRING});
      expect(declarations?.[0]?.responseJsonSchema).toBeUndefined();
      expect(declarations?.[1]?.response).toBeUndefined();
      expect(declarations?.[1]?.responseJsonSchema).toEqual({
        structValue: {fields: {type: {stringValue: 'array'}}},
      });
    });

    it('scores only the last turn and reports its verdicts as the overall ones', async () => {
      const verdicts: MetricResult = {
        score: 0.75,
        rubricVerdicts: [{evaluatedRubric: {rubricId: 'goal'}, verdict: true}],
        explanation: 'Goal reached.',
      };
      const client = new FakeEvaluationClient([verdicts]);
      const facade = new MultiTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'multi_turn_task_success_v1',
        client,
      });
      const actual = [
        textInvocation({query: 'one', response: 'a'}),
        textInvocation({query: 'two', response: 'b'}),
        textInvocation({query: 'three', response: 'c'}),
      ];

      const result = await facade.evaluateInvocations(actual);

      const rubricScores = [
        {rubricId: 'goal', rationale: undefined, score: 1},
        {rubricId: 'explanation', rationale: 'Goal reached.'},
      ];
      expect(result).toEqual({
        overallScore: 0.75,
        overallEvalStatus: EvalStatus.PASSED,
        overallRubricScores: rubricScores,
        perInvocationResults: [
          {
            actualInvocation: actual[0],
            expectedInvocation: undefined,
            evalStatus: EvalStatus.NOT_EVALUATED,
          },
          {
            actualInvocation: actual[1],
            expectedInvocation: undefined,
            evalStatus: EvalStatus.NOT_EVALUATED,
          },
          {
            actualInvocation: actual[2],
            expectedInvocation: undefined,
            score: 0.75,
            evalStatus: EvalStatus.PASSED,
            rubricScores,
          },
        ],
      });
    });

    it('keeps the error rubric score when Vertex AI cannot score the conversation', async () => {
      const client = new FakeEvaluationClient([
        {score: Number.NaN, error: {message: 'Quota exceeded.'}},
      ]);
      const facade = new MultiTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'multi_turn_task_success_v1',
        client,
      });

      const result = await facade.evaluateInvocations([
        textInvocation({query: 'one'}),
      ]);

      expect(result.overallScore).toBeUndefined();
      expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
      expect(result.overallRubricScores).toEqual([
        {rubricId: 'error', rationale: 'Quota exceeded.'},
      ]);
      expect(result.perInvocationResults).toHaveLength(1);
    });

    it('returns an empty result when Vertex AI returns neither a score nor details', async () => {
      const client = new FakeEvaluationClient([{}]);
      const facade = new MultiTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'multi_turn_task_success_v1',
        client,
      });

      const result = await facade.evaluateInvocations([
        textInvocation({query: 'one'}),
      ]);

      expect(result).toEqual({
        overallEvalStatus: EvalStatus.NOT_EVALUATED,
        perInvocationResults: [],
      });
    });

    it('returns an empty result without calling Vertex AI for no invocations', async () => {
      const client = new FakeEvaluationClient();
      const facade = new MultiTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'multi_turn_task_success_v1',
        client,
      });

      const result = await facade.evaluateInvocations([]);

      expect(result).toEqual({
        overallEvalStatus: EvalStatus.NOT_EVALUATED,
        perInvocationResults: [],
      });
      expect(client.requests).toEqual([]);
    });

    it.each([
      'multi_turn_trajectory_quality_v1',
      'multi_turn_tool_use_quality_v1',
    ])(
      'sends %s with an empty agents map when no invocation has appDetails',
      async (metricName) => {
        const client = new FakeEvaluationClient([{score: 1}]);
        const facade = new MultiTurnVertexAiEvalFacade({
          threshold: 0.5,
          metricName,
          client,
        });

        const result = await facade.evaluateInvocations([
          textInvocation({query: 'one', response: 'a'}),
          textInvocation({query: 'two', response: 'b'}),
        ]);

        expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
        expect(client.requests).toHaveLength(1);
        expect(client.requests[0].instance?.agentEvalData?.agents).toEqual({});
      },
    );

    it('collects the agents of the invocations that have appDetails', async () => {
      const client = new FakeEvaluationClient([{score: 1}]);
      const facade = new MultiTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'multi_turn_tool_use_quality_v1',
        client,
      });

      await facade.evaluateInvocations([
        textInvocation({query: 'one'}),
        textInvocation({query: 'two', appDetails: APP_DETAILS}),
      ]);

      expect(
        Object.keys(client.requests[0].instance?.agentEvalData?.agents ?? {}),
      ).toEqual(['root_agent']);
    });

    it('evaluates task success without appDetails', async () => {
      const client = new FakeEvaluationClient([{score: 1}]);
      const facade = new MultiTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'multi_turn_task_success_v1',
        client,
      });

      const result = await facade.evaluateInvocations([
        textInvocation({query: 'one'}),
      ]);

      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
      expect(client.requests[0].instance?.agentEvalData?.agents).toEqual({});
    });

    it('throws when the invocation lists differ in length', async () => {
      const client = new FakeEvaluationClient();
      const facade = new MultiTurnVertexAiEvalFacade({
        threshold: 0.5,
        metricName: 'multi_turn_task_success_v1',
        client,
      });

      await expect(
        facade.evaluateInvocations([textInvocation({query: 'one'})], []),
      ).rejects.toThrow(
        'actualInvocations and expectedInvocations must have the same length; got 1 and 0.',
      );
    });
  });
});
