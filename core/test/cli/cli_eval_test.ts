/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
  parseAndGetEvalsToRun,
  RESPONSE_MATCH_SCORE_KEY,
  runEvals,
  TOOL_TRAJECTORY_SCORE_KEY,
  tryGetResetFunc,
} from '@google/adk';
import * as fs from 'node:fs';
import {createRequire} from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const DIST_ESM_CLI_EVAL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../dist/esm/cli/cli_eval.js',
);
const DIST_CJS_CLI_EVAL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../dist/cjs/cli/cli_eval.js',
);

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

    it('resolves agent.mjs and agent.cjs inside a directory and supports nested agent exports', async () => {
      const mjsDir = path.join(tempDir, 'mjs_agent');
      fs.mkdirSync(mjsDir, {recursive: true});
      fs.writeFileSync(
        path.join(mjsDir, 'agent.mjs'),
        [
          `const brand = Symbol.for('google.adk.baseAgent');`,
          `export const agent = {`,
          `  rootAgent: { [brand]: true, name: 'nested_mjs_agent', subAgents: [] },`,
          `  resetData() { return 'nested-reset'; },`,
          `};`,
        ].join('\n'),
      );

      const loadedMjs = await getRootAgent(mjsDir);
      expect(loadedMjs.name).toBe('nested_mjs_agent');
      const mjsReset = await tryGetResetFunc(mjsDir);
      expect(mjsReset?.()).toBe('nested-reset');

      const cjsDir = path.join(tempDir, 'cjs_agent');
      fs.mkdirSync(cjsDir, {recursive: true});
      fs.writeFileSync(
        path.join(cjsDir, 'index.cjs'),
        [
          `const brand = Symbol.for('google.adk.baseAgent');`,
          `module.exports = {`,
          `  root_agent: { [brand]: true, name: 'cjs_index_agent', subAgents: [] },`,
          `  reset_data() { return 'cjs-reset'; },`,
          `};`,
        ].join('\n'),
      );

      const loadedCjs = await getRootAgent(cjsDir);
      expect(loadedCjs.name).toBe('cjs_index_agent');
      const cjsReset = await tryGetResetFunc(cjsDir);
      expect(cjsReset?.()).toBe('cjs-reset');
    });

    it.skipIf(
      !fs.existsSync(DIST_ESM_CLI_EVAL) || !fs.existsSync(DIST_CJS_CLI_EVAL),
    )(
      'loads .mjs and .cjs agent modules through the built ESM and CJS packages where import() is lowered to require()',
      async () => {
        const mjsFile = path.join(tempDir, 'built_agent.mjs');
        fs.writeFileSync(
          mjsFile,
          [
            `const brand = Symbol.for('google.adk.baseAgent');`,
            `export const rootAgent = { [brand]: true, name: 'built_mjs_agent', subAgents: [] };`,
            `export function reset_data() { return 'built-mjs-reset'; }`,
          ].join('\n'),
        );

        const cjsFile = path.join(tempDir, 'built_agent.cjs');
        fs.writeFileSync(
          cjsFile,
          [
            `const brand = Symbol.for('google.adk.baseAgent');`,
            `module.exports = {`,
            `  agent: {`,
            `    rootAgent: { [brand]: true, name: 'built_cjs_agent', subAgents: [] },`,
            `    reset_data() { return 'built-cjs-reset'; },`,
            `  },`,
            `};`,
          ].join('\n'),
        );

        const distEsm = (await import(
          pathToFileURL(DIST_ESM_CLI_EVAL).href
        )) as {
          getRootAgent: typeof getRootAgent;
          tryGetResetFunc: typeof tryGetResetFunc;
        };
        const esmAgent = await distEsm.getRootAgent(mjsFile);
        expect(esmAgent.name).toBe('built_mjs_agent');
        const esmReset = await distEsm.tryGetResetFunc(mjsFile);
        expect(esmReset?.()).toBe('built-mjs-reset');

        const require = createRequire(import.meta.url);
        const distCjs = require(DIST_CJS_CLI_EVAL) as {
          getRootAgent: typeof getRootAgent;
          tryGetResetFunc: typeof tryGetResetFunc;
        };
        const cjsAgent = await distCjs.getRootAgent(cjsFile);
        expect(cjsAgent.name).toBe('built_cjs_agent');
        const cjsReset = await distCjs.tryGetResetFunc(cjsFile);
        expect(cjsReset?.()).toBe('built-cjs-reset');
      },
    );

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
});
