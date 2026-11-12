/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InMemoryMemoryService,
  LocalEvalSetResultsManager,
  LogLevel,
  logToTmpFolder,
  setupAdkLogger,
  VertexAiMemoryBankService,
  VertexAiRagMemoryService,
} from '@google/adk';
import {Command, CommanderError} from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {
  adkServicesOptions,
  createProgram,
  getMemoryServiceFromOptions,
} from '../../src/cli/cli.js';
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
    vi.unstubAllEnvs();
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

    it('should handle memory service uri in web command', async () => {
      await parse(['web', '--memory_service_uri', 'memory://']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.memoryService).toBeInstanceOf(InMemoryMemoryService);
    });

    it('should handle rag memory service uri in web command', async () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
      await parse(['web', '--memory_service_uri', 'rag://test-corpus']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.memoryService).toBeInstanceOf(VertexAiRagMemoryService);
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

    it('should handle memory service uri in api_server command', async () => {
      await parse(['api_server', '--memory_service_uri', 'memory://']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.memoryService).toBeInstanceOf(InMemoryMemoryService);
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

    it('should pass memoryService to runAgent when --memory_service_uri is set', async () => {
      await parse(['run', 'agent.ts', '--memory_service_uri', 'memory://']);

      const runCall = (runAgent as unknown as Mock).mock.calls[0][0];
      expect(runCall.memoryService).toBeInstanceOf(InMemoryMemoryService);
    });

    it('should pass VertexAiRagMemoryService to runAgent when --memory_service_uri is rag://', async () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
      await parse([
        'run',
        'agent.ts',
        '--memory_service_uri',
        'rag://test-corpus',
      ]);

      const runCall = (runAgent as unknown as Mock).mock.calls[0][0];
      expect(runCall.memoryService).toBeInstanceOf(VertexAiRagMemoryService);
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

    it('should pass memoryServiceUri to deployToCloudRun when --memory_service_uri is set', async () => {
      await parse([
        'deploy',
        'cloud_run',
        './my-agent-path',
        '--memory_service_uri=rag://my-corpus',
      ]);

      expect((deployToCloudRun as Mock).mock.calls[0][0]).toMatchObject({
        memoryServiceUri: 'rag://my-corpus',
      });
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

    it('should pass memoryServiceUri to deployToAgentEngine when --memory_service_uri is set', async () => {
      await parse([
        'deploy',
        'agent_engine',
        './my-agent-path',
        '--memory_service_uri=rag://my-corpus',
      ]);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        memoryServiceUri: 'rag://my-corpus',
      });
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

  describe('kebab-case option flags and command aliases', () => {
    describe('command: web with kebab-case flags', () => {
      it('parses --log-level, --allow-origins, --session-service-uri, --a2a-auth-token, and --otel-to-cloud', async () => {
        await parse([
          'web',
          '--log-level',
          'debug',
          '--allow-origins',
          'http://example.com',
          '--session-service-uri',
          'memory://',
          '--memory-service-uri',
          'memory://',
          '--a2a-auth-token',
          'tok-web',
          '--otel-to-cloud',
        ]);

        expect(setupAdkLogger).toHaveBeenCalledWith(LogLevel.DEBUG);
        const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
        expect(args).toMatchObject({
          allowOrigins: 'http://example.com',
          a2aAuthToken: 'tok-web',
          otelToCloud: true,
        });
        expect(args.sessionService).toBeDefined();
        expect(args.memoryService).toBeInstanceOf(InMemoryMemoryService);
      });

      it('parses kebab-case flags using =value format', async () => {
        await parse([
          'web',
          '--log-level=warn',
          '--allow-origins=http://custom.origin',
          '--session-service-uri=memory://',
          '--a2a-auth-token=tok-web-eq',
          '--otel-to-cloud=false',
        ]);

        expect(setupAdkLogger).toHaveBeenCalledWith(LogLevel.WARN);
        const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
        expect(args).toMatchObject({
          allowOrigins: 'http://custom.origin',
          a2aAuthToken: 'tok-web-eq',
          otelToCloud: false,
        });
      });
    });

    describe('command: api-server alias and flags', () => {
      it('starts AdkApiServer using api-server alias and parses kebab-case flags', async () => {
        await parse([
          'api-server',
          '--log-level=debug',
          '--allow-origins=http://example.com',
          '--session-service-uri=memory://',
          '--a2a-auth-token=tok-api',
        ]);

        expect(setupAdkLogger).toHaveBeenCalledWith(LogLevel.DEBUG);
        const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
        expect(args).toMatchObject({
          serveDebugUI: false,
          allowOrigins: 'http://example.com',
          a2aAuthToken: 'tok-api',
        });
        expect(args.sessionService).toBeDefined();
      });

      it('parses kebab-case flags with space on api_server command', async () => {
        await parse([
          'api_server',
          '--log-level',
          'debug',
          '--allow-origins',
          'http://example.org',
          '--a2a-auth-token',
          'tok-api-2',
        ]);

        expect(setupAdkLogger).toHaveBeenCalledWith(LogLevel.DEBUG);
        const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
        expect(args).toMatchObject({
          serveDebugUI: false,
          allowOrigins: 'http://example.org',
          a2aAuthToken: 'tok-api-2',
        });
      });
    });

    describe('command: create with --api-key', () => {
      it('passes --api-key in both space and equals forms', async () => {
        await parse([
          'create',
          'my-agent-1',
          '--api-key',
          'secret-key-1',
          '--yes',
        ]);
        expect(createAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            agentName: 'my-agent-1',
            apiKey: 'secret-key-1',
          }),
        );

        await parse([
          'create',
          'my-agent-2',
          '--api-key=secret-key-2',
          '--yes',
        ]);
        expect(createAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            agentName: 'my-agent-2',
            apiKey: 'secret-key-2',
          }),
        );
      });
    });

    describe('command: run with kebab-case flags', () => {
      it('passes --save-session and --session-id with space separated values', async () => {
        await parse([
          'run',
          'agent.ts',
          '--save-session',
          '--session-id',
          'sess-space',
          '--log-level',
          'debug',
          '--otel-to-cloud',
        ]);

        expect(logToTmpFolder).toHaveBeenCalledWith({level: LogLevel.DEBUG});
        expect(runAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            saveSession: true,
            sessionId: 'sess-space',
            otelToCloud: true,
          }),
        );
      });

      it('passes --save-session and --session-id with equals separated values', async () => {
        await parse([
          'run',
          'agent.ts',
          '--save-session=true',
          '--session-id=sess-eq',
          '--log-level=warn',
          '--otel-to-cloud=false',
        ]);

        expect(logToTmpFolder).toHaveBeenCalledWith({level: LogLevel.WARN});
        expect(runAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            saveSession: true,
            sessionId: 'sess-eq',
            otelToCloud: false,
          }),
        );
      });
    });

    describe('command: eval with kebab-case flags', () => {
      it('parses --config-file-path and --print-detailed-results', async () => {
        const tempDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'adk-cli-eval-kebab-'),
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

        const evalSetFile = path.join(tempDir, 'kebab_set.evalset.json');
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
          ]),
          'utf-8',
        );

        const configFile = path.join(tempDir, 'config.json');
        fs.writeFileSync(
          configFile,
          JSON.stringify({criteria: {response_match_score: 0.5}}),
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
          await parse([
            'eval',
            agentDir,
            evalSetFile,
            '--config-file-path',
            configFile,
            '--print-detailed-results',
          ]);

          const output = stdoutChunks.join('');
          expect(output).toContain('Eval Run Summary');
          expect(output).toContain('Tests passed: 1');

          await parse([
            'eval',
            agentDir,
            evalSetFile,
            `--config-file-path=${configFile}`,
            '--print-detailed-results=true',
          ]);
        } finally {
          stdoutSpy.mockRestore();
          fs.rmSync(tempDir, {recursive: true, force: true});
        }
      });
    });

    describe('command: deploy cloud_run and cloud-run alias with kebab-case flags', () => {
      it('supports cloud-run subcommand alias and kebab-case options', async () => {
        await parse([
          'deploy',
          'cloud-run',
          './my-agent-path',
          '--service-name=custom-svc',
          '--app-name=custom-app',
          '--temp-folder=/tmp/custom-temp',
          '--with-cloud-trace',
          '--adk-version=2.0.0',
          '--with-ui',
        ]);

        expect(deployToCloudRun).toHaveBeenCalledWith(
          expect.objectContaining({
            serviceName: 'custom-svc',
            appName: 'custom-app',
            tempFolder: '/tmp/custom-temp',
            otelToCloud: true,
            adkVersion: '2.0.0',
            withUi: true,
          }),
        );
      });

      it('filters recognized kebab-case flags at index >= 5 out of extraGcloudArgs', async () => {
        await parse([
          'deploy',
          'cloud-run',
          './my-agent-path',
          '--project=my-proj',
          '--region=us-west1',
          '--service-name=my-svc',
          '--app-name=my-app',
          '--a2a-auth-token=tok',
          '--with-cloud-trace',
          '--extra-flag=passthrough',
        ]);

        const args = (deployToCloudRun as Mock).mock.calls[0][0];
        expect(args).toMatchObject({
          serviceName: 'my-svc',
          appName: 'my-app',
          a2aAuthToken: 'tok',
          otelToCloud: true,
          extraGcloudArgs: ['--extra-flag=passthrough'],
        });
        expect(args.extraGcloudArgs).not.toContain('--service-name=my-svc');
        expect(args.extraGcloudArgs).not.toContain('--app-name=my-app');
        expect(args.extraGcloudArgs).not.toContain('--a2a-auth-token=tok');
        expect(args.extraGcloudArgs).not.toContain('--with-cloud-trace');
      });
    });

    describe('command: deploy agent-engine and reasoning-engine aliases with kebab-case flags', () => {
      it('supports agent-engine alias and kebab-case options in =format', async () => {
        await parse([
          'deploy',
          'agent-engine',
          './my-agent-path',
          '--project=my-proj',
          '--region=us-west1',
          '--display-name=engine-disp',
          '--staging-bucket=my-bucket',
          '--temp-folder=/tmp/engine-temp',
          '--agent-engine-id=engine-456',
          '--min-instances=2',
          '--max-instances=8',
          '--with-ui',
          '--adk-version=1.2.3',
          '--otel-to-cloud=true',
        ]);

        expect(deployToAgentEngine).toHaveBeenCalledWith(
          expect.objectContaining({
            displayName: 'engine-disp',
            stagingBucket: 'my-bucket',
            tempFolder: '/tmp/engine-temp',
            agentEngineId: 'engine-456',
            minInstances: 2,
            maxInstances: 8,
            withUi: true,
            adkVersion: '1.2.3',
            otelToCloud: true,
          }),
        );
      });

      it('supports reasoning-engine alias and kebab-case options in space format', async () => {
        await parse([
          'deploy',
          'reasoning-engine',
          './my-agent-path',
          '--display-name',
          'reasoning-disp',
          '--staging-bucket',
          'reasoning-bucket',
          '--temp-folder',
          '/tmp/reasoning-temp',
          '--agent-engine-id',
          'reasoning-789',
          '--min-instances',
          '3',
          '--max-instances',
          '6',
          '--otel-to-cloud',
        ]);

        expect(deployToAgentEngine).toHaveBeenCalledWith(
          expect.objectContaining({
            displayName: 'reasoning-disp',
            stagingBucket: 'reasoning-bucket',
            tempFolder: '/tmp/reasoning-temp',
            agentEngineId: 'reasoning-789',
            minInstances: 3,
            maxInstances: 6,
            otelToCloud: true,
          }),
        );
      });
    });

    describe('command: integration conformance with kebab-case flags', () => {
      it('passes --agents-dir and --tests-dir in both space and equals formats', async () => {
        await parse([
          'integration',
          'conformance',
          '--agents-dir',
          '/path/to/agents',
          '--tests-dir',
          '/path/to/tests',
        ]);

        expect(runIntegrationTests).toHaveBeenCalledWith(
          expect.objectContaining({
            agentsDir: '/path/to/agents',
            testsDir: '/path/to/tests',
          }),
        );

        await parse([
          'integration',
          'conformance',
          '--agents-dir=/path/to/agents2',
          '--tests-dir=/path/to/tests2',
        ]);

        expect(runIntegrationTests).toHaveBeenCalledWith(
          expect.objectContaining({
            agentsDir: '/path/to/agents2',
            testsDir: '/path/to/tests2',
          }),
        );
      });
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

describe('adkServicesOptions', () => {
  it('attaches session, artifact, and memory service options to a command', () => {
    const cmd = new Command('test');
    adkServicesOptions(cmd);

    const optionFlags = cmd.options.map((opt) => opt.flags);
    expect(optionFlags).toContain(
      '--session-service-uri, --session_service_uri <string>',
    );
    expect(optionFlags).toContain(
      '--artifact-service-uri, --artifact_service_uri <string>',
    );
    expect(optionFlags).toContain(
      '--memory-service-uri, --memory_service_uri <string>',
    );
  });
});

describe('getMemoryServiceFromOptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns InMemoryMemoryService when URI is empty or memory://', () => {
    expect(getMemoryServiceFromOptions({})).toBeInstanceOf(
      InMemoryMemoryService,
    );
    expect(
      getMemoryServiceFromOptions({memoryServiceUri: 'memory://'}),
    ).toBeInstanceOf(InMemoryMemoryService);
  });

  it('returns VertexAiRagMemoryService when URI starts with rag:// and bare corpus', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-proj');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
    const service = getMemoryServiceFromOptions({
      memoryServiceUri: 'rag://test-corpus',
    });
    expect(service).toBeInstanceOf(VertexAiRagMemoryService);
  });

  it('returns VertexAiRagMemoryService when URI starts with rag:// and full resource name', () => {
    const service = getMemoryServiceFromOptions({
      memoryServiceUri:
        'rag://projects/test-proj/locations/us-central1/ragCorpora/test-corpus',
    });
    expect(service).toBeInstanceOf(VertexAiRagMemoryService);
  });

  it('rejects empty or whitespace-only rag:// URIs', () => {
    expect(() =>
      getMemoryServiceFromOptions({
        memoryServiceUri: 'rag://',
      }),
    ).toThrow('Rag corpus can not be empty.');
  });

  it('rejects malformed multi-segment rag:// URIs', () => {
    expect(() =>
      getMemoryServiceFromOptions({
        memoryServiceUri: 'rag://projects/test-proj/invalid',
      }),
    ).toThrow(/Malformed RAG corpus resource name/);
  });

  it('returns VertexAiMemoryBankService when URI is agentengine:// with short ID', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-proj');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
    const service = getMemoryServiceFromOptions({
      memoryServiceUri: 'agentengine://123',
    });
    expect(service).toBeInstanceOf(VertexAiMemoryBankService);
  });

  it('throws error when agentengine:// short ID has no GOOGLE_CLOUD_PROJECT in environment', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');
    expect(() =>
      getMemoryServiceFromOptions({
        memoryServiceUri: 'agentengine://123',
      }),
    ).toThrow('GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_LOCATION not set.');
  });

  it('loads GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION from .env when baseDir is provided', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-cli-dotenv-'));
    const childDir = path.join(tempDir, 'nested', 'sub');
    fs.mkdirSync(childDir, {recursive: true});
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'GOOGLE_CLOUD_PROJECT=dotenv-proj\nGOOGLE_CLOUD_LOCATION=us-west1\n',
      'utf-8',
    );
    const originalCwd = process.cwd();
    try {
      process.chdir(childDir);
      const service = getMemoryServiceFromOptions('agentengine://123', '.');
      expect(service).toBeInstanceOf(VertexAiMemoryBankService);
      expect(process.env['GOOGLE_CLOUD_PROJECT']).toBe('dotenv-proj');
      expect(process.env['GOOGLE_CLOUD_LOCATION']).toBe('us-west1');
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempDir, {recursive: true, force: true});
    }
  });

  it('returns VertexAiMemoryBankService when URI is agentengine:// with full resource name', () => {
    const service = getMemoryServiceFromOptions({
      memoryServiceUri:
        'agentengine://projects/test-proj/locations/us-central1/reasoningEngines/123',
    });
    expect(service).toBeInstanceOf(VertexAiMemoryBankService);
  });

  it('rejects empty or whitespace-only agentengine:// URIs', () => {
    expect(() =>
      getMemoryServiceFromOptions({
        memoryServiceUri: 'agentengine://',
      }),
    ).toThrow('Agent engine resource name or resource id cannot be empty.');
  });

  it('rejects malformed agentengine:// URIs', () => {
    expect(() =>
      getMemoryServiceFromOptions({
        memoryServiceUri: 'agentengine://projects/test-proj/invalid',
      }),
    ).toThrow(/Agent engine resource name is mal-formatted/);
  });

  it('throws error for unsupported memory service URI and redacts credentials', () => {
    expect(() =>
      getMemoryServiceFromOptions({
        memoryServiceUri: 'unsupported://user:secret@host/db',
      }),
    ).toThrow('Unsupported memory service URI: unsupported://user:***@host/db');

    expect(() =>
      getMemoryServiceFromOptions({
        memoryServiceUri: 'unsupported://host/db?access_token=secret_tok',
      }),
    ).toThrow(
      'Unsupported memory service URI: unsupported://host/db?access_token=***',
    );
  });
});
