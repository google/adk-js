/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LocalEvalSetResultsManager,
  LogLevel,
  logToTmpFolder,
  setupAdkLogger,
} from '@google/adk';
import {Command, CommanderError} from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {createProgram} from '../../src/cli/cli.js';
import {createAgent} from '../../src/cli/cli_create.js';
import {runAgent} from '../../src/cli/cli_run.js';
import {deployToAgentEngine} from '../../src/cli/deploy/cli_deploy_agent_engine.js';
import {deployToCloudRun} from '../../src/cli/deploy/cli_deploy_cloud_run.js';
import {runIntegrationTests} from '../../src/integration/run_integration_tests.js';
import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {version} from '../../src/version.js';

vi.mock('../../src/server/adk_api_server', () => {
  return {
    AdkApiServer: vi.fn(function () {
      return {
        start: vi.fn(),
      };
    }),
  };
});

vi.mock('../../src/cli/cli_create', () => ({
  createAgent: vi.fn(),
}));

vi.mock('../../src/cli/deploy/cli_deploy_agent_engine', () => ({
  deployToAgentEngine: vi.fn(),
}));

vi.mock('../../src/cli/deploy/cli_deploy_cloud_run', () => ({
  deployToCloudRun: vi.fn(),
}));

vi.mock('../../src/integration/run_integration_tests', () => ({
  runIntegrationTests: vi.fn(),
}));

vi.mock('../../src/cli/cli_run', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../../src/integration/run_integration_tests', () => ({
  runIntegrationTests: vi.fn(),
}));

vi.mock('../../src/version', () => ({
  version: '1.0.0-test',
}));

vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    setupAdkLogger: vi.fn(),
    logToTmpFolder: vi.fn(),
  };
});

/**
 * Under `exitOverride()` commander reports every termination by throwing a
 * `CommanderError`, the only error out of `parseAsync` that carries an
 * `exitCode`: 0 for a clean exit such as `--help`, non-zero for a usage error.
 * There is no `commander.exit` code to compare against.
 */
function isCleanCommanderExit(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'exitCode' in error &&
    error.exitCode === 0
  );
}

describe('CLI Entrypoint', () => {
  let program: ReturnType<typeof createProgram>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    program = createProgram();
    program.exitOverride();
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  const parse = async (args: string[]) => {
    try {
      process.argv = args;
      await program.parseAsync(['node', 'cli_entrypoint.js', ...args]);
    } catch (e: unknown) {
      if (!isCleanCommanderExit(e)) {
        throw e;
      }
    }
  };

  describe('command: version', () => {
    it('should output version', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await parse(['--version']);
      expect(logSpy).toHaveBeenCalledWith('1.0.0-test');

      await parse(['-v']);
      expect(logSpy).toHaveBeenCalledWith('1.0.0-test');
    });
  });

  describe('parse helper: commander exits', () => {
    beforeEach(() => {
      // Commander writes help to stdout and usage errors to stderr; keep the
      // suite silent.
      program.configureOutput({
        writeOut: () => {},
        writeErr: () => {},
      });
    });

    it('treats a clean commander exit as success', async () => {
      await expect(parse(['--help'])).resolves.toBeUndefined();
    });

    it('surfaces a non-zero commander exit for an unknown option', async () => {
      await expect(parse(['--definitely-not-an-option'])).rejects.toMatchObject(
        {
          code: 'commander.unknownOption',
          exitCode: 1,
        },
      );
    });
  });

  describe('command: web', () => {
    it('should start AdkApiServer with default options', async () => {
      await parse(['web']);

      expect(setupAdkLogger).toHaveBeenCalledWith(LogLevel.INFO);
      // Verify AdkApiServer called. Since we mock it, we can check.
      expect(AdkApiServer).toHaveBeenCalled();
      const args = (AdkApiServer as unknown as Mock).mock.calls[0]?.[0];
      expect(args).toBeDefined();
      expect(args.port).toBe(8000);
      expect(args.serveDebugUI).toBe(true);
      expect(args.a2a).toBe(false);

      // Verify start() called
      const instance = (AdkApiServer as unknown as Mock).mock.results[0].value;
      expect(instance.start).toHaveBeenCalled();
    });

    it('honours --log_level debug', async () => {
      // LogLevel.DEBUG is 0, so the previous `|| LogLevel.INFO` fallback
      // discarded it and the flag did nothing.
      await parse(['web', '--log_level', 'debug']);
      expect(setupAdkLogger).toHaveBeenCalledWith(LogLevel.DEBUG);
    });

    it('falls back to INFO for an unrecognised --log_level', async () => {
      await parse(['web', '--log_level', 'not-a-level']);
      expect(setupAdkLogger).toHaveBeenCalledWith(LogLevel.INFO);
    });

    it('should pass options to AdkApiServer', async () => {
      await parse([
        'web',
        '--host',
        '0.0.0.0',
        '--port',
        '9090',
        '--verbose',
        '--allow_origins',
        'http://example.com',
        '--otel_to_cloud',
      ]);

      expect(setupAdkLogger).toHaveBeenCalledWith(LogLevel.DEBUG);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args).toMatchObject({
        host: '0.0.0.0',
        port: 9090,
        serveDebugUI: true,
        allowOrigins: 'http://example.com',
        otelToCloud: true,
      });
    });

    it('reads --otel_to_cloud false as false', async () => {
      await parse(['web', '--otel_to_cloud', 'false']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.otelToCloud).toBe(false);
    });

    it('should handle artifact service uri', async () => {
      await parse(['web', '--artifact_service_uri', 'gs://my-bucket']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.artifactService).toBeDefined();
    });

    it('should start AdkApiServer with a2a: true when --a2a is set', async () => {
      await parse(['web', '--a2a']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.a2a).toBe(true);
    });

    it('should start AdkApiServer with a2a: true when --a2a true is set', async () => {
      await parse(['web', '--a2a', 'true']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.a2a).toBe(true);
    });

    it('should pass a2aAuthToken when --a2a_auth_token is set', async () => {
      await parse(['web', '--a2a', '--a2a_auth_token', 'tok']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.a2aAuthToken).toBe('tok');
    });
  });

  describe('command: api_server', () => {
    it('should start AdkApiServer with serveDebugUI: false', async () => {
      await parse(['api_server']);

      expect(setupAdkLogger).toHaveBeenCalledWith(LogLevel.INFO);
      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.serveDebugUI).toBe(false);
      expect(args.a2a).toBe(false);

      const instance = (AdkApiServer as unknown as Mock).mock.results[0].value;
      expect(instance.start).toHaveBeenCalled();
    });

    it('honours --log_level debug', async () => {
      await parse(['api_server', '--log_level', 'debug']);
      expect(setupAdkLogger).toHaveBeenCalledWith(LogLevel.DEBUG);
    });

    it('should start AdkApiServer with a2a: true when --a2a is set', async () => {
      await parse(['api_server', '--a2a']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.a2a).toBe(true);
    });

    it('should pass a2aAuthToken when --a2a_auth_token is set', async () => {
      await parse(['api_server', '--a2a', '--a2a_auth_token', 'tok']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.a2aAuthToken).toBe('tok');
    });
  });

  describe('command: create', () => {
    it('should call createAgent with default args', async () => {
      await parse(['create']);

      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'adk_agent',
          forceYes: false,
        }),
      );
    });

    it('should call createAgent with provided args', async () => {
      await parse([
        'create',
        'my-agent',
        '--yes',
        '--model',
        'gemini-pro',
        '--api_key',
        'key',
        '--project',
        'proj',
        '--region',
        'us-central1',
        '--language',
        'ts',
      ]);

      expect(createAgent).toHaveBeenCalledWith({
        agentName: 'my-agent',
        forceYes: true,
        model: 'gemini-pro',
        apiKey: 'key',
        project: 'proj',
        region: 'us-central1',
        language: 'ts',
      });
    });
  });

  describe('command: run', () => {
    it('exits non-zero when the run fails', async () => {
      (runAgent as Mock).mockRejectedValueOnce(
        new Error('Agent file /nope/agent.ts does not exists'),
      );
      // The handler sets process.exitCode rather than calling process.exit, so
      // async stderr (the error being surfaced) is not truncated on the way out.
      const originalExitCode = process.exitCode;

      await parse(['run', '/nope/agent.ts']);

      expect(process.exitCode).toBe(1);
      process.exitCode = originalExitCode;
    });

    it('exits non-zero without running the agent when the log file cannot be created', async () => {
      (logToTmpFolder as Mock).mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied');
      });
      const originalExitCode = process.exitCode;

      await parse(['run', 'agent.ts']);

      expect(process.exitCode).toBe(1);
      expect(runAgent).not.toHaveBeenCalled();
      process.exitCode = originalExitCode;
    });

    it('reads --otel_to_cloud=false as false', async () => {
      await parse(['run', 'agent.ts', '--otel_to_cloud=false']);

      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({otelToCloud: false}),
      );
    });

    it('should call runAgent with required args', async () => {
      await parse(['run', 'agent.ts']);

      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentPath: 'agent.ts',
          saveSession: false,
          otelToCloud: false,
        }),
      );
    });

    it.each([
      ['before the path', ['run', '--verbose', 'agent.ts']],
      ['after the path', ['run', 'agent.ts', '--verbose']],
    ])('takes --verbose %s', async (_name, args) => {
      await parse(args);

      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({agentPath: 'agent.ts'}),
      );
      expect(logToTmpFolder).toHaveBeenCalledWith({level: LogLevel.DEBUG});
    });

    it('should pass all options to runAgent', async () => {
      await parse([
        'run',
        'agent.ts',
        '--save_session',
        '--session_id',
        'sess-123',
        '--replay',
        'replay.json',
        '--resume',
        'resume.json',
        '--otel_to_cloud',
      ]);

      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentPath: 'agent.ts',
          saveSession: true,
          sessionId: 'sess-123',
          inputFile: 'replay.json',
          savedSessionFile: 'resume.json',
          otelToCloud: true,
        }),
      );
    });
  });

  // Minification mangles identifiers and line numbers, so local commands must
  // leave it off to keep an agent's stack traces readable; only deployment
  // bundles, where size matters, turn it on.
  describe('agent bundle minification', () => {
    it.each([
      ['run', ['run', 'agent.ts'], () => runAgent],
      ['web', ['web'], () => AdkApiServer],
      ['api_server', ['api_server'], () => AdkApiServer],
    ])('is off for %s', async (_name, args, target) => {
      await parse(args);

      const call = (target() as unknown as Mock).mock.calls[0][0];
      expect(call.agentFileLoadOptions.minify).toBe(false);
    });

    it.each([
      ['deploy cloud_run', ['deploy', 'cloud_run'], () => deployToCloudRun],
      [
        'deploy agent_engine',
        ['deploy', 'agent_engine'],
        () => deployToAgentEngine,
      ],
    ])('is on for %s', async (_name, args, target) => {
      await parse(args);

      const call = (target() as unknown as Mock).mock.calls[0][0];
      expect(call.agentFileLoadOptions.minify).toBe(true);
    });
  });

  describe('command: deploy cloud_run', () => {
    it('should call deployToCloudRun with defaults', async () => {
      await parse(['deploy', 'cloud_run']);

      expect(deployToCloudRun).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 8000,
          serviceName: 'adk-default-service-name',
          adkVersion: version,
          withUi: false,
        }),
      );
    });

    it('should leave tempFolder unset so no temp directory is created eagerly', async () => {
      await parse(['deploy', 'cloud_run']);

      expect(
        (deployToCloudRun as Mock).mock.calls[0][0].tempFolder,
      ).toBeUndefined();
    });

    it('should pass args to deployToCloudRun including unknowns', async () => {
      const args = [
        'deploy',
        'cloud_run',
        './my-agent-path',
        '--port=8080',
        '--project=my-proj',
        '--region=us-west1',
        '--service_name=my-service',
        '--with_ui',
        '--adk_version=1.0.0',
        '--extra-arg=foo',
      ];

      try {
        await parse(args);
      } catch (e) {
        console.log(e);
      }

      expect((deployToCloudRun as Mock).mock.calls[0][0]).toMatchObject({
        agentPath: expect.stringContaining('my-agent-path'),
        project: 'my-proj',
        region: 'us-west1',
        serviceName: 'my-service',
        port: 8080,
        withUi: true,
        adkVersion: '1.0.0',
        extraGcloudArgs: ['--extra-arg=foo'],
      });
    });

    it('should pass a2a flag to deployToCloudRun when --a2a is set', async () => {
      await parse(['deploy', 'cloud_run', '--a2a']);

      expect((deployToCloudRun as Mock).mock.calls[0][0]).toMatchObject({
        a2a: true,
      });
    });

    it('should pass a2aAuthToken to deployToCloudRun when --a2a_auth_token is set', async () => {
      await parse([
        'deploy',
        'cloud_run',
        './my-agent-path',
        '--project=my-proj',
        '--region=us-west1',
        '--a2a',
        '--a2a_auth_token=tok',
      ]);

      const args = (deployToCloudRun as Mock).mock.calls[0][0];
      expect(args).toMatchObject({a2a: true, a2aAuthToken: 'tok'});
      // A recognised flag must not also be passed through as an unknown one,
      // which gcloud would reject.
      expect(args.extraGcloudArgs).toEqual([]);
    });
  });

  describe('command: deploy agent_engine', () => {
    it('should call deployToAgentEngine with defaults', async () => {
      await parse(['deploy', 'agent_engine']);

      expect(deployToAgentEngine).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 8080,
          adkVersion: version,
          withUi: false,
        }),
      );
    });

    it('should leave tempFolder unset so no temp directory is created eagerly', async () => {
      await parse(['deploy', 'agent_engine']);

      expect(
        (deployToAgentEngine as Mock).mock.calls[0][0].tempFolder,
      ).toBeUndefined();
    });

    it('should pass args to deployToAgentEngine', async () => {
      const args = [
        'deploy',
        'agent_engine',
        './my-agent-path',
        '--project=my-proj',
        '--region=us-west1',
        '--display_name=my-display-name',
        '--description=my-description',
        '--with_ui',
        '--adk_version=1.0.0',
      ];

      await parse(args);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        agentPath: expect.stringContaining('my-agent-path'),
        project: 'my-proj',
        region: 'us-west1',
        displayName: 'my-display-name',
        description: 'my-description',
        port: 8080,
        withUi: true,
        adkVersion: '1.0.0',
      });
    });

    it('should pass a2a flag to deployToAgentEngine when --a2a is set', async () => {
      await parse(['deploy', 'agent_engine', '--a2a']);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        a2a: true,
      });
    });

    it('should pass agent_engine_id to deployToAgentEngine when --agent_engine_id is set', async () => {
      await parse(['deploy', 'agent_engine', '--agent_engine_id', '12345']);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        agentEngineId: '12345',
      });
    });

    it('should pass min_instances and max_instances to deployToAgentEngine when set', async () => {
      await parse([
        'deploy',
        'agent_engine',
        '--min_instances',
        '2',
        '--max_instances',
        '5',
      ]);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        minInstances: 2,
        maxInstances: 5,
      });
    });

    it('should leave minInstances and maxInstances undefined when not set', async () => {
      await parse(['deploy', 'agent_engine']);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        minInstances: undefined,
        maxInstances: undefined,
      });
    });

    it('should pass staging_bucket to deployToAgentEngine when --staging_bucket is set', async () => {
      await parse(['deploy', 'agent_engine', '--staging_bucket', 'my-bucket']);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        stagingBucket: 'my-bucket',
      });
    });

    it('should leave stagingBucket unset when --staging_bucket is absent', async () => {
      await parse(['deploy', 'agent_engine']);

      expect(
        (deployToAgentEngine as Mock).mock.calls[0][0].stagingBucket,
      ).toBeUndefined();
    });

    it('should not consume the agents_dir positional when --staging_bucket is set', async () => {
      await parse([
        'deploy',
        'agent_engine',
        '--staging_bucket=my-bucket',
        './my-agent-path',
      ]);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        agentPath: expect.stringContaining('my-agent-path'),
        stagingBucket: 'my-bucket',
      });
    });

    it('should pass otelToCloud to deployToAgentEngine when --otel_to_cloud is set', async () => {
      await parse(['deploy', 'agent_engine', '--otel_to_cloud']);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        otelToCloud: true,
      });
    });

    it('should pass otelToCloud to deployToAgentEngine when --otel_to_cloud=true is set', async () => {
      await parse(['deploy', 'agent_engine', '--otel_to_cloud=true']);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        otelToCloud: true,
      });
    });

    it('should leave otelToCloud unset when --otel_to_cloud is absent', async () => {
      await parse(['deploy', 'agent_engine']);

      expect(
        (deployToAgentEngine as Mock).mock.calls[0][0].otelToCloud,
      ).toBeUndefined();
    });

    it('should leave otelToCloud unset when --otel_to_cloud=false is set', async () => {
      await parse(['deploy', 'agent_engine', '--otel_to_cloud=false']);

      expect(
        (deployToAgentEngine as Mock).mock.calls[0][0].otelToCloud,
      ).toBeUndefined();
    });
  });

  describe('deploy failures', () => {
    it.each([
      ['deploy cloud_run', ['deploy', 'cloud_run'], () => deployToCloudRun],
      [
        'deploy agent_engine',
        ['deploy', 'agent_engine'],
        () => deployToAgentEngine,
      ],
    ])(
      '%s exits non-zero when the deployment fails',
      async (_name, args, target) => {
        (target() as Mock).mockRejectedValueOnce(new Error('gcloud failed'));
        const originalExitCode = process.exitCode;

        await parse(args);

        expect(process.exitCode).toBe(1);
        process.exitCode = originalExitCode;
      },
    );
  });

  describe('command: integration conformance', () => {
    it('waits for the integration tests to finish', async () => {
      let finished = false;
      (runIntegrationTests as Mock).mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        finished = true;
      });

      await parse(['integration', 'conformance', '--force']);

      expect(runIntegrationTests).toHaveBeenCalledWith(
        expect.objectContaining({forceRunAll: true}),
      );
      expect(finished).toBe(true);
    });
  });

  describe('command: deploy reasoning_engine', () => {
    it('should call deployToAgentEngine for reasoning_engine', async () => {
      await parse(['deploy', 'reasoning_engine']);

      expect(deployToAgentEngine).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 8080,
          adkVersion: version,
          withUi: false,
        }),
      );
    });

    it('should pass agent_engine_id to deployToAgentEngine when --agent_engine_id is set', async () => {
      await parse(['deploy', 'reasoning_engine', '--agent_engine_id', '12345']);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        agentEngineId: '12345',
      });
    });

    it('should pass staging_bucket to deployToAgentEngine when --staging_bucket is set', async () => {
      await parse([
        'deploy',
        'reasoning_engine',
        '--staging_bucket',
        'my-bucket',
      ]);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        stagingBucket: 'my-bucket',
      });
    });

    it('should pass otelToCloud to deployToAgentEngine when --otel_to_cloud is set', async () => {
      await parse(['deploy', 'reasoning_engine', '--otel_to_cloud']);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        otelToCloud: true,
      });
    });

    it('should leave otelToCloud unset when --otel_to_cloud is absent', async () => {
      await parse(['deploy', 'reasoning_engine']);

      expect(
        (deployToAgentEngine as Mock).mock.calls[0][0].otelToCloud,
      ).toBeUndefined();
    });
  });
  describe('additional CLI options and eval command', () => {
    it('maps --log_level warning and critical to WARN and ERROR', async () => {
      await parse(['web', '--log_level', 'warning']);
      expect(setupAdkLogger).toHaveBeenCalledWith(LogLevel.WARN);

      await parse(['web', '--log_level', 'critical']);
      expect(setupAdkLogger).toHaveBeenCalledWith(LogLevel.ERROR);
    });

    it('invokes logToTmpFolder unconditionally with the configured level on run', async () => {
      await parse(['run', 'agent.ts']);
      expect(logToTmpFolder).toHaveBeenCalledWith({level: LogLevel.INFO});

      await parse(['run', 'agent.ts', '--log_level', 'debug']);
      expect(logToTmpFolder).toHaveBeenCalledWith({level: LogLevel.DEBUG});
    });

    it('passes --app_name and --with_cloud_trace to deployToCloudRun', async () => {
      await parse([
        'deploy',
        'cloud_run',
        'my_agent',
        '--app_name',
        'custom_app',
        '--with_cloud_trace',
      ]);

      expect(deployToCloudRun).toHaveBeenCalledWith(
        expect.objectContaining({
          appName: 'custom_app',
          otelToCloud: true,
        }),
      );
    });

    it('runs the eval command, prints a summary, and saves the eval set result', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-cli-eval-'));
      const agentDir = path.join(tempDir, 'my_eval_app');
      fs.mkdirSync(agentDir, {recursive: true});

      const agentFile = path.join(agentDir, 'agent.js');
      fs.writeFileSync(
        agentFile,
        [
          `import {BaseAgent, createEvent} from '@google/adk';`,
          `class EvalAgent extends BaseAgent {`,
          `  constructor() { super({name: 'my_eval_agent'}); }`,
          `  async *runAsyncImpl(ctx) {`,
          `    const text = ctx.userContent?.parts?.[0]?.text ?? '';`,
          `    yield createEvent({invocationId: ctx.invocationId, author: this.name, content: {role: 'model', parts: [{text: 'Echo: ' + text}]}});`,
          `  }`,
          `  async *runLiveImpl(ctx) { yield* this.runAsyncImpl(ctx); }`,
          `}`,
          `export const rootAgent = new EvalAgent();`,
        ].join('\n'),
        'utf-8',
      );

      const evalSetFile = path.join(tempDir, 'sample_set.evalset.json');
      fs.writeFileSync(
        evalSetFile,
        JSON.stringify([
          {
            name: 'pass_case',
            data: [
              {
                query: 'ping',
                expected_tool_use: [],
                expected_intermediate_agent_responses: [],
                reference: 'Echo: ping',
              },
            ],
            initial_session: {
              app_name: 'my_eval_app',
              user_id: 'user_1',
              state: {},
            },
          },
          {
            name: 'fail_case',
            data: [
              {
                query: 'ping',
                expected_tool_use: [{tool_name: 'missing', tool_input: {}}],
                expected_intermediate_agent_responses: [],
                reference: 'totally different response',
              },
            ],
          },
        ]),
        'utf-8',
      );

      const stdoutChunks: string[] = [];
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: string | Uint8Array) => {
          stdoutChunks.push(String(chunk));
          return true;
        });

      try {
        await parse(['eval', agentDir, evalSetFile]);

        const output = stdoutChunks.join('');
        expect(output).toContain('Eval Run Summary');
        expect(output).toContain('Tests passed: 1');
        expect(output).toContain('Tests failed: 1');

        const manager = new LocalEvalSetResultsManager(tempDir);
        const resultIds = manager.listEvalSetResults('my_eval_app');
        expect(resultIds).toHaveLength(1);

        const storedResult = manager.getEvalSetResult(
          'my_eval_app',
          resultIds[0],
        );
        expect(storedResult.evalSetId).toBe('sample_set');
        expect(storedResult.evalCaseResults).toHaveLength(2);
        expect(storedResult.evalCaseResults[0].sessionDetails).toBeDefined();
      } finally {
        stdoutSpy.mockRestore();
        fs.rmSync(tempDir, {recursive: true, force: true});
      }
    });

    it('stubs tool calls with mock_tool_output from a legacy eval set file', async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'adk-cli-eval-mock-'),
      );
      const agentDir = path.join(tempDir, 'mock_eval_app');
      fs.mkdirSync(agentDir, {recursive: true});

      // The agent reports what the tool callback returns. Only a stubbed call
      // returns the mock output, so the case passes only when the stub works.
      fs.writeFileSync(
        path.join(agentDir, 'agent.js'),
        [
          `import {BaseAgent, LlmAgent, createEvent} from '@google/adk';`,
          `const toolAgent = new LlmAgent({name: 'tool_agent', model: 'gemini-2.5-flash'});`,
          `class MockCheckingAgent extends BaseAgent {`,
          `  constructor() { super({name: 'mock_checking_agent', subAgents: [toolAgent]}); }`,
          `  async *runAsyncImpl(ctx) {`,
          `    const cb = toolAgent.beforeToolCallback;`,
          `    const output = typeof cb === 'function' ? await cb({tool: {name: 'lookup_item'}, args: {id: 42}, context: {}}) : undefined;`,
          `    yield createEvent({invocationId: ctx.invocationId, author: this.name, content: {role: 'model', parts: [{functionCall: {name: 'lookup_item', args: {id: 42}}}]}});`,
          `    yield createEvent({invocationId: ctx.invocationId, author: this.name, content: {role: 'model', parts: [{text: 'Result: ' + JSON.stringify(output)}]}});`,
          `  }`,
          `  async *runLiveImpl(ctx) { yield* this.runAsyncImpl(ctx); }`,
          `}`,
          `export const rootAgent = new MockCheckingAgent();`,
        ].join('\n'),
        'utf-8',
      );

      const evalSetFile = path.join(tempDir, 'mock_set.evalset.json');
      fs.writeFileSync(
        evalSetFile,
        JSON.stringify([
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
        ]),
        'utf-8',
      );

      const stdoutChunks: string[] = [];
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: string | Uint8Array) => {
          stdoutChunks.push(String(chunk));
          return true;
        });

      try {
        await parse(['eval', agentDir, evalSetFile]);

        const output = stdoutChunks.join('');
        expect(output).toContain('Tests passed: 1');
        expect(output).toContain('Tests failed: 0');
      } finally {
        stdoutSpy.mockRestore();
        fs.rmSync(tempDir, {recursive: true, force: true});
      }
    });

    it('runs the eval command against a structured EvalSet file with case filtering', async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'adk-cli-eval-structured-'),
      );
      const agentDir = path.join(tempDir, 'my_eval_app');
      fs.mkdirSync(agentDir, {recursive: true});

      const agentFile = path.join(agentDir, 'agent.js');
      fs.writeFileSync(
        agentFile,
        [
          `import {BaseAgent, createEvent} from '@google/adk';`,
          `class EvalAgent extends BaseAgent {`,
          `  constructor() { super({name: 'my_eval_agent'}); }`,
          `  async *runAsyncImpl(ctx) {`,
          `    const text = ctx.userContent?.parts?.[0]?.text ?? '';`,
          `    yield createEvent({invocationId: ctx.invocationId, author: this.name, content: {role: 'model', parts: [{text: 'Echo: ' + text}]}});`,
          `  }`,
          `  async *runLiveImpl(ctx) { yield* this.runAsyncImpl(ctx); }`,
          `}`,
          `export const rootAgent = new EvalAgent();`,
        ].join('\n'),
        'utf-8',
      );

      const evalSetFile = path.join(tempDir, 'structured_set.evalset.json');
      fs.writeFileSync(
        evalSetFile,
        JSON.stringify({
          evalSetId: 'structured_set',
          name: 'structured_set',
          evalCases: [
            {
              evalId: 'selected_case',
              conversation: [
                {
                  invocationId: 'inv-1',
                  userContent: {role: 'user', parts: [{text: 'ping'}]},
                  finalResponse: {
                    role: 'model',
                    parts: [{text: 'Echo: ping'}],
                  },
                },
              ],
              sessionInput: {
                appName: 'my_eval_app',
                userId: 'user_1',
                state: {},
              },
            },
            {
              evalId: 'skipped_case',
              conversation: [
                {
                  invocationId: 'inv-2',
                  userContent: {role: 'user', parts: [{text: 'other'}]},
                  finalResponse: {
                    role: 'model',
                    parts: [{text: 'wrong'}],
                  },
                },
              ],
            },
          ],
        }),
        'utf-8',
      );

      const stdoutChunks: string[] = [];
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: string | Uint8Array) => {
          stdoutChunks.push(String(chunk));
          return true;
        });

      try {
        await parse(['eval', agentDir, `${evalSetFile}:selected_case`]);

        const output = stdoutChunks.join('');
        expect(output).toContain('Eval Run Summary');
        expect(output).toContain('Tests passed: 1');
        expect(output).toContain('Tests failed: 0');

        const manager = new LocalEvalSetResultsManager(tempDir);
        const resultIds = manager.listEvalSetResults('my_eval_app');
        expect(resultIds).toHaveLength(1);

        const storedResult = manager.getEvalSetResult(
          'my_eval_app',
          resultIds[0],
        );
        expect(storedResult.evalSetId).toBe('structured_set');
        expect(storedResult.evalCaseResults).toHaveLength(1);
        expect(storedResult.evalCaseResults[0].evalId).toBe('selected_case');
      } finally {
        stdoutSpy.mockRestore();
        fs.rmSync(tempDir, {recursive: true, force: true});
      }
    });
  });

  describe('--otel_to_cloud parsing', () => {
    it.each([
      ['run', ['run', 'agent.ts'], () => runAgent],
      ['web', ['web'], () => AdkApiServer],
      ['api_server', ['api_server'], () => AdkApiServer],
    ])(
      'passes otelToCloud: false for %s with =false',
      async (_name, args, target) => {
        await parse([...args, '--otel_to_cloud=false']);

        const call = (target() as unknown as Mock).mock.calls[0][0];
        expect(call.otelToCloud).toBe(false);
      },
    );

    it.each([
      ['run', ['run', 'agent.ts'], () => runAgent],
      ['web', ['web'], () => AdkApiServer],
      ['api_server', ['api_server'], () => AdkApiServer],
    ])(
      'passes otelToCloud: true for %s with =true',
      async (_name, args, target) => {
        await parse([...args, '--otel_to_cloud=true']);

        const call = (target() as unknown as Mock).mock.calls[0][0];
        expect(call.otelToCloud).toBe(true);
      },
    );
  });

  describe('failure exit codes', () => {
    beforeEach(() => {
      process.exitCode = undefined;
    });

    it('run reports a log setup failure and does not run the agent', async () => {
      (logToTmpFolder as Mock).mockImplementationOnce(() => {
        throw new Error('EACCES');
      });

      await expect(parse(['run', 'agent.ts'])).resolves.toBeUndefined();

      expect(process.exitCode).toBe(1);
      expect(runAgent).not.toHaveBeenCalled();
    });

    it('create sets exitCode 1 when createAgent fails', async () => {
      (createAgent as Mock).mockRejectedValueOnce(new Error('create failed'));

      await parse(['create', 'my-agent', '--yes']);

      expect(process.exitCode).toBe(1);
    });

    it('deploy cloud_run sets exitCode 1 when the deployment fails', async () => {
      (deployToCloudRun as Mock).mockRejectedValueOnce(
        new Error('deploy failed'),
      );

      await parse(['deploy', 'cloud_run']);

      expect(process.exitCode).toBe(1);
    });

    it.each([['agent_engine'], ['reasoning_engine']])(
      'deploy %s sets exitCode 1 when the deployment fails',
      async (command) => {
        (deployToAgentEngine as Mock).mockRejectedValueOnce(
          new Error('deploy failed'),
        );

        await parse(['deploy', command]);

        expect(process.exitCode).toBe(1);
      },
    );
  });

  describe('command: integration conformance', () => {
    beforeEach(() => {
      process.exitCode = undefined;
    });

    it('awaits runIntegrationTests with the parsed options', async () => {
      await parse([
        'integration',
        'conformance',
        '--agents_dir',
        'agents',
        '--tests_dir',
        'tests',
      ]);

      expect(runIntegrationTests).toHaveBeenCalledWith({
        agentsDir: 'agents',
        testsDir: 'tests',
        forceRunAll: false,
      });
      expect(process.exitCode).toBeUndefined();
    });

    it('sets exitCode 1 when runIntegrationTests rejects', async () => {
      (runIntegrationTests as Mock).mockRejectedValueOnce(
        new Error('conformance failed'),
      );

      await expect(
        parse(['integration', 'conformance']),
      ).resolves.toBeUndefined();

      expect(process.exitCode).toBe(1);
    });
  });

  describe('--bundle help text', () => {
    it('does not claim that bundling minifies', () => {
      const runCommand = program.commands.find((c) => c.name() === 'run');
      const bundleOption = runCommand?.options.find(
        (o) => o.long === '--bundle',
      );

      expect(bundleOption).toBeDefined();
      expect(bundleOption?.description).not.toContain(
        'Bundling also minifies the result.',
      );
      expect(runCommand?.helpInformation()).not.toContain('minifies');
    });
  });
});

describe('usage errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const runWithUsageError = async (args: string[]) => {
    const program = createProgram();
    let stderr = '';
    // A subcommand inherits neither of these once it exists: exitOverride()
    // is a per-command property, and configureOutput() replaces the shared
    // object instead of mutating it. Without the second call the subcommand
    // writes to the real stderr and calls the real process.exit(), which kills
    // the worker.
    const capture = (command: Command) => {
      command.configureOutput({
        writeErr: (str) => {
          stderr += str;
        },
      });
      command.exitOverride();
    };
    capture(program);
    program.commands.forEach(capture);

    let error: CommanderError | undefined;
    try {
      await program.parseAsync(['node', 'cli_entrypoint.js', ...args]);
    } catch (e: unknown) {
      // Rethrow anything an action handler raised, so a real failure is
      // reported as itself instead of as a usage error.
      if (!(e instanceof CommanderError)) {
        throw e;
      }
      error = e;
    }
    return {stderr, error};
  };

  it('prints the full run help after a missing agent path', async () => {
    const {stderr} = await runWithUsageError(['run']);

    expect(stderr).toContain("error: missing required argument 'agent'");
    expect(stderr).toContain('Usage: ADK CLI run [options] <agent>');
    expect(stderr).toContain('Agent file path (.js or .ts)');
    expect(stderr).toContain('--save_session [boolean]');
  });

  it('keeps the exit code and the error code of a missing agent path', async () => {
    const {error} = await runWithUsageError(['run']);

    expect(error?.exitCode).toBe(1);
    expect(error?.code).toBe('commander.missingArgument');
  });

  it('does not run the agent when the agent path is missing', async () => {
    await runWithUsageError(['run']);

    expect(runAgent).not.toHaveBeenCalled();
  });

  it('prints no help when the run succeeds', async () => {
    const {stderr, error} = await runWithUsageError(['run', 'agent.ts']);

    expect(error).toBeUndefined();
    expect(stderr).not.toContain('Usage:');
    expect(runAgent).toHaveBeenCalled();
  });

  it('prints the full run help after an unknown option', async () => {
    const {stderr} = await runWithUsageError([
      'run',
      'agent.ts',
      '--definitely-not-an-option',
    ]);

    expect(stderr).toContain('unknown option');
    expect(stderr).toContain('Usage: ADK CLI run');
  });
});
