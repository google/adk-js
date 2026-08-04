/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {
  createDockerFileContent,
  CreateDockerFileContentOptions,
  deployToCloudRun,
} from '../../src/cli/deploy/cli_deploy_cloud_run.js';
import {A2A_AUTH_TOKEN_ENV_VAR} from '../../src/server/adk_api_server.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';
import {
  createTempDir,
  isFile,
  isFolderExists,
  loadFileData,
  tryToFindFileRecursively,
} from '../../src/utils/file_utils.js';

type Callback = (error: Error | null, result?: unknown) => void;

const A2A_TOKEN = 'test-a2a-token';

const execMock = vi.fn();
const spawnMock =
  vi.fn<(cmd: string, args: string[], opts: unknown) => unknown>();

vi.mock('node:child_process', () => ({
  exec: (cmd: string, callback: Callback) => execMock(cmd, callback),
  spawn: (cmd: string, args: string[], opts: unknown) =>
    spawnMock(cmd, args, opts),
}));

vi.mock('node:fs/promises', () => {
  const mockFs = {
    cp: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  };
  return {
    ...mockFs,
    default: mockFs,
  };
});

vi.mock('../../src/utils/agent_loader.js', () => ({
  AgentLoader: vi.fn().mockImplementation(() => ({
    listAgents: vi.fn().mockResolvedValue(['agent1']),
    getAgentFile: vi.fn().mockResolvedValue({
      getFilePath: vi.fn().mockReturnValue('path/to/agent1.ts'),
    }),
    disposeAll: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/utils/file_utils.js', () => ({
  createTempDir: vi.fn(),
  isFile: vi.fn(),
  isFolderExists: vi.fn(),
  loadFileData: vi.fn(),
  saveToFile: vi.fn(),
  tryToFindFileRecursively: vi.fn(),
}));

describe('createDockerFileContent', () => {
  const defaultOptions: CreateDockerFileContentOptions = {
    appName: 'test-app',
    project: 'test-project',
    region: 'us-central1',
    port: 8080,
    withUi: false,
    logLevel: 'info',
  };

  it('should create Dockerfile content without --a2a by default', () => {
    const content = createDockerFileContent(defaultOptions);
    expect(content).not.toContain('--a2a');
  });

  it('should create Dockerfile content with --a2a when option is true', () => {
    const content = createDockerFileContent({
      ...defaultOptions,
      a2a: true,
    });
    expect(content).toContain('--a2a');
  });

  it('should use web command when withUi is true', () => {
    const content = createDockerFileContent({
      ...defaultOptions,
      withUi: true,
    });
    expect(content).toContain('npx adk web');
  });

  it('should use api_server command when withUi is false', () => {
    const content = createDockerFileContent({
      ...defaultOptions,
      withUi: false,
    });
    expect(content).toContain('npx adk api_server');
  });

  it('should include other options in adkServerOptions', () => {
    const content = createDockerFileContent({
      ...defaultOptions,
      allowOrigins: 'http://example.com',
      otelToCloud: true,
    });
    expect(content).toContain('--allow_origins=http://example.com');
    expect(content).toContain('--otel_to_cloud');
  });
});

describe('deployToCloudRun', () => {
  const defaultOptions = {
    agentPath: 'path/to/agent',
    serviceName: 'test-service',
    tempFolder: '/tmp/test-deploy',
    adkVersion: '1.0.0',
    project: 'test-project',
    region: 'us-central1',
    port: 8080,
    withUi: false,
    logLevel: 'info',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Default mock behavior
    (isFile as Mock).mockResolvedValue(false);
    (isFolderExists as Mock).mockResolvedValue(false);
    (tryToFindFileRecursively as Mock).mockResolvedValue(
      'path/to/package.json',
    );
    (loadFileData as Mock).mockResolvedValue({
      dependencies: {
        '@google/adk': '^1.0.0',
      },
    });

    (AgentLoader as Mock).mockImplementation(() => ({
      listAgents: vi.fn().mockResolvedValue(['agent1']),
      getAgentFile: vi.fn().mockResolvedValue({
        getFilePath: vi.fn().mockReturnValue('path/to/agent1.ts'),
      }),
      disposeAll: vi.fn().mockResolvedValue(undefined),
    }));

    execMock.mockImplementation((cmd: string, callback: Callback) => {
      if (cmd.includes('config get-value project')) {
        callback(null, {stdout: 'gcloud-project\n'});
      } else if (cmd.includes('config get-value run/region')) {
        callback(null, {stdout: 'gcloud-region\n'});
      } else {
        callback(null, {stdout: ''});
      }
    });

    spawnMock.mockReturnValue({
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'close') {
          process.nextTick(() => cb(0));
        }
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should deploy successfully with explicit options', async () => {
    await deployToCloudRun(defaultOptions);

    expect(spawnMock).toHaveBeenCalledWith(
      'gcloud',
      expect.arrayContaining([
        'run',
        'deploy',
        'test-service',
        '--project',
        'test-project',
        '--region',
        'us-central1',
      ]),
      expect.any(Object),
    );
    expect(fs.rm).toHaveBeenCalledWith('/tmp/test-deploy', {
      recursive: true,
      force: true,
    });
  });

  it('should resolve default project and region from gcloud if not provided', async () => {
    const optionsWithoutProjectRegion = {
      ...defaultOptions,
      project: '',
      region: '',
    };

    await deployToCloudRun(optionsWithoutProjectRegion);

    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('config get-value project'),
      expect.any(Function),
    );
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('config get-value run/region'),
      expect.any(Function),
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'gcloud',
      expect.arrayContaining([
        '--project',
        'gcloud-project',
        '--region',
        'gcloud-region',
      ]),
      expect.any(Object),
    );
  });

  it('should throw error if project resolution fails (unset)', async () => {
    const optionsWithoutProject = {
      ...defaultOptions,
      project: '',
    };

    execMock.mockImplementation((cmd: string, callback: Callback) => {
      if (cmd.includes('config get-value project')) {
        callback(null, {stdout: '(unset)\n'});
      } else if (cmd.includes('config get-value run/region')) {
        callback(null, {stdout: 'gcloud-region\n'});
      }
    });

    await expect(deployToCloudRun(optionsWithoutProject)).rejects.toThrow(
      /Project is not specified/,
    );
  });

  it('should create a private temp folder when none is supplied', async () => {
    const createdTempFolder = '/tmp/cloud_run_deploy_src-abc123';
    (createTempDir as Mock).mockResolvedValue(createdTempFolder);

    await deployToCloudRun({...defaultOptions, tempFolder: undefined});

    expect(createTempDir).toHaveBeenCalledWith('cloud_run_deploy_src');
    expect(spawnMock.mock.calls[0][1]).toContain(createdTempFolder);
    expect(isFolderExists).not.toHaveBeenCalled();
    expect(fs.rm).toHaveBeenCalledTimes(1);
    expect(fs.rm).toHaveBeenCalledWith(createdTempFolder, {
      recursive: true,
      force: true,
    });
  });

  it('should clean up existing temp folder before deploying', async () => {
    (isFolderExists as Mock).mockResolvedValue(true);

    await deployToCloudRun(defaultOptions);

    expect(fs.rm).toHaveBeenCalledWith('/tmp/test-deploy', {
      recursive: true,
      force: true,
    });
  });

  it('should throw error if package.json has no dependencies', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error');
    (loadFileData as Mock).mockResolvedValue({});

    await deployToCloudRun(defaultOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('\x1b[31mFailed to deploy to Cloud Run:'),
      expect.stringContaining('No dependencies found in package.json'),
      expect.stringContaining('\x1b[0m'),
    );
  });

  it('should throw error if required npm packages are missing in package.json', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error');
    (loadFileData as Mock).mockResolvedValue({
      dependencies: {
        'some-other-package': '1.0.0',
      },
    });

    await deployToCloudRun(defaultOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('\x1b[31mFailed to deploy to Cloud Run:'),
      expect.stringContaining(
        'Package "@google/adk" is required but not found',
      ),
      expect.stringContaining('\x1b[0m'),
    );
  });

  it('should forward the A2A token to Cloud Run as an environment variable', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn');

    await deployToCloudRun({
      ...defaultOptions,
      a2a: true,
      a2aAuthToken: A2A_TOKEN,
    });

    const gcloudArgs = spawnMock.mock.calls[0][1];
    const flagIndex = gcloudArgs.indexOf('--update-env-vars');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(gcloudArgs[flagIndex + 1]).toBe(
      `${A2A_AUTH_TOKEN_ENV_VAR}=${A2A_TOKEN}`,
    );
    expect(consoleWarnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('WITHOUT authentication'),
    );
  });

  it('should not touch environment variables when no A2A token is given', async () => {
    await deployToCloudRun(defaultOptions);

    const gcloudArgs = spawnMock.mock.calls[0][1];
    expect(gcloudArgs).not.toContain('--update-env-vars');
    expect(gcloudArgs.join(' ')).not.toContain(A2A_AUTH_TOKEN_ENV_VAR);
  });

  it.each(['--set-env-vars=FOO=bar', '--remove-env-vars=FOO'])(
    'should reject %s, which would clobber the A2A token',
    async (extraGcloudArg) => {
      await expect(
        deployToCloudRun({
          ...defaultOptions,
          a2a: true,
          a2aAuthToken: A2A_TOKEN,
          extraGcloudArgs: [extraGcloudArg],
        }),
      ).rejects.toThrow(/conflict with ADK's automatic configuration/);
    },
  );

  it('should still allow user env-var flags when no A2A token is given', async () => {
    await deployToCloudRun({
      ...defaultOptions,
      extraGcloudArgs: ['--set-env-vars=FOO=bar'],
    });

    expect(spawnMock.mock.calls[0][1]).toContain('--set-env-vars=FOO=bar');
  });

  it('should warn when deploying an A2A surface with no token', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn');

    await deployToCloudRun({...defaultOptions, a2a: true});

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('WITHOUT authentication'),
    );
  });

  it('should handle spawn failures', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error');
    spawnMock.mockReturnValue({
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'close') {
          process.nextTick(() => cb(1));
        }
      }),
    });

    await deployToCloudRun(defaultOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('\x1b[31mFailed to deploy to Cloud Run:'),
      expect.stringContaining('Command failed with exit code 1'),
      expect.stringContaining('\x1b[0m'),
    );
  });
});
