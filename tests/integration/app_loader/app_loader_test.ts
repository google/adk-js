/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, isApp, isBaseAgent} from '@google/adk';
import {exec, spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {AgentLoader} from '../../../dev/src/utils/agent_loader.js';
import {sendInput} from '../test_case_utils.js';

const execAsync = promisify(exec);
const dirname = process.cwd();
const TEST_EXECUTION_TIMEOUT = 40000;

describe('App loader CLI integration', () => {
  describe.each(['app_ts', 'app_js', 'app_default'])(
    'App entrypoint with %s',
    (testCaseName: string) => {
      const projectPath = path.join(
        dirname,
        'tests/integration/app_loader',
        testCaseName,
      );

      beforeAll(async () => {
        await execAsync('npm install', {cwd: projectPath});
      }, TEST_EXECUTION_TIMEOUT);

      it(
        'should run app via package.json start script and get responses',
        async () => {
          const childProcess = spawn('npm', ['run', 'start'], {
            cwd: projectPath,
            shell: true,
          });

          let response = await sendInput(
            childProcess,
            'Tell me about the app.\n',
          );

          expect(response.toString()).toContain('Hello from');

          response = await sendInput(childProcess, 'exit\n');
          expect(response.toString()).toContain('');
        },
        TEST_EXECUTION_TIMEOUT,
      );

      afterAll(async () => {
        await fs
          .rm(path.join(projectPath, 'node_modules'), {
            recursive: true,
            force: true,
          })
          .catch(() => {});
        await fs
          .unlink(path.join(projectPath, 'package-lock.json'))
          .catch(() => {});
      }, TEST_EXECUTION_TIMEOUT);
    },
  );
});

describe('AgentLoader discovery and loading integration', () => {
  const projectPath = path.join(
    dirname,
    'tests/integration/app_loader/discovery',
  );
  let loader: AgentLoader;

  beforeAll(async () => {
    await execAsync('npm install', {cwd: projectPath});
    loader = new AgentLoader(projectPath);
  }, TEST_EXECUTION_TIMEOUT);

  it(
    'should discover apps vs agents across directories and standalone files',
    async () => {
      const apps = await loader.listApps();
      expect(apps).toHaveLength(2);
      expect(apps).toContain('service_alpha');
      expect(apps).toContain('standalone_app');

      const agentsAndApps = await loader.listAgents();
      expect(agentsAndApps).toHaveLength(4);
      expect(agentsAndApps).toContain('service_alpha');
      expect(agentsAndApps).toContain('service_beta');
      expect(agentsAndApps).toContain('standalone_agent');
      expect(agentsAndApps).toContain('standalone_app');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it(
    'should load App from directory entrypoint and expose App and rootAgent',
    async () => {
      const appFile = await loader.getAppFile('service_alpha');
      const loaded = await appFile.load();
      expect(isApp(loaded)).toBe(true);
      expect((loaded as App).name).toBe('alpha_app');

      const rootAgent = await appFile.loadAgent();
      expect(isBaseAgent(rootAgent)).toBe(true);
      expect(rootAgent.name).toBe('alpha_agent');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it(
    'should synthesize App when loadApp() is called on BaseAgent file',
    async () => {
      const agentFile = await loader.getAppFile('service_beta');
      const loaded = await agentFile.load();
      expect(isBaseAgent(loaded)).toBe(true);
      expect(isApp(loaded)).toBe(false);

      const synthApp = await agentFile.loadApp();
      expect(isApp(synthApp)).toBe(true);
      expect(synthApp.rootAgent.name).toBe('beta_agent');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  afterAll(async () => {
    await loader.disposeAll();
    await fs
      .rm(path.join(projectPath, 'node_modules'), {
        recursive: true,
        force: true,
      })
      .catch(() => {});
    await fs
      .unlink(path.join(projectPath, 'package-lock.json'))
      .catch(() => {});
  }, TEST_EXECUTION_TIMEOUT);
});
