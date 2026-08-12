/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  Event,
  InMemorySessionService,
  isApp,
  isBaseAgent,
  isGraphWorkflowAgent,
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
const projectPath = path.join(
  process.cwd(),
  'tests/integration/agent_loader/workflow_root',
);
const TEST_EXECUTION_TIMEOUT = 60000;

/**
 * Real compilation is the point of this file. The loader's unit tests mock
 * `esbuild.build` into a file copy, which leaves the interesting part of the
 * bundle untested: `packages: 'bundle'` inlines `@google/adk` into the compiled
 * agent, so the `Workflow` the loader inspects comes from a *second* copy of the
 * library. That is the case the `Symbol.for('google.adk.workflow')` brand exists
 * for, and the case an `instanceof` check would silently fail.
 */
async function runToCompletion(agent: BaseAgent): Promise<Event[]> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'workflow_root',
    userId: 'test_user',
  });
  const runner = new Runner({
    appName: 'workflow_root',
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

describe('Agent loader with a bare Workflow as the root', () => {
  let loader: AgentLoader;

  beforeAll(async () => {
    await execAsync('npm install', {cwd: projectPath});
    loader = new AgentLoader(projectPath);
  }, TEST_EXECUTION_TIMEOUT);

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

  it(
    'discovers an agent file that exports a Workflow',
    async () => {
      // Before a Workflow could be a root this was not an error, it was a
      // silence: the file exported nothing matching `isBaseAgent`, so the
      // directory simply did not show up.
      expect(await loader.listAgents()).toContain('graph');
      expect(await loader.listLoadFailures()).toEqual([]);
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it(
    'adapts the compiled Workflow into a runnable root agent',
    async () => {
      const agentFile = await loader.getAgentFile('graph');
      const rootAgent = await agentFile.loadAgent();

      expect(isBaseAgent(rootAgent)).toBe(true);
      // Still a WorkflowAgent, which is what the dev server's graph renderer
      // and the a2a card match on.
      expect(isGraphWorkflowAgent(rootAgent)).toBe(true);
      expect(rootAgent.name).toBe('workflow_root_graph');
      expect(rootAgent.description).toBe(
        'Normalizes the question, then answers it.',
      );
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it(
    'runs the loaded root through a real Runner',
    async () => {
      const agentFile = await loader.getAgentFile('graph');
      const events = await runToCompletion(await agentFile.loadAgent());

      // Both nodes ran, in order, on the user's message.
      expect(
        events.map((event) => event.output).filter((o) => o !== undefined),
      ).toEqual(['hello graph', 'graph handled: hello graph']);
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it(
    'synthesizes an App around a Workflow root',
    async () => {
      const agentFile = await loader.getAppFile('graph');
      const app = await agentFile.loadApp();

      expect(isApp(app)).toBe(true);
      expect(app.rootAgent.name).toBe('workflow_root_graph');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it(
    'still refuses a node that is not a Workflow',
    async () => {
      expect(await loader.listAgents()).not.toContain('lone_node');

      const agentFile = new AgentFile(
        path.join(projectPath, 'lone_node/agent.ts'),
      );
      await expect(agentFile.load()).rejects.toThrow(
        /No @google\/adk BaseAgent or Workflow instance found/,
      );
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it(
    'runs a Workflow-rooted agent file through `adk run`',
    async () => {
      const childProcess = spawn('npm', ['run', 'start'], {
        cwd: projectPath,
        shell: true,
      });

      const response = await sendInput(childProcess, 'Hello Graph\nexit\n');

      expect(response.toString()).toContain('graph handled: hello graph');
    },
    TEST_EXECUTION_TIMEOUT,
  );
});
