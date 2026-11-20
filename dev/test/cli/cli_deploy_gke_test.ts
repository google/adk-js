/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {
  createGkeDeploymentManifest,
  type CreateGkeDeploymentManifestOptions,
  deployToGke,
  type DeployToGkeOptions,
  GKE_SERVICE_TYPES,
  type GkeServiceType,
} from '../../src/cli/deploy/cli_deploy_gke.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';
import {
  createTempDir,
  isFile,
  isFolderExists,
  loadFileData,
  saveToFile,
  tryToFindFileRecursively,
} from '../../src/utils/file_utils.js';
import {AdkLogger} from '../../src/utils/logger.js';
import {version} from '../../src/version.js';

type ExecCallback = (error: Error | null, result?: {stdout: string}) => void;

const execMock = vi.fn<(cmd: string, callback: ExecCallback) => void>();
const spawnMock =
  vi.fn<(cmd: string, args: string[], opts: unknown) => unknown>();
const disposeAllMock = vi.fn<() => Promise<void>>();

vi.mock('node:child_process', () => ({
  exec: (cmd: string, callback: ExecCallback) => execMock(cmd, callback),
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
  AgentLoader: vi.fn().mockImplementation(function () {
    return {
      listAgents: vi.fn().mockResolvedValue(['agentOne']),
      getAgentFile: vi.fn().mockResolvedValue({
        getFilePath: vi.fn().mockReturnValue('path/to/agentOne.cjs'),
      }),
      disposeAll: disposeAllMock,
    };
  }),
}));

vi.mock('../../src/utils/file_utils.js', () => ({
  createTempDir: vi.fn(),
  isFile: vi.fn(),
  isFolderExists: vi.fn(),
  loadFileData: vi.fn(),
  saveToFile: vi.fn(),
  tryToFindFileRecursively: vi.fn(),
}));

describe('GKE_SERVICE_TYPES', () => {
  it('lists the supported Kubernetes Service types in order', () => {
    const types: readonly GkeServiceType[] = GKE_SERVICE_TYPES;
    expect(types).toEqual(['ClusterIP', 'NodePort', 'LoadBalancer']);
  });
});

describe('createGkeDeploymentManifest', () => {
  const defaultManifestOptions: CreateGkeDeploymentManifestOptions = {
    serviceName: 'gke-svc',
    imageName: 'gcr.io/gke-proj/gke-svc:20261118-220000',
    port: 9090,
    project: 'gke-proj',
    region: 'us-east1',
    adkVersion: '1.2.0',
  };

  it('creates Deployment and ClusterIP Service manifests with quoted labels by default', () => {
    const manifest = createGkeDeploymentManifest({
      ...defaultManifestOptions,
      adkVersion: '1.2',
    });

    expect(manifest).toContain('apiVersion: apps/v1\nkind: Deployment');
    expect(manifest).toContain('apiVersion: v1\nkind: Service');
    expect(manifest).toContain('name: "gke-svc"');
    expect(manifest).toContain('app.kubernetes.io/name: "adk-agent"');
    expect(manifest).toContain('app.kubernetes.io/version: "1.2"');
    expect(manifest).toContain('app.kubernetes.io/instance: "gke-svc"');
    expect(manifest).toContain('app.kubernetes.io/managed-by: "adk-cli"');
    expect(manifest).toContain(
      'image: "gcr.io/gke-proj/gke-svc:20261118-220000"',
    );
    expect(manifest).toContain('containerPort: 9090');
    expect(manifest).toContain(
      '- name: GOOGLE_GENAI_USE_ENTERPRISE\n          value: "1"',
    );
    expect(manifest).toContain(
      '- name: GOOGLE_CLOUD_PROJECT\n          value: "gke-proj"',
    );
    expect(manifest).toContain(
      '- name: GOOGLE_CLOUD_LOCATION\n          value: "us-east1"',
    );
    expect(manifest).toContain('type: "ClusterIP"');
    expect(manifest).toContain('- port: 80\n    targetPort: 9090');
  });

  it('defaults adkVersion to the CLI package version when omitted', () => {
    const manifest = createGkeDeploymentManifest({
      ...defaultManifestOptions,
      adkVersion: undefined,
    });

    expect(manifest).toContain(
      `app.kubernetes.io/version: ${JSON.stringify(version)}`,
    );
  });

  it.each([
    {
      description: 'caret npm range',
      adkVersion: '^2.4.0',
      expectedLabel: '2.4.0',
    },
    {
      description: 'tilde npm range',
      adkVersion: '~2.4.0',
      expectedLabel: '2.4.0',
    },
    {
      description: 'SemVer build metadata separator',
      adkVersion: '2.5.0+build.1',
      expectedLabel: '2.5.0_build.1',
    },
    {
      description: 'leading and trailing punctuation',
      adkVersion: '._-2.5.0-rc.1-_.',
      expectedLabel: '2.5.0-rc.1',
    },
    {
      description: 'over-63-character prerelease ending on alphanumeric at 63',
      adkVersion: `2.5.0-rc.${'a'.repeat(60)}`,
      expectedLabel: `2.5.0-rc.${'a'.repeat(54)}`,
    },
    {
      description: 'over-63-character prerelease with hyphen at character 63',
      adkVersion: `2.5.0-${'a'.repeat(56)}-rc.1`,
      expectedLabel: `2.5.0-${'a'.repeat(56)}`,
    },
    {
      description: 'over-63-character prerelease with dot at character 63',
      adkVersion: `2.5.0-alpha.${'1'.repeat(50)}.beta.2`,
      expectedLabel: `2.5.0-alpha.${'1'.repeat(50)}`,
    },
    {
      description:
        'over-63-character prerelease with plus metadata separator at character 63',
      adkVersion: `2.5.0-alpha.${'1'.repeat(50)}+build.9`,
      expectedLabel: `2.5.0-alpha.${'1'.repeat(50)}`,
    },
  ])(
    'sanitizes adkVersion ($description) to a valid Kubernetes version label in Deployment and pod template',
    ({adkVersion, expectedLabel}) => {
      const manifest = createGkeDeploymentManifest({
        ...defaultManifestOptions,
        adkVersion,
      });

      const versionLabels = Array.from(
        manifest.matchAll(/^\s+app\.kubernetes\.io\/version:\s+"([^"]*)"$/gm),
        (match) => match[1] ?? '',
      );
      expect(versionLabels).toEqual([expectedLabel, expectedLabel]);
      for (const labelValue of versionLabels) {
        expect(labelValue.length).toBeLessThanOrEqual(63);
        expect(labelValue).toMatch(
          /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/,
        );
      }
    },
  );

  it.each(['^', '~', '^~', '...', '---', '___', '+++', '^+._-'])(
    'omits app.kubernetes.io/version labels when sanitizing %j leaves an empty string',
    (adkVersion) => {
      const manifest = createGkeDeploymentManifest({
        ...defaultManifestOptions,
        adkVersion,
      });

      expect(manifest).not.toContain('app.kubernetes.io/version');
      expect(manifest).toContain(
        '  labels:\n' +
          '    app.kubernetes.io/name: "adk-agent"\n' +
          '    app.kubernetes.io/instance: "gke-svc"\n' +
          '    app.kubernetes.io/managed-by: "adk-cli"',
      );
      expect(manifest).toContain(
        '      labels:\n' +
          '        app: "gke-svc"\n' +
          '        app.kubernetes.io/name: "adk-agent"\n' +
          '        app.kubernetes.io/instance: "gke-svc"\n' +
          '        app.kubernetes.io/managed-by: "adk-cli"',
      );
    },
  );

  it.each(GKE_SERVICE_TYPES)(
    'renders Service type %s when configured',
    (serviceType) => {
      const manifest = createGkeDeploymentManifest({
        ...defaultManifestOptions,
        serviceType,
      });

      expect(manifest).toContain(`type: "${serviceType}"`);
    },
  );

  it('omits GOOGLE_CLOUD_LOCATION when region is omitted', () => {
    const manifest = createGkeDeploymentManifest({
      ...defaultManifestOptions,
      region: undefined,
    });

    expect(manifest).toContain('GOOGLE_CLOUD_PROJECT');
    expect(manifest).not.toContain('GOOGLE_CLOUD_LOCATION');
    expect(manifest).not.toContain('undefined');
  });

  it.each([
    '',
    'UpperCaseService',
    'service_with_underscore',
    '-leading-hyphen',
    'trailing-hyphen-',
    'a'.repeat(64),
    'svc\nkind: Pod',
  ])('rejects invalid serviceName %j', (serviceName) => {
    expect(() =>
      createGkeDeploymentManifest({
        ...defaultManifestOptions,
        serviceName,
      }),
    ).toThrow(/Invalid serviceName/);
  });

  it.each([0, -1, 65536, 8080.5, Number.NaN])(
    'rejects invalid port %s',
    (port) => {
      expect(() =>
        createGkeDeploymentManifest({
          ...defaultManifestOptions,
          port,
        }),
      ).toThrow(/Invalid port/);
    },
  );

  it.each(['', 'proj with spaces', 'proj\nenv:'])(
    'rejects invalid project %j',
    (project) => {
      expect(() =>
        createGkeDeploymentManifest({
          ...defaultManifestOptions,
          project,
        }),
      ).toThrow(/Invalid project/);
    },
  );

  it.each(['us central1', 'us-east1\nenv:'])(
    'rejects invalid region %j',
    (region) => {
      expect(() =>
        createGkeDeploymentManifest({
          ...defaultManifestOptions,
          region,
        }),
      ).toThrow(/Invalid region/);
    },
  );

  it.each(['', '>=1.0.0', '1.0.0;id', '1.0.0\nkind: Pod'])(
    'rejects invalid adkVersion %j',
    (adkVersion) => {
      expect(() =>
        createGkeDeploymentManifest({
          ...defaultManifestOptions,
          adkVersion,
        }),
      ).toThrow(/Invalid adkVersion/);
    },
  );

  it('rejects an unsupported serviceType at runtime', () => {
    expect(() =>
      Reflect.apply(createGkeDeploymentManifest, undefined, [
        {
          ...defaultManifestOptions,
          serviceType: 'ExternalName',
        },
      ]),
    ).toThrow(/Invalid serviceType/);
  });

  it.each(['', 'gcr.io/proj/svc:tag\nenv:', 'gcr.io/proj/"svc":tag'])(
    'rejects unsafe imageName %j',
    (imageName) => {
      expect(() =>
        createGkeDeploymentManifest({
          ...defaultManifestOptions,
          imageName,
        }),
      ).toThrow(/Invalid imageName/);
    },
  );
});

describe('deployToGke', () => {
  const defaultDeployOptions: DeployToGkeOptions = {
    agentPath: '/workspace/agents/my-agent',
    project: 'gke-proj',
    region: 'us-east1',
    clusterName: 'my-gke-cluster',
    serviceName: 'gke-svc',
    appName: 'agent',
    tempFolder: '/tmp/gke-deploy-test',
    port: 9090,
    withUi: false,
    logLevel: 'debug',
    adkVersion: '1.2.0',
    allowOrigins: 'http://localhost:3000,https://my-app.com',
    sessionServiceUri: 'memory://',
    artifactServiceUri: 'gs://gke-bucket',
    memoryServiceUri: 'rag://corpus-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-11-18T22:00:00Z'));

    vi.spyOn(AdkLogger.prototype, 'info').mockImplementation(() => {});
    vi.spyOn(AdkLogger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(AdkLogger.prototype, 'debug').mockImplementation(() => {});
    vi.spyOn(AdkLogger.prototype, 'error').mockImplementation(() => {});

    (isFile as Mock).mockResolvedValue(false);
    (isFolderExists as Mock).mockResolvedValue(false);
    (saveToFile as Mock).mockResolvedValue(undefined);
    (tryToFindFileRecursively as Mock).mockResolvedValue(
      '/workspace/agents/package.json',
    );
    (loadFileData as Mock).mockResolvedValue({
      dependencies: {
        '@google/adk': '^2.5.0',
      },
    });
    disposeAllMock.mockResolvedValue(undefined);

    (AgentLoader as Mock).mockImplementation(function () {
      return {
        listAgents: vi.fn().mockResolvedValue(['agentOne']),
        getAgentFile: vi.fn().mockResolvedValue({
          getFilePath: vi.fn().mockReturnValue('path/to/agentOne.cjs'),
        }),
        disposeAll: disposeAllMock,
      };
    });

    execMock.mockImplementation((cmd: string, callback: ExecCallback) => {
      if (cmd.includes('config get-value project')) {
        callback(null, {stdout: 'gcloud-default-proj\n'});
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    {withUi: true, expectedAdkCommand: 'npx adk web'},
    {withUi: false, expectedAdkCommand: 'npx adk api_server'},
  ])(
    'stages files, builds tagged image, writes manifest, fetches credentials, applies deployment, and cleans up when withUi is $withUi',
    async ({withUi, expectedAdkCommand}) => {
      const infoSpy = vi.spyOn(AdkLogger.prototype, 'info');
      const warnSpy = vi.spyOn(AdkLogger.prototype, 'warn');

      await deployToGke({
        ...defaultDeployOptions,
        withUi,
        otelToCloud: true,
        a2a: true,
      });

      expect(fs.cp).toHaveBeenCalledWith(
        'path/to/agentOne.cjs',
        path.join('/tmp/gke-deploy-test', 'agents', 'agent', 'agentOne.cjs'),
      );
      expect(saveToFile).toHaveBeenCalledWith(
        path.join('/tmp/gke-deploy-test', 'package.json'),
        {dependencies: {'@google/adk': '^2.5.0'}},
      );

      const dockerfileSaveCall = (saveToFile as Mock).mock.calls.find(
        (call) => call[0] === path.join('/tmp/gke-deploy-test', 'Dockerfile'),
      );
      expect(dockerfileSaveCall).toBeDefined();
      const dockerfileContent = String(dockerfileSaveCall?.[1] ?? '');
      expect(dockerfileContent).toContain(expectedAdkCommand);
      expect(dockerfileContent).toContain('--port=9090');
      expect(dockerfileContent).toContain(
        'RUN npm install @google/adk-devtools@1.2.0',
      );
      expect(dockerfileContent).toContain(
        "--allow_origins='http://localhost:3000,https://my-app.com'",
      );
      expect(dockerfileContent).toContain("--session_service_uri='memory://'");
      expect(dockerfileContent).toContain(
        "--artifact_service_uri='gs://gke-bucket'",
      );
      expect(dockerfileContent).toContain(
        "--memory_service_uri='rag://corpus-1'",
      );
      expect(dockerfileContent).toContain('--otel_to_cloud');
      expect(dockerfileContent).toContain('--a2a');

      const expectedImage = 'gcr.io/gke-proj/gke-svc:20261118-220000';
      const deploymentYamlPath = path.join(
        '/tmp/gke-deploy-test',
        'deployment.yaml',
      );
      const manifestSaveCall = (saveToFile as Mock).mock.calls.find(
        (call) => call[0] === deploymentYamlPath,
      );
      expect(manifestSaveCall).toBeDefined();
      const manifestContent = String(manifestSaveCall?.[1] ?? '');
      expect(manifestContent).toContain(`image: "${expectedImage}"`);
      expect(manifestContent).toContain('type: "ClusterIP"');
      expect(manifestContent).toContain('containerPort: 9090');
      expect(manifestContent).toContain('targetPort: 9090');

      expect(spawnMock).toHaveBeenCalledTimes(3);
      expect(spawnMock.mock.calls[0]).toEqual([
        'gcloud',
        [
          'builds',
          'submit',
          '--tag',
          expectedImage,
          '--project',
          'gke-proj',
          '--verbosity',
          'debug',
          '/tmp/gke-deploy-test',
        ],
        expect.objectContaining({stdio: 'inherit'}),
      ]);
      expect(spawnMock.mock.calls[1]).toEqual([
        'gcloud',
        [
          'container',
          'clusters',
          'get-credentials',
          'my-gke-cluster',
          '--region',
          'us-east1',
          '--project',
          'gke-proj',
        ],
        expect.objectContaining({stdio: 'inherit'}),
      ]);
      expect(spawnMock.mock.calls[2]).toEqual([
        'kubectl',
        ['apply', '-f', deploymentYamlPath],
        expect.objectContaining({stdio: 'inherit'}),
      ]);

      if (withUi) {
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('ADK Web is for development purposes'),
        );
      } else {
        expect(warnSpy).not.toHaveBeenCalledWith(
          expect.stringContaining('ADK Web is for development purposes'),
        );
      }
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('WITHOUT authentication'),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('kubectl port-forward svc/gke-svc 9090:80'),
      );

      expect(fs.rm).toHaveBeenCalledWith('/tmp/gke-deploy-test', {
        recursive: true,
        force: true,
      });
      expect(disposeAllMock).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves raw adkVersion in Dockerfile while sanitizing app.kubernetes.io/version in deployment.yaml', async () => {
    await deployToGke({
      ...defaultDeployOptions,
      adkVersion: '^2.4.0+build.1',
    });

    const dockerfileSaveCall = (saveToFile as Mock).mock.calls.find(
      (call) => call[0] === path.join('/tmp/gke-deploy-test', 'Dockerfile'),
    );
    expect(String(dockerfileSaveCall?.[1] ?? '')).toContain(
      'RUN npm install @google/adk-devtools@^2.4.0+build.1',
    );

    const manifestSaveCall = (saveToFile as Mock).mock.calls.find(
      (call) =>
        call[0] === path.join('/tmp/gke-deploy-test', 'deployment.yaml'),
    );
    const manifestContent = String(manifestSaveCall?.[1] ?? '');
    const versionLabels = Array.from(
      manifestContent.matchAll(
        /^\s+app\.kubernetes\.io\/version:\s+"([^"]*)"$/gm,
      ),
      (match) => match[1] ?? '',
    );
    expect(versionLabels).toEqual(['2.4.0_build.1', '2.4.0_build.1']);
  });

  it('omits --region and GOOGLE_CLOUD_LOCATION cleanly when region is omitted', async () => {
    const infoSpy = vi.spyOn(AdkLogger.prototype, 'info');

    await deployToGke({
      ...defaultDeployOptions,
      region: undefined,
      serviceType: 'LoadBalancer',
    });

    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('kubectl port-forward'),
    );

    for (const [, content] of (saveToFile as Mock).mock.calls) {
      if (typeof content === 'string') {
        expect(content).not.toContain('GOOGLE_CLOUD_LOCATION');
        expect(content).not.toContain('undefined');
      }
    }

    expect(spawnMock.mock.calls[1]).toEqual([
      'gcloud',
      [
        'container',
        'clusters',
        'get-credentials',
        'my-gke-cluster',
        '--project',
        'gke-proj',
      ],
      expect.objectContaining({stdio: 'inherit'}),
    ]);

    for (const [, args] of spawnMock.mock.calls) {
      for (const arg of args) {
        expect(typeof arg).toBe('string');
        expect(arg.length).toBeGreaterThan(0);
        expect(arg).not.toBe('undefined');
      }
    }
  });

  it('strips trailing slashes from agentPath before deriving appName', async () => {
    await deployToGke({
      ...defaultDeployOptions,
      agentPath: '/workspace/agents/support-bot///',
      appName: undefined,
    });

    expect(fs.cp).toHaveBeenCalledWith(
      'path/to/agentOne.cjs',
      path.join(
        '/tmp/gke-deploy-test',
        'agents',
        'support-bot',
        'agentOne.cjs',
      ),
    );
    const dockerfileSaveCall = (saveToFile as Mock).mock.calls.find(
      (call) => call[0] === path.join('/tmp/gke-deploy-test', 'Dockerfile'),
    );
    expect(String(dockerfileSaveCall?.[1] ?? '')).toContain(
      '/app/agents/support-bot',
    );
  });

  it('derives appName from file stem when agentPath points to an agent file', async () => {
    (isFile as Mock).mockResolvedValue(true);

    await deployToGke({
      ...defaultDeployOptions,
      agentPath: '/workspace/agents/weather-agent.ts',
      appName: undefined,
    });

    expect(tryToFindFileRecursively).toHaveBeenCalledWith(
      '/workspace/agents',
      'package.json',
      3,
    );
    expect(fs.cp).toHaveBeenCalledWith(
      'path/to/agentOne.cjs',
      path.join(
        '/tmp/gke-deploy-test',
        'agents',
        'weather-agent',
        'agentOne.cjs',
      ),
    );
  });

  it('resolves project from gcloud config when project option is omitted', async () => {
    const infoSpy = vi.spyOn(AdkLogger.prototype, 'info');

    await deployToGke({
      ...defaultDeployOptions,
      project: undefined,
    });

    expect(execMock).toHaveBeenCalledWith(
      'gcloud config get-value project',
      expect.any(Function),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('gcloud-default-proj'),
    );
    expect(spawnMock.mock.calls[0]?.[1]).toContain(
      'gcr.io/gcloud-default-proj/gke-svc:20261118-220000',
    );
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      'container',
      'clusters',
      'get-credentials',
      'my-gke-cluster',
      '--region',
      'us-east1',
      '--project',
      'gcloud-default-proj',
    ]);
  });

  it('throws before creating tempFolder when gcloud config project is unset', async () => {
    execMock.mockImplementation((_cmd: string, callback: ExecCallback) => {
      callback(null, {stdout: '(unset)\n'});
    });

    await expect(
      deployToGke({
        ...defaultDeployOptions,
        project: '',
        tempFolder: undefined,
      }),
    ).rejects.toThrow(/Project is not specified/);

    expect(createTempDir).not.toHaveBeenCalled();
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('propagates gcloud config get-value project command failure without creating tempFolder', async () => {
    execMock.mockImplementation((_cmd: string, callback: ExecCallback) => {
      callback(new Error('gcloud unavailable'));
    });

    await expect(
      deployToGke({
        ...defaultDeployOptions,
        project: undefined,
        tempFolder: undefined,
      }),
    ).rejects.toThrow('gcloud unavailable');

    expect(createTempDir).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'empty clusterName',
      overrides: {clusterName: ''},
      expectedError: /Invalid clusterName/,
    },
    {
      label: 'flag-like clusterName',
      overrides: {clusterName: '--zone=evil'},
      expectedError: /Invalid clusterName/,
    },
    {
      label: 'invalid serviceName',
      overrides: {serviceName: 'Bad_Service'},
      expectedError: /Invalid serviceName/,
    },
    {
      label: 'invalid port',
      overrides: {port: 70000},
      expectedError: /Invalid port/,
    },
    {
      label: 'invalid project',
      overrides: {project: 'proj\nRUN id'},
      expectedError: /Invalid project/,
    },
    {
      label: 'invalid region',
      overrides: {region: 'us-east1\nRUN id'},
      expectedError: /Invalid region/,
    },
    {
      label: 'invalid appName',
      overrides: {appName: 'bad app\nRUN id'},
      expectedError: /Invalid appName/,
    },
    {
      label: 'invalid adkVersion',
      overrides: {adkVersion: '1.0.0;id'},
      expectedError: /Invalid adkVersion/,
    },
    {
      label: 'newline in logLevel',
      overrides: {logLevel: 'info\nRUN id'},
      expectedError: /Invalid logLevel/,
    },
  ])(
    'validates $label before creating tempFolder or spawning commands',
    async ({overrides, expectedError}) => {
      await expect(
        deployToGke({
          ...defaultDeployOptions,
          tempFolder: undefined,
          ...overrides,
        }),
      ).rejects.toThrow(expectedError);

      expect(createTempDir).not.toHaveBeenCalled();
      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', '--evil', '--zone=evil', 'cluster with spaces'])(
    'rejects invalid clusterName %j without mentioning Dockerfile in the error message',
    async (clusterName) => {
      const promise: Promise<void> = Reflect.apply(deployToGke, undefined, [
        {
          ...defaultDeployOptions,
          tempFolder: undefined,
          clusterName,
        },
      ]);

      await Promise.all([
        expect(promise).rejects.toThrow(/Invalid clusterName/),
        expect(promise).rejects.not.toThrow(/Dockerfile/i),
      ]);
      expect(createTempDir).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it('creates a private temp directory with gke_deploy_src prefix when tempFolder is omitted', async () => {
    const generatedDir = '/tmp/gke_deploy_src-xyz987';
    (createTempDir as Mock).mockResolvedValue(generatedDir);

    await deployToGke({
      ...defaultDeployOptions,
      tempFolder: undefined,
    });

    expect(createTempDir).toHaveBeenCalledWith('gke_deploy_src');
    expect(isFolderExists).not.toHaveBeenCalled();
    expect(spawnMock.mock.calls[0]?.[1]).toContain(generatedDir);
    expect(fs.rm).toHaveBeenCalledTimes(1);
    expect(fs.rm).toHaveBeenCalledWith(generatedDir, {
      recursive: true,
      force: true,
    });
  });

  it('removes a pre-existing caller tempFolder before staging and cleans it up in finally', async () => {
    (isFolderExists as Mock).mockResolvedValue(true);

    await deployToGke(defaultDeployOptions);

    expect(fs.rm).toHaveBeenCalledTimes(2);
    expect(fs.rm).toHaveBeenNthCalledWith(1, '/tmp/gke-deploy-test', {
      recursive: true,
      force: true,
    });
    expect(fs.rm).toHaveBeenNthCalledWith(2, '/tmp/gke-deploy-test', {
      recursive: true,
      force: true,
    });
  });

  it.each([
    {failCallIndex: 0, stepName: 'gcloud builds submit'},
    {failCallIndex: 1, stepName: 'gcloud container clusters get-credentials'},
    {failCallIndex: 2, stepName: 'kubectl apply'},
  ])(
    'cleans up tempFolder and disposes AgentLoader when $stepName fails',
    async ({failCallIndex}) => {
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        const currentIndex = callCount++;
        return {
          on: vi.fn((event: string, cb: (code: number) => void) => {
            if (event === 'close') {
              process.nextTick(() =>
                cb(currentIndex === failCallIndex ? 1 : 0),
              );
            }
          }),
        };
      });

      await expect(deployToGke(defaultDeployOptions)).rejects.toThrow(
        'Command failed with exit code 1',
      );

      expect(fs.rm).toHaveBeenCalledWith('/tmp/gke-deploy-test', {
        recursive: true,
        force: true,
      });
      expect(disposeAllMock).toHaveBeenCalledTimes(1);
    },
  );
});
