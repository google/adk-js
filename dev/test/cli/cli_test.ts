/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, setLogLevel} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {createProgram} from '../../src/cli/cli.js';
import {createAgent} from '../../src/cli/cli_create.js';
import {deployToCloudRun} from '../../src/cli/cli_deploy.js';
import {runAgent} from '../../src/cli/cli_run.js';
import {AdkWebServer} from '../../src/server/adk_web_server.js';

vi.mock('../../src/server/adk_web_server', () => {
  return {
    AdkWebServer: vi.fn(() => ({
      start: vi.fn(),
    })),
  };
});

vi.mock('../../src/cli/cli_create', () => ({
  createAgent: vi.fn(),
}));

vi.mock('../../src/cli/cli_deploy', () => ({
  deployToCloudRun: vi.fn(),
}));

vi.mock('../../src/cli/cli_run', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../../src/version', () => ({
  version: '1.0.0-test',
}));

vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    setLogLevel: vi.fn(),
  };
});

describe('CLI Entrypoint', () => {
  let program: ReturnType<typeof createProgram>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = createProgram();
    program.exitOverride();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const parse = async (args: string[]) => {
    try {
      await program.parseAsync(['node', 'cli.js', ...args]);
    } catch (e: unknown) {
      // Catch exitOverride errors if any, but rethrow real errors
      if ((e as {code: string}).code !== 'commander.exit') {
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

  describe('command: web', () => {
    it('should start AdkWebServer with default options', async () => {
      await parse(['web']);

      expect(setLogLevel).toHaveBeenCalledWith(LogLevel.INFO);
      // Verify AdkWebServer called. Since we mock it, we can check.
      expect(AdkWebServer).toHaveBeenCalled();
      const args = (AdkWebServer as unknown as Mock).mock.calls[0]?.[0];
      expect(args).toBeDefined();
      expect(args.port).toBe(8000);
      expect(args.serveDebugUI).toBe(true);

      // Verify start() called
      const instance = (AdkWebServer as unknown as Mock).mock.results[0].value;
      expect(instance.start).toHaveBeenCalled();
    });

    it('should pass options to AdkWebServer', async () => {
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

      expect(setLogLevel).toHaveBeenCalledWith(LogLevel.DEBUG);

      const args = (AdkWebServer as unknown as Mock).mock.calls[0][0];
      expect(args).toMatchObject({
        host: '0.0.0.0',
        port: 9090,
        serveDebugUI: true,
        allowOrigins: 'http://example.com',
        otelToCloud: true,
      });
    });

    it('should handle artifact service uri', async () => {
      await parse(['web', '--artifact_service_uri', 'gs://my-bucket']);

      const args = (AdkWebServer as unknown as Mock).mock.calls[0][0];
      expect(args.artifactService).toBeDefined();
    });
  });

  describe('command: api_server', () => {
    it('should start AdkWebServer with serveDebugUI: false', async () => {
      await parse(['api_server']);

      const args = (AdkWebServer as unknown as Mock).mock.calls[0][0];
      expect(args.serveDebugUI).toBe(false);

      const instance = (AdkWebServer as unknown as Mock).mock.results[0].value;
      expect(instance.start).toHaveBeenCalled();
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

  describe('command: deploy cloud_run', () => {
    it('should call deployToCloudRun with defaults', async () => {
      await parse(['deploy', 'cloud_run']);

      expect(deployToCloudRun).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 8000,
          serviceName: 'adk-default-service-name',
          adkVersion: 'latest',
          withUi: false,
        }),
      );
    });

    it('should pass args to deployToCloudRun including unknowns', async () => {
      const originalArgv = process.argv;
      try {
        const args = [
          'deploy',
          'cloud_run',
          './my-agent',
          '--port',
          '8080',
          '--project',
          'my-proj',
          '--region',
          'us-west1',
          '--service_name',
          'my-service',
          '--with_ui',
          '--adk_version',
          '1.0.0',
          '--extra-arg',
          'foo',
        ];

        const argv = ['node', 'cli.js', ...args];
        process.argv = argv;

        await parse(args);

        expect((deployToCloudRun as Mock).mock.calls[0][0]).toMatchObject({
          project: 'my-proj',
          region: 'us-west1',
          serviceName: 'my-service',
          port: 8080,
          withUi: true,
          adkVersion: '1.0.0',
          extraGcloudArgs: [
            '8080',
            'my-proj',
            'us-west1',
            'my-service',
            '1.0.0',
            '--extra-arg',
            'foo',
          ],
        });
      } finally {
        process.argv = originalArgv;
      }
    });
  });
});
