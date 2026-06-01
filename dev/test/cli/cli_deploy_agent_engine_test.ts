/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {
  deployToAgentEngine,
  DeployToAgentEngineOptions,
} from '../../src/cli/deploy/cli_deploy_agent_engine.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';
import {
  isFile,
  isFolderExists,
  loadFileData,
  tryToFindFileRecursively,
} from '../../src/utils/file_utils.js';

type Callback = (error: Error | null, result?: unknown) => void;

const execMock = vi.fn();
const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  exec: (cmd: string, callback: Callback) => execMock(cmd, callback),
  spawn: (cmd: string, args: string[], opts: unknown) =>
    spawnMock(cmd, args, opts),
}));

vi.mock('node:fs/promises', () => ({
  cp: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

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
  isFile: vi.fn(),
  isFolderExists: vi.fn(),
  loadFileData: vi.fn(),
  saveToFile: vi.fn(),
  tryToFindFileRecursively: vi.fn(),
}));

const mockCreateInternal = vi.fn();
const mockGetAgentOperationInternal = vi.fn();

vi.mock('@google-cloud/vertexai/build/src/genai/client.js', () => ({
  Client: class {
    agentEnginesInternal = {
      createInternal: mockCreateInternal,
      getAgentOperationInternal: mockGetAgentOperationInternal,
    };
  },
}));

describe('deployToAgentEngine', () => {
  const defaultOptions: DeployToAgentEngineOptions = {
    agentPath: 'path/to/agent',
    displayName: 'test-agent',
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

    mockCreateInternal.mockResolvedValue({
      name: 'operations/test-operation',
      done: false,
    });

    mockGetAgentOperationInternal.mockResolvedValue({
      done: true,
      response: {
        name: 'projects/test-project/locations/us-central1/reasoningEngines/123',
      },
    });

    vi.stubGlobal('setTimeout', (fn: () => void) => fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('should deploy successfully with explicit options', async () => {
    await deployToAgentEngine(defaultOptions);

    expect(spawnMock).toHaveBeenCalledWith(
      'gcloud',
      expect.arrayContaining([
        'builds',
        'submit',
        '--tag',
        'gcr.io/test-project/agent-engine-agent:latest',
        '/tmp/test-deploy',
        '--project',
        'test-project',
        '--suppress-logs',
      ]),
      expect.any(Object),
    );

    expect(mockCreateInternal).toHaveBeenCalledWith({
      config: {
        displayName: 'test-agent',
        description: undefined,
        spec: {
          containerSpec: {
            imageUri: 'gcr.io/test-project/agent-engine-agent:latest',
          },
          deploymentSpec: {
            containerConcurrency: 9,
            minInstances: 1,
            maxInstances: 10,
            resourceLimits: {
              cpu: '1',
              memory: '2Gi',
            },
          },
        },
      },
    });

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

    await deployToAgentEngine(optionsWithoutProjectRegion);

    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('config get-value project'),
      expect.any(Function),
    );
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('config get-value run/region'),
      expect.any(Function),
    );

    expect(mockCreateInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          spec: expect.objectContaining({
            containerSpec: {
              imageUri: 'gcr.io/gcloud-project/agent-engine-agent:latest',
            },
          }),
        }),
      }),
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

    await expect(deployToAgentEngine(optionsWithoutProject)).rejects.toThrow(
      /Project is not specified/,
    );
  });

  it('should clean up existing temp folder before deploying', async () => {
    (isFolderExists as Mock).mockResolvedValue(true);

    await deployToAgentEngine(defaultOptions);

    expect(fs.rm).toHaveBeenCalledWith('/tmp/test-deploy', {
      recursive: true,
      force: true,
    });
  });

  it('should throw error if required npm packages are missing in package.json', async () => {
    (loadFileData as Mock).mockResolvedValue({
      dependencies: {
        'some-other-package': '1.0.0',
      },
    });

    await expect(deployToAgentEngine(defaultOptions)).rejects.toThrow(
      'Package "@google/adk" is required but not found',
    );
  });

  it('should handle spawn failures during build', async () => {
    spawnMock.mockReturnValue({
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'close') {
          process.nextTick(() => cb(1));
        }
      }),
    });

    await expect(deployToAgentEngine(defaultOptions)).rejects.toThrow(
      'Command failed with exit code 1',
    );
  });

  it('should throw error if Reasoning Engine creation operation times out', async () => {
    mockCreateInternal.mockResolvedValue({
      name: 'operations/test-operation',
      done: false,
    });
    mockGetAgentOperationInternal.mockResolvedValue({
      name: 'operations/test-operation',
      done: false,
    });

    vi.useFakeTimers();

    const deployPromise = deployToAgentEngine(defaultOptions);

    await Promise.all([
      expect(deployPromise).rejects.toThrow(
        'Reasoning Engine creation operation operations/test-operation did not complete in time.',
      ),
      vi.runAllTimersAsync(),
    ]);

    vi.useRealTimers();
  });
});
