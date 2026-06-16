/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
declare global {
  var fsMockTempFolder: string | undefined;
  var fsMockReaddir: Mock | undefined;
}

const mockReaddir = vi.hoisted(() => vi.fn().mockResolvedValue(['file1.js']));

type Callback = (error: Error | null, result?: unknown) => void;

const execMock = vi.fn();
const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  exec: (cmd: string, callback: Callback) => execMock(cmd, callback),
  spawn: (cmd: string, args: string[], opts: unknown) =>
    spawnMock(cmd, args, opts),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const isCoveragePath = (path: unknown) => {
    const pathStr = typeof path === 'string' ? path : String(path || '');
    return (
      pathStr.includes('coverage') ||
      pathStr.includes('.tmp') ||
      pathStr.includes('.vitest')
    );
  };

  const mockCp = vi.fn().mockImplementation((src, dest, opts) => {
    if (isCoveragePath(src) || isCoveragePath(dest)) {
      return actual.cp(src, dest, opts);
    }
    const destStr = typeof dest === 'string' ? dest : String(dest || '');
    const tempFolder = globalThis.fsMockTempFolder;
    if (tempFolder && destStr.startsWith(tempFolder)) {
      return Promise.resolve();
    }
    return actual.cp(src, dest, opts);
  });

  const mockMkdir = vi.fn().mockImplementation((path, opts) => {
    if (isCoveragePath(path)) {
      return actual.mkdir(path, opts);
    }
    return actual.mkdir(path, opts);
  });

  const mockReaddir = vi.fn().mockImplementation((path, opts) => {
    if (isCoveragePath(path)) {
      return actual.readdir(path, opts);
    }
    const pathStr = typeof path === 'string' ? path : String(path || '');
    const tempFolder = globalThis.fsMockTempFolder;
    process.stdout.write(
      `[GLOBAL MOCK readdir] path: ${pathStr}, tempFolder: ${tempFolder}\n`,
    );
    if (tempFolder && pathStr.startsWith(tempFolder)) {
      const mockReaddirFn = globalThis.fsMockReaddir;
      process.stdout.write(
        `[GLOBAL MOCK readdir] matched tempFolder, mockReaddirFn: ${mockReaddirFn ? 'DEFINED' : 'UNDEFINED'}\n`,
      );
      if (mockReaddirFn) {
        const res = mockReaddirFn(path, opts);
        process.stdout.write(
          `[GLOBAL MOCK readdir] mockReaddirFn returned: ${res} (type: ${typeof res})\n`,
        );
        return res;
      }
      return Promise.resolve([]);
    }
    return actual.readdir(path, opts);
  });

  const mockFs = {
    ...actual,
    cp: mockCp,
    mkdir: mockMkdir,
    readdir: mockReaddir,
  };

  if (actual.default) {
    mockFs.default = {
      ...actual.default,
      cp: mockCp,
      mkdir: mockMkdir,
      readdir: mockReaddir,
    };
  } else {
    mockFs.default = mockFs;
  }

  return mockFs;
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
  let tempFolder: string;
  let defaultOptions: DeployToAgentEngineOptions;

  beforeEach(async () => {
    tempFolder = path.join(
      os.tmpdir(),
      'adk-agent-engine-test-' + Math.random().toString(36).substring(2),
    );
    defaultOptions = {
      agentPath: 'path/to/agent',
      displayName: 'test-agent',
      tempFolder,
      adkVersion: '1.0.0',
      project: 'test-project',
      region: 'us-central1',
      port: 8080,
      withUi: false,
      logLevel: 'info',
      repository: 'agent-engine-repo',
    };
    vi.clearAllMocks();

    mockReaddir.mockResolvedValue(['file1.js']);
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

    globalThis.fsMockTempFolder = tempFolder;
    globalThis.fsMockReaddir = mockReaddir;
    vi.stubGlobal('setTimeout', (fn: () => void) => fn());
  });

  afterEach(() => {
    globalThis.fsMockTempFolder = undefined;
    globalThis.fsMockReaddir = undefined;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('debug: fs.readdir is mock', () => {
    console.warn('XXX fs.readdir is mock?', vi.isMockFunction(fs.readdir));
  });

  it('should deploy successfully with explicit options', async () => {
    await deployToAgentEngine(defaultOptions);

    expect(spawnMock).toHaveBeenCalledWith(
      'gcloud',
      expect.arrayContaining([
        'builds',
        'submit',
        '--tag',
        'us-central1-docker.pkg.dev/test-project/agent-engine-repo/agent-engine-agent:latest',
        tempFolder,
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
            imageUri:
              'us-central1-docker.pkg.dev/test-project/agent-engine-repo/agent-engine-agent:latest',
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

    // Verify tempFolder was cleaned up
    let exists = true;
    try {
      await fs.access(tempFolder);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('should deploy successfully with all optional parameters', async () => {
    const optionsWithAll: DeployToAgentEngineOptions = {
      ...defaultOptions,
      displayName: 'custom-display-name',
      description: 'custom-description',
      stagingBucket: 'custom-bucket',
      repository: 'custom-repo',
      allowOrigins: 'http://example.com',
      sessionServiceUri: 'http://session-service',
      artifactServiceUri: 'http://artifact-service',
      a2a: true,
    };

    await deployToAgentEngine(optionsWithAll);

    expect(spawnMock).toHaveBeenCalledWith(
      'gcloud',
      expect.arrayContaining([
        'builds',
        'submit',
        '--tag',
        'us-central1-docker.pkg.dev/test-project/custom-repo/agent-engine-agent:latest',
        tempFolder,
        '--project',
        'test-project',
        '--suppress-logs',
      ]),
      expect.any(Object),
    );

    expect(mockCreateInternal).toHaveBeenCalledWith({
      config: {
        displayName: 'custom-display-name',
        description: 'custom-description',
        spec: {
          containerSpec: {
            imageUri:
              'us-central1-docker.pkg.dev/test-project/custom-repo/agent-engine-agent:latest',
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
              imageUri:
                'gcloud-region-docker.pkg.dev/gcloud-project/agent-engine-repo/agent-engine-agent:latest',
            },
          }),
        }),
      }),
    );
  });

  it('should deploy successfully with custom repository name', async () => {
    await deployToAgentEngine({
      ...defaultOptions,
      repository: 'custom-repo',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'gcloud',
      expect.arrayContaining([
        'builds',
        'submit',
        '--tag',
        'us-central1-docker.pkg.dev/test-project/custom-repo/agent-engine-agent:latest',
        tempFolder,
        '--project',
        'test-project',
        '--suppress-logs',
      ]),
      expect.any(Object),
    );

    expect(mockCreateInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          spec: expect.objectContaining({
            containerSpec: {
              imageUri:
                'us-central1-docker.pkg.dev/test-project/custom-repo/agent-engine-agent:latest',
            },
          }),
        }),
      }),
    );
  });

  it('should throw error if region resolution fails (unset)', async () => {
    const optionsWithoutRegion = {
      ...defaultOptions,
      region: '',
    };

    execMock.mockImplementation((cmd: string, callback: Callback) => {
      if (cmd.includes('config get-value project')) {
        callback(null, {stdout: 'gcloud-project\n'});
      } else if (cmd.includes('config get-value run/region')) {
        callback(null, {stdout: ''});
      } else {
        callback(null, {stdout: ''});
      }
    });

    await expect(deployToAgentEngine(optionsWithoutRegion)).rejects.toThrow(
      /Region is not specified/,
    );
  });

  it('should deploy successfully when agentPath is a file', async () => {
    (isFile as Mock).mockResolvedValue(true);

    await deployToAgentEngine({
      ...defaultOptions,
      agentPath: 'path/to/agent.ts',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'gcloud',
      expect.arrayContaining([
        'builds',
        'submit',
        '--tag',
        'us-central1-docker.pkg.dev/test-project/agent-engine-repo/agent-engine-agent:latest',
        tempFolder,
        '--project',
        'test-project',
        '--suppress-logs',
      ]),
      expect.any(Object),
    );
  });

  it('should deploy successfully without explicit displayName', async () => {
    const optionsWithoutDisplayName = {
      ...defaultOptions,
      displayName: undefined,
    };

    await deployToAgentEngine(optionsWithoutDisplayName);

    expect(mockCreateInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          displayName: 'agent',
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
    await fs.mkdir(tempFolder, {recursive: true});
    (isFolderExists as Mock).mockResolvedValue(true);

    await deployToAgentEngine(defaultOptions);

    let exists = true;
    try {
      await fs.access(tempFolder);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
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
    let resolveReachedLoop: () => void = () => {};
    const reachedLoopPromise = new Promise<void>((r) => {
      resolveReachedLoop = r;
    });

    mockCreateInternal.mockImplementation(() => {
      resolveReachedLoop();
      return Promise.resolve({
        name: 'operations/test-operation',
        done: false,
      });
    });

    mockGetAgentOperationInternal.mockResolvedValue({
      name: 'operations/test-operation',
      done: false,
    });

    vi.unstubAllGlobals();
    vi.useFakeTimers();

    const deployPromise = deployToAgentEngine(defaultOptions);

    await reachedLoopPromise;
    await Promise.resolve(); // yield

    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }

    await expect(deployPromise).rejects.toThrow(
      'Reasoning Engine creation operation operations/test-operation did not complete in time.',
    );

    vi.useRealTimers();
  }, 30000);
});
