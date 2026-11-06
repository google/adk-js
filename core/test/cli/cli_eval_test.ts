/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseTool,
  Context,
  convertEvalSetToSchema,
  createEvent,
  DEFAULT_CRITERIA,
  EVAL_SESSION_ID_PREFIX,
  EvalCase,
  EvalCaseResult,
  EvalEntry,
  EvalResult,
  EvalSet,
  EvalStatus,
  Event,
  getEvaluationCriteriaOrDefault,
  getRootAgent,
  InMemorySessionService,
  InputValidationError,
  InvocationContext,
  LlmAgent,
  loadEvalSetFromFile,
  LocalEvalSetResultsManager,
  LocalEvalSetsManager,
  MISSING_EVAL_DEPENDENCIES_MESSAGE,
  NotFoundError,
  parseAndGetEvalsToRun,
  RESPONSE_MATCH_SCORE_KEY,
  runEvals,
  TOOL_TRAJECTORY_SCORE_KEY,
  tryGetResetFunc,
} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  createEvalSetResult,
  parseEvalSetResultJson,
  validatePathSegment,
} from '../../src/cli/cli_eval.js';

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

    it('does not split Windows drive letters from the evalset file path', () => {
      const parsed = parseAndGetEvalsToRun([
        'C:\\evals\\set1.evalset.json',
        'D:\\evals\\set2.evalset.json:case_a,case_b',
        '/tmp/set3.evalset.json:case_c',
      ]);

      expect(parsed).toEqual({
        'C:\\evals\\set1.evalset.json': [],
        'D:\\evals\\set2.evalset.json': ['case_a', 'case_b'],
        '/tmp/set3.evalset.json': ['case_c'],
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
      expect(results[0].eval_set_id).toBe('sample.evalset.json');
      expect(results[0].final_eval_status).toBe(EvalStatus.PASSED);
      expect(results[0].session_id.startsWith(EVAL_SESSION_ID_PREFIX)).toBe(
        true,
      );
      expect(results[0].session_details).toBeDefined();
      expect(results[0].session_details?.id).toBe(results[0].session_id);
      expect(results[0].session_details?.appName).toBe('eval_app');

      expect(results[1].eval_id).toBe('failing_case');
      expect(results[1].eval_set_id).toBe('sample.evalset.json');
      expect(results[1].final_eval_status).toBe(EvalStatus.FAILED);
      expect(results[1].session_details).toBeDefined();
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

  describe('LocalEvalSetResultsManager', () => {
    const sampleCaseResult: EvalCaseResult = {
      eval_set_id: 'test_eval_set',
      eval_id: 'case1',
      final_eval_status: EvalStatus.PASSED,
      overall_eval_metric_results: [],
      eval_metric_result_per_invocation: [],
      session_id: 'session1',
      user_id: 'user1',
    };

    it('saves an eval set result to the eval history folder and loads it back', () => {
      const agentsDir = path.join(tempDir, 'agents');
      fs.mkdirSync(agentsDir, {recursive: true});
      const manager = new LocalEvalSetResultsManager(agentsDir);

      const saved = manager.saveEvalSetResult({
        appName: 'test_app',
        evalSetId: 'test_eval_set',
        evalCaseResults: [sampleCaseResult],
      });

      const expectedFile = path.join(
        agentsDir,
        'test_app',
        '.adk',
        'eval_history',
        `${saved.evalSetResultName}.evalset_result.json`,
      );
      expect(fs.existsSync(expectedFile)).toBe(true);

      const retrieved = manager.getEvalSetResult(
        'test_app',
        saved.evalSetResultName,
      );
      expect(retrieved.evalSetResultId).toBe(saved.evalSetResultId);
      expect(retrieved.evalSetId).toBe('test_eval_set');
      expect(retrieved.evalCaseResults).toHaveLength(1);
      expect(retrieved.evalCaseResults[0].eval_id).toBe('case1');

      const stored = JSON.parse(fs.readFileSync(expectedFile, 'utf-8'));
      expect(Object.keys(stored).sort()).toEqual([
        'creationTimestamp',
        'evalCaseResults',
        'evalSetId',
        'evalSetResultId',
        'evalSetResultName',
      ]);
    });

    it('saves and loads eval case results with optional deprecated fields populated', () => {
      const agentsDir = path.join(tempDir, 'agents_deprecated');
      fs.mkdirSync(agentsDir, {recursive: true});
      const manager = new LocalEvalSetResultsManager(agentsDir);

      const legacyCaseResult: EvalCaseResult = {
        eval_set_file: 'legacy_file',
        eval_set_id: 'test_eval_set',
        eval_id: 'case_legacy',
        final_eval_status: EvalStatus.PASSED,
        eval_metric_results: [],
        overall_eval_metric_results: [],
        eval_metric_result_per_invocation: [],
        session_id: 'session_legacy',
        user_id: 'user_legacy',
      };

      const saved = manager.saveEvalSetResult({
        appName: 'test_app',
        evalSetId: 'test_eval_set',
        evalCaseResults: [legacyCaseResult],
      });

      const retrieved = manager.getEvalSetResult(
        'test_app',
        saved.evalSetResultName,
      );
      expect(retrieved.evalCaseResults[0].eval_set_file).toBe('legacy_file');
      expect(retrieved.evalCaseResults[0].eval_metric_results).toEqual([]);
      expect(retrieved.evalCaseResults[0].eval_set_id).toBe('test_eval_set');
    });

    it('loads a legacy eval set result file that holds double-encoded JSON', () => {
      const agentsDir = path.join(tempDir, 'agents');
      const historyDir = path.join(
        agentsDir,
        'test_app',
        '.adk',
        'eval_history',
      );
      fs.mkdirSync(historyDir, {recursive: true});
      const manager = new LocalEvalSetResultsManager(agentsDir);

      const resultObj = createEvalSetResult({
        appName: 'test_app',
        evalSetId: 'test_eval_set',
        evalCaseResults: [sampleCaseResult],
        creationTimestamp: 123.0,
      });
      const filePath = path.join(
        historyDir,
        `${resultObj.evalSetResultName}.evalset_result.json`,
      );
      const doubleEncoded = JSON.stringify(JSON.stringify(resultObj));
      fs.writeFileSync(filePath, doubleEncoded, 'utf-8');

      const retrieved = manager.getEvalSetResult(
        'test_app',
        resultObj.evalSetResultName,
      );
      expect(retrieved).toEqual(resultObj);
    });

    it('throws NotFoundError when the eval set result does not exist', () => {
      const manager = new LocalEvalSetResultsManager(tempDir);
      expect(() =>
        manager.getEvalSetResult('test_app', 'non_existent_id'),
      ).toThrow(NotFoundError);
    });

    it('lists only the eval set results saved for the requested app', () => {
      const agentsDir = path.join(tempDir, 'agents');
      const manager = new LocalEvalSetResultsManager(agentsDir);

      expect(manager.listEvalSetResults('test_app')).toEqual([]);

      const first = manager.saveEvalSetResult({
        appName: 'test_app',
        evalSetId: 'set_a',
        evalCaseResults: [sampleCaseResult],
      });
      const second = manager.saveEvalSetResult({
        appName: 'test_app',
        evalSetId: 'set_b',
        evalCaseResults: [sampleCaseResult],
      });
      manager.saveEvalSetResult({
        appName: 'other_app',
        evalSetId: 'set_c',
        evalCaseResults: [sampleCaseResult],
      });

      const listed = manager.listEvalSetResults('test_app');
      expect(new Set(listed)).toEqual(
        new Set([first.evalSetResultName, second.evalSetResultName]),
      );
    });

    it.each(['', '.', '..', 'foo/bar', 'foo\\bar', 'C:evil', 'foo\x00bar'])(
      'rejects invalid path segment %j across save, get, and list',
      (invalid) => {
        const manager = new LocalEvalSetResultsManager(tempDir);
        expect(() => validatePathSegment(invalid, 'test_field')).toThrow(
          InputValidationError,
        );
        expect(() =>
          manager.saveEvalSetResult({
            appName: invalid,
            evalSetId: 'valid_set',
            evalCaseResults: [sampleCaseResult],
          }),
        ).toThrow(InputValidationError);
        expect(() =>
          manager.saveEvalSetResult({
            appName: 'valid_app',
            evalSetId: invalid,
            evalCaseResults: [sampleCaseResult],
          }),
        ).toThrow(InputValidationError);
        expect(() => manager.getEvalSetResult(invalid, 'valid_result')).toThrow(
          InputValidationError,
        );
        expect(() => manager.getEvalSetResult('valid_app', invalid)).toThrow(
          InputValidationError,
        );
        expect(() => manager.listEvalSetResults(invalid)).toThrow(
          InputValidationError,
        );
      },
    );

    it('replaces slashes in the eval set result name', () => {
      const created = createEvalSetResult({
        appName: 'my/app',
        evalSetId: 'my_set',
        evalCaseResults: [],
        creationTimestamp: 456,
      });
      expect(created.evalSetResultName).toBe('my_app_my_set_456');
    });

    it('parses snake_case keys and rejects incomplete or invalid JSON', () => {
      const snakePayload = JSON.stringify({
        eval_set_result_id: 'app_set_1',
        eval_set_result_name: 'app_set_1',
        eval_set_id: 'set_1',
        eval_case_results: [sampleCaseResult],
        creation_timestamp: 100,
      });
      const parsed = parseEvalSetResultJson(snakePayload);
      expect(parsed.evalSetResultId).toBe('app_set_1');
      expect(parsed.evalSetId).toBe('set_1');
      expect(parsed.creationTimestamp).toBe(100);

      expect(() =>
        parseEvalSetResultJson('{"unexpected_field": "value"}'),
      ).toThrow(/missing evalSetResultId or evalSetId/);
      expect(() => parseEvalSetResultJson('not valid json {')).toThrow();
    });
  });

  describe('convertEvalSetToSchema', () => {
    // reference: test_convert_eval_set_to_pydanctic_schema_complete
    it('converts a complete legacy JSON eval set into an EvalSet object', () => {
      const evalSetId = 'test_eval_set';
      const evalSetInJsonFormat = [
        {
          name: 'roll_17_sided_dice_twice',
          data: [
            {
              query: 'What can you do?',
              expected_tool_use: [],
              expected_intermediate_agent_responses: [],
              reference:
                'I can roll dice of different sizes and check if a number is prime. I can also use multiple tools in parallel.\n',
            },
            {
              query: 'Roll a 17 sided dice twice for me',
              expected_tool_use: [
                {tool_name: 'roll_die', tool_input: {sides: 17}},
                {tool_name: 'roll_die', tool_input: {sides: 17}},
              ],
              expected_intermediate_agent_responses: [
                {author: 'agent1', text: 'thought1'},
              ],
              reference:
                'I have rolled a 17 sided die twice. The first roll was 13 and the second roll was 4.\n',
            },
          ],
          initial_session: {
            state: {},
            app_name: 'hello_world',
            user_id: 'user',
          },
        },
      ];

      const evalSet = convertEvalSetToSchema(evalSetId, evalSetInJsonFormat);

      expect(evalSet.evalSetId).toBe(evalSetId);
      expect(evalSet.evalCases).toHaveLength(1);
      expect(evalSet.evalCases[0].evalId).toBe('roll_17_sided_dice_twice');
      expect(evalSet.evalCases[0].conversation).toHaveLength(2);
      expect(evalSet.evalCases[0].sessionInput?.appName).toBe('hello_world');
      expect(
        evalSet.evalCases[0].conversation[1].intermediateData?.toolUses,
      ).toHaveLength(2);
      expect(
        evalSet.evalCases[0].conversation[1].intermediateData
          ?.intermediateResponses,
      ).toHaveLength(1);
    });

    // reference: test_convert_eval_set_to_pydanctic_schema_minimal
    it('converts a minimal legacy JSON eval set with only query and reference', () => {
      const evalSetId = 'test_eval_set';
      const evalSetInJsonFormat = [
        {
          name: 'minimal_case',
          data: [{query: 'Hello', reference: 'World'}],
        },
      ];

      const evalSet = convertEvalSetToSchema(evalSetId, evalSetInJsonFormat);

      expect(evalSet.evalSetId).toBe(evalSetId);
      expect(evalSet.evalCases).toHaveLength(1);
      expect(evalSet.evalCases[0].evalId).toBe('minimal_case');
      expect(evalSet.evalCases[0].conversation).toHaveLength(1);
      expect(
        evalSet.evalCases[0].conversation[0].userContent.parts?.[0]?.text,
      ).toBe('Hello');
      expect(
        evalSet.evalCases[0].conversation[0].finalResponse?.parts?.[0]?.text,
      ).toBe('World');
    });

    // reference: test_convert_eval_set_to_pydanctic_schema_empty_tool_use_and_intermediate_responses
    it('converts a legacy JSON eval set with empty tool uses and intermediate responses', () => {
      const evalSetId = 'test_eval_set';
      const evalSetInJsonFormat = [
        {
          name: 'empty_lists',
          data: [
            {
              query: 'Test',
              reference: 'Test Ref',
              expected_tool_use: [],
              expected_intermediate_agent_responses: [],
            },
          ],
        },
      ];

      const evalSet = convertEvalSetToSchema(evalSetId, evalSetInJsonFormat);

      expect(evalSet.evalSetId).toBe(evalSetId);
      expect(evalSet.evalCases).toHaveLength(1);
      expect(
        evalSet.evalCases[0].conversation[0].intermediateData?.toolUses,
      ).toHaveLength(0);
      expect(
        evalSet.evalCases[0].conversation[0].intermediateData
          ?.intermediateResponses,
      ).toHaveLength(0);
    });

    // reference: test_convert_eval_set_to_pydanctic_schema_empty_initial_session
    it('leaves sessionInput undefined when initial session is an empty object', () => {
      const evalSetId = 'test_eval_set';
      const evalSetInJsonFormat = [
        {
          name: 'empty_session',
          data: [{query: 'Test', reference: 'Test Ref'}],
          initial_session: {},
        },
      ];

      const evalSet = convertEvalSetToSchema(evalSetId, evalSetInJsonFormat);

      expect(evalSet.evalSetId).toBe(evalSetId);
      expect(evalSet.evalCases[0].sessionInput).toBeUndefined();
    });

    // reference: test_convert_eval_set_to_pydanctic_schema_invalid_data
    it('throws InputValidationError when legacy eval set data has invalid field types', () => {
      const evalSetId = 'test_eval_set';
      const evalSetInJsonFormat = [
        {
          name: 123,
          data: [
            {
              query: 456,
              reference: 789,
              expected_tool_use: [{tool_name: 123, tool_input: 456}],
              expected_intermediate_agent_responses: [{author: 123, text: 456}],
            },
          ],
          initial_session: {
            state: 'invalid',
            app_name: 123,
            user_id: 456,
          },
        },
      ];

      expect(() =>
        convertEvalSetToSchema(evalSetId, evalSetInJsonFormat),
      ).toThrow(InputValidationError);
    });
  });

  describe('loadEvalSetFromFile', () => {
    // reference: test_load_eval_set_from_file_new_format
    it('loads a structured EvalSet JSON file directly', () => {
      const evalSet: EvalSet = {
        evalSetId: 'new_format_eval_set',
        evalCases: [
          {
            evalId: 'new_format_case',
            conversation: [
              {
                invocationId: 'inv-123',
                userContent: {parts: [{text: 'New Format Query'}]},
                finalResponse: {parts: [{text: 'New Format Reference'}]},
              },
            ],
          },
        ],
      };
      const filePath = path.join(tempDir, 'new_format.json');
      fs.writeFileSync(filePath, JSON.stringify(evalSet), 'utf-8');

      const loadedEvalSet = loadEvalSetFromFile(
        filePath,
        'new_format_eval_set',
      );

      expect(loadedEvalSet).toEqual(evalSet);
    });

    // reference: test_load_eval_set_from_file_old_format
    it('loads a legacy array JSON file and converts it to an EvalSet', () => {
      const oldFormatJson = [
        {
          name: 'old_format_case',
          data: [
            {query: 'Old Format Query', reference: 'Old Format Reference'},
          ],
        },
      ];
      const filePath = path.join(tempDir, 'old_format.json');
      fs.writeFileSync(filePath, JSON.stringify(oldFormatJson), 'utf-8');

      const loadedEvalSet = loadEvalSetFromFile(
        filePath,
        'old_format_eval_set',
      );

      expect(loadedEvalSet.evalSetId).toBe('old_format_eval_set');
      expect(loadedEvalSet.name).toBe('old_format_eval_set');
      expect(loadedEvalSet.evalCases).toHaveLength(1);
      expect(loadedEvalSet.evalCases[0].evalId).toBe('old_format_case');
      expect(loadedEvalSet.evalCases[0].conversation).toHaveLength(1);
      expect(loadedEvalSet.evalCases[0].conversation[0].userContent).toEqual({
        role: 'user',
        parts: [{text: 'Old Format Query'}],
      });
      expect(loadedEvalSet.evalCases[0].conversation[0].finalResponse).toEqual({
        role: 'model',
        parts: [{text: 'Old Format Reference'}],
      });
      expect(
        loadedEvalSet.evalCases[0].conversation[0].intermediateData,
      ).toEqual({
        toolUses: [],
        intermediateResponses: [],
      });
    });

    // reference: test_load_eval_set_from_file_nonexistent_file
    it('throws when the eval set file does not exist', () => {
      expect(() =>
        loadEvalSetFromFile(
          path.join(tempDir, 'nonexistent_file.json'),
          'test_eval_set',
        ),
      ).toThrow();
    });

    // reference: test_load_eval_set_from_file_invalid_json
    it('throws SyntaxError when the file contains invalid JSON', () => {
      const filePath = path.join(tempDir, 'invalid.json');
      fs.writeFileSync(filePath, 'invalid json', 'utf-8');

      expect(() => loadEvalSetFromFile(filePath, 'test_eval_set')).toThrow(
        SyntaxError,
      );
    });

    // reference: test_load_eval_set_from_file_invalid_data
    it('throws InputValidationError when JSON matches neither structured nor legacy format', () => {
      const filePath = path.join(tempDir, 'invalid_data.json');
      fs.writeFileSync(filePath, '{"invalid": "data"}', 'utf-8');

      expect(() => loadEvalSetFromFile(filePath, 'test_eval_set')).toThrow(
        InputValidationError,
      );
    });
  });

  describe('LocalEvalSetsManager', () => {
    // reference: test_local_eval_sets_manager_get_eval_set_success
    // reference: test_local_eval_sets_manager_get_eval_set_not_found
    // reference: test_local_eval_sets_manager_create_eval_set_success
    it('creates an eval set on disk and returns undefined when an eval set is missing', () => {
      const manager = new LocalEvalSetsManager(tempDir);

      expect(manager.getEvalSet('test_app', 'missing_set')).toBeUndefined();

      const created = manager.createEvalSet('test_app', 'test_eval_set');
      expect(created.evalSetId).toBe('test_eval_set');
      expect(created.name).toBe('test_eval_set');
      expect(created.evalCases).toEqual([]);

      const loaded = manager.getEvalSet('test_app', 'test_eval_set');
      expect(loaded).toEqual(created);

      expect(() => manager.createEvalSet('test_app', 'test_eval_set')).toThrow(
        InputValidationError,
      );
    });

    // reference: test_local_eval_sets_manager_create_eval_set_invalid_id
    it('rejects an invalid eval set ID when creating an eval set', () => {
      const manager = new LocalEvalSetsManager(tempDir);

      expect(() => manager.createEvalSet('test_app', 'invalid-id')).toThrow(
        /Invalid Eval Set ID/,
      );
    });

    // reference: test_local_eval_sets_manager_list_eval_sets_success
    it('lists sorted eval set IDs for an app and ignores non-evalset files', () => {
      const manager = new LocalEvalSetsManager(tempDir);
      expect(manager.listEvalSets('test_app')).toEqual([]);

      const appDir = path.join(tempDir, 'test_app');
      fs.mkdirSync(appDir, {recursive: true});
      fs.writeFileSync(
        path.join(appDir, 'eval_set_2.evalset.json'),
        '[]',
        'utf-8',
      );
      fs.writeFileSync(
        path.join(appDir, 'eval_set_1.evalset.json'),
        '[]',
        'utf-8',
      );
      fs.writeFileSync(
        path.join(appDir, 'not_an_eval_set.txt'),
        'hello',
        'utf-8',
      );

      expect(manager.listEvalSets('test_app')).toEqual([
        'eval_set_1',
        'eval_set_2',
      ]);
    });

    // reference: test_local_eval_sets_manager_add_eval_case_success
    // reference: test_local_eval_sets_manager_add_eval_case_eval_set_not_found
    // reference: test_local_eval_sets_manager_add_eval_case_eval_case_id_exists
    // reference: test_local_eval_sets_manager_get_eval_case_success
    // reference: test_local_eval_sets_manager_get_eval_case_eval_set_not_found
    // reference: test_local_eval_sets_manager_get_eval_case_eval_case_not_found
    it('adds and retrieves eval cases and rejects missing sets or duplicate case IDs', () => {
      const manager = new LocalEvalSetsManager(tempDir);
      const evalCase: EvalCase = {
        evalId: 'test_eval_case',
        conversation: [],
      };

      expect(
        manager.getEvalCase('test_app', 'test_eval_set', 'test_eval_case'),
      ).toBeUndefined();

      expect(() =>
        manager.addEvalCase('test_app', 'test_eval_set', evalCase),
      ).toThrow(NotFoundError);

      manager.createEvalSet('test_app', 'test_eval_set');
      expect(
        manager.getEvalCase('test_app', 'test_eval_set', 'test_eval_case'),
      ).toBeUndefined();

      manager.addEvalCase('test_app', 'test_eval_set', evalCase);
      expect(
        manager.getEvalCase('test_app', 'test_eval_set', 'test_eval_case'),
      ).toEqual(evalCase);

      expect(() =>
        manager.addEvalCase('test_app', 'test_eval_set', evalCase),
      ).toThrow(/Eval id `test_eval_case` already exists/);
    });

    // reference: test_local_eval_sets_manager_update_eval_case_success
    // reference: test_local_eval_sets_manager_update_eval_case_eval_case_not_found
    it('updates an existing eval case and throws NotFoundError when missing', () => {
      const manager = new LocalEvalSetsManager(tempDir);
      const initialCase: EvalCase = {
        evalId: 'test_eval_case',
        conversation: [],
        creationTimestamp: 456,
      };
      const updatedCase: EvalCase = {
        evalId: 'test_eval_case',
        conversation: [
          {
            invocationId: 'inv-1',
            userContent: {role: 'user', parts: [{text: 'Updated query'}]},
          },
        ],
        creationTimestamp: 123,
      };

      expect(() =>
        manager.updateEvalCase('test_app', 'test_eval_set', updatedCase),
      ).toThrow(NotFoundError);

      manager.createEvalSet('test_app', 'test_eval_set');
      expect(() =>
        manager.updateEvalCase('test_app', 'test_eval_set', updatedCase),
      ).toThrow(
        'Eval Set `test_eval_set` or Eval id `test_eval_case` not found.',
      );

      manager.addEvalCase('test_app', 'test_eval_set', initialCase);
      manager.updateEvalCase('test_app', 'test_eval_set', updatedCase);

      expect(
        manager.getEvalCase('test_app', 'test_eval_set', 'test_eval_case'),
      ).toEqual(updatedCase);
    });

    // reference: test_local_eval_sets_manager_delete_eval_case_success
    // reference: test_local_eval_sets_manager_delete_eval_case_eval_case_not_found
    it('deletes an existing eval case and throws NotFoundError when missing', () => {
      const manager = new LocalEvalSetsManager(tempDir);
      const evalCase: EvalCase = {
        evalId: 'test_eval_case',
        conversation: [],
      };

      expect(() =>
        manager.deleteEvalCase('test_app', 'test_eval_set', 'test_eval_case'),
      ).toThrow(NotFoundError);

      manager.createEvalSet('test_app', 'test_eval_set');
      expect(() =>
        manager.deleteEvalCase('test_app', 'test_eval_set', 'test_eval_case'),
      ).toThrow(
        'Eval Set `test_eval_set` or Eval id `test_eval_case` not found.',
      );

      manager.addEvalCase('test_app', 'test_eval_set', evalCase);
      manager.deleteEvalCase('test_app', 'test_eval_set', 'test_eval_case');

      expect(
        manager.getEvalCase('test_app', 'test_eval_set', 'test_eval_case'),
      ).toBeUndefined();
      expect(
        manager.getEvalSet('test_app', 'test_eval_set')?.evalCases,
      ).toEqual([]);
    });

    it('runs evaluations against structured EvalCase items saved by LocalEvalSetsManager', async () => {
      const manager = new LocalEvalSetsManager(tempDir);
      manager.createEvalSet('eval_app', 'structured_set');
      manager.addEvalCase('eval_app', 'structured_set', {
        evalId: 'structured_case',
        conversation: [
          {
            invocationId: 'inv-1',
            userContent: {role: 'user', parts: [{text: 'please use_tool now'}]},
            finalResponse: {
              role: 'model',
              parts: [{text: 'Echo: please use_tool now'}],
            },
            intermediateData: {
              toolUses: [{name: 'lookup_item', args: {id: 42}}],
              intermediateResponses: [],
            },
          },
        ],
        sessionInput: {
          appName: 'eval_app',
          userId: 'eval_user',
          state: {},
        },
      });

      const evalSet = manager.getEvalSet('eval_app', 'structured_set');
      expect(evalSet).toBeDefined();

      const agent = new DeterministicEvalAgent();
      const results: EvalResult[] = [];
      for await (const res of runEvals({
        evalCasesByEvalSetId: {structured_set: evalSet?.evalCases ?? []},
        rootAgent: agent,
      })) {
        results.push(res);
      }

      expect(results).toHaveLength(1);
      expect(results[0].eval_id).toBe('structured_case');
      expect(results[0].final_eval_status).toBe(EvalStatus.PASSED);
    });
  });
});
