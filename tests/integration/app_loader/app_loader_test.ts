/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  Event,
  InMemorySessionService,
  isApp,
  isBaseAgent,
  isWorkflow,
  RunnableRoot,
  Runner,
} from '@google/adk';
import {exec, spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {AgentFile, AgentLoader} from '../../../dev/src/utils/agent_loader.js';
import {sendInput} from '../test_case_utils.js';

const execAsync = promisify(exec);
const dirname = process.cwd();
const TEST_EXECUTION_TIMEOUT = 60000;
const HOOK_TIMEOUT = 120000;

async function runToCompletion(agent: RunnableRoot): Promise<Event[]> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'app_loader',
    userId: 'test_user',
  });
  const runner = new Runner({
    appName: 'app_loader',
    agent,
    sessionService,
  });

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'test_user',
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'Hello Graph'}]},
  })) {
    events.push(event);
  }

  return events;
}

describe('App loader CLI integration', () => {
  describe.each(['app_ts', 'app_js', 'app_default', 'app_workflow'])(
    'App entrypoint with %s',
    (testCaseName: string) => {
      const projectPath = path.join(
        dirname,
        'tests/integration/app_loader',
        testCaseName,
      );

      beforeAll(async () => {
        await execAsync('npm install', {cwd: projectPath});
      }, HOOK_TIMEOUT);

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
      }, HOOK_TIMEOUT);
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
    await fs.writeFile(
      path.join(projectPath, 'node_modules', 'agent.js'),
      `const {BaseAgent} = require('@google/adk');
class NodeModulesAgent extends BaseAgent {
  constructor() { super({ name: 'node_modules_agent' }); }
}
exports.rootAgent = new NodeModulesAgent();`,
    );
    loader = new AgentLoader(projectPath);
    await loader.preloadAgents();
  }, HOOK_TIMEOUT);

  it(
    'should discover apps vs agents across directories and standalone files',
    async () => {
      const apps = await loader.listApps();
      expect(apps).toHaveLength(2);
      expect(apps).toContain('service_alpha');
      expect(apps).toContain('standalone_app');

      const agentsAndApps = await loader.listAgents();
      expect(agentsAndApps).toHaveLength(5);
      expect(agentsAndApps).toContain('service_alpha');
      expect(agentsAndApps).toContain('service_beta');
      // Before a Workflow could be a root this was not an error, it was a
      // silence: the file exported nothing matching `isBaseAgent`, so the
      // directory simply did not show up.
      expect(agentsAndApps).toContain('service_graph');
      expect(agentsAndApps).toContain('standalone_agent');
      expect(agentsAndApps).toContain('standalone_app');
      expect(agentsAndApps).not.toContain('.hidden');
      expect(agentsAndApps).not.toContain('node_modules');
      expect(await loader.listLoadFailures()).toEqual([]);
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

  /**
   * Real compilation is the point of these cases. The loader's unit tests mock
   * `esbuild.build` into a file copy, which leaves the interesting part of the
   * bundle untested: `packages: 'bundle'` inlines `@google/adk` into the
   * compiled agent, so the `Workflow` the loader inspects comes from a *second*
   * copy of the library. That is the case the
   * `Symbol.for('google.adk.workflow.workflow')` brand exists for, and the case
   * an `instanceof` check would silently fail.
   */
  it(
    'should load a compiled Workflow export as the root, unwrapped',
    async () => {
      const agentFile = await loader.getAgentFile('service_graph');
      const rootAgent = await agentFile.loadAgent();

      // Held as the workflow it is, not dressed as an agent: `isWorkflow` is
      // what the dev server's graph renderer and the a2a card match on.
      expect(isBaseAgent(rootAgent)).toBe(false);
      expect(isWorkflow(rootAgent)).toBe(true);
      expect(rootAgent.name).toBe('graph_workflow');
      expect(rootAgent.description).toBe(
        'Normalizes the question, then answers it.',
      );
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it(
    'should run a loaded Workflow root through a real Runner',
    async () => {
      const agentFile = await loader.getAgentFile('service_graph');
      const events = await runToCompletion(await agentFile.loadAgent());

      // Both nodes ran, in order, on the user's message.
      expect(
        events.map((event) => event.output).filter((o) => o !== undefined),
      ).toEqual(['hello graph', 'graph handled: hello graph']);
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it(
    'should synthesize an App around a Workflow root',
    async () => {
      const appFile = await loader.getAppFile('service_graph');
      const app = await appFile.loadApp();

      expect(isApp(app)).toBe(true);
      expect(app.rootAgent.name).toBe('graph_workflow');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it(
    'should still refuse a node that is not a Workflow',
    async () => {
      expect(await loader.listAgents()).not.toContain('lone_node');

      const agentFile = new AgentFile(path.join(projectPath, 'lone_node.ts'));
      await expect(agentFile.load()).rejects.toThrow(
        /No @google\/adk BaseAgent or Workflow instance found/,
      );
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
  }, HOOK_TIMEOUT);
});
