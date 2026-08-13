/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BashTool,
  BashToolPolicy,
  Context,
  createSession,
  ExecuteBashTool,
  InvocationContext,
  isBashTool,
  isExecuteBashTool,
  LlmAgent,
  PluginManager,
  ToolConfirmation,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

function makeContext(
  options: {
    functionCallId?: string;
    toolConfirmation?: ToolConfirmation;
  } = {},
): Context {
  const session = createSession({
    id: 's1',
    appName: 'app',
    userId: 'u1',
  });
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'test-agent', model: 'gemini-2.5-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({
    invocationContext,
    functionCallId: options.functionCallId ?? 'fc-1',
    ...options,
  });
}

describe('ExecuteBashTool & BashToolPolicy', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_bash_tool_test_'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, {recursive: true, force: true});
    }
  });

  describe('Initialization and Declaration', () => {
    it('initializes with default options', () => {
      const tool = new ExecuteBashTool();
      expect(tool.name).toBe('execute_bash');
      expect(tool.description).toContain('Executes a bash command');
      expect(tool.description).toContain('any command');
      expect(isExecuteBashTool(tool)).toBe(true);
      expect(isBashTool(tool)).toBe(true);
      expect(BashTool).toBe(ExecuteBashTool);
    });

    it('initializes with custom options and policy', () => {
      const policy = new BashToolPolicy({
        allowedCommandPrefixes: ['git', 'npm'],
        blockedOperators: ['|', ';'],
        timeoutSeconds: 15,
      });
      const tool = new ExecuteBashTool({
        name: 'custom_bash',
        workspace: tempDir,
        policy,
        requireConfirmation: false,
      });
      expect(tool.name).toBe('custom_bash');
      expect(tool.description).toContain('git, npm');
    });

    it('returns valid function declaration schema', () => {
      const tool = new ExecuteBashTool();
      const declaration = tool._getDeclaration();
      expect(declaration).toBeDefined();
      expect(declaration?.name).toBe('execute_bash');
      expect(declaration?.parameters?.type).toBe('OBJECT');
      expect(declaration?.parameters?.properties?.command).toBeDefined();
      expect(declaration?.parameters?.required).toEqual(['command']);
    });
  });

  describe('Policy Validation', () => {
    it('returns error when command is empty or whitespace', async () => {
      const tool = new ExecuteBashTool({requireConfirmation: false});
      const res1 = await tool.runAsync({
        args: {command: ''},
        toolContext: makeContext(),
      });
      expect(res1).toEqual({error: 'Command is required.'});

      const res2 = await tool.runAsync({
        args: {command: '   '},
        toolContext: makeContext(),
      });
      expect(res2).toEqual({error: 'Command is required.'});
    });

    it('blocks commands containing blocked operators', async () => {
      const tool = new ExecuteBashTool({
        policy: {blockedOperators: ['rm -rf', '>', '|']},
        requireConfirmation: false,
      });

      const res1 = await tool.runAsync({
        args: {command: 'ls -la | grep test'},
        toolContext: makeContext(),
      });
      expect(res1).toEqual({
        error: 'Command contains blocked operator: |',
      });

      const res2 = await tool.runAsync({
        args: {command: 'rm -rf /tmp/test'},
        toolContext: makeContext(),
      });
      expect(res2).toEqual({
        error: 'Command contains blocked operator: rm -rf',
      });
    });

    it('enforces allowed command prefixes', async () => {
      const tool = new ExecuteBashTool({
        policy: {allowedCommandPrefixes: ['git', 'npm run test']},
        requireConfirmation: false,
      });

      const resDisallowed = await tool.runAsync({
        args: {command: 'cat secret.txt'},
        toolContext: makeContext(),
      });
      expect(resDisallowed).toEqual({
        error: 'Command blocked. Permitted prefixes are: git, npm run test',
      });

      const resAllowed = await tool.runAsync({
        args: {command: 'git status'},
        toolContext: makeContext(),
      });
      // Should proceed to execution
      expect('returncode' in resAllowed).toBe(true);
    });
  });

  describe('Confirmation Gate (Human-in-the-Loop)', () => {
    it('requests confirmation when requireConfirmation is true and context has no confirmation', async () => {
      const tool = new ExecuteBashTool({requireConfirmation: true});
      const context = makeContext();
      const res = await tool.runAsync({
        args: {command: 'echo "hello"'},
        toolContext: context,
      });

      expect(res).toEqual({
        error:
          'This tool call requires confirmation, please approve or reject.',
      });
      expect(context.actions.skipSummarization).toBe(true);
    });

    it('returns rejected error when user declines confirmation', async () => {
      const tool = new ExecuteBashTool({requireConfirmation: true});
      const context = makeContext({
        toolConfirmation: new ToolConfirmation({confirmed: false}),
      });
      const res = await tool.runAsync({
        args: {command: 'echo "hello"'},
        toolContext: context,
      });

      expect(res).toEqual({error: 'This tool call is rejected.'});
    });

    it('executes command when confirmation is approved', async () => {
      const tool = new ExecuteBashTool({requireConfirmation: true});
      const context = makeContext({
        toolConfirmation: new ToolConfirmation({confirmed: true}),
      });
      const res = (await tool.runAsync({
        args: {command: 'echo "confirmed execution"'},
        toolContext: context,
      })) as {stdout: string; returncode: number};

      expect(res.returncode).toBe(0);
      expect(res.stdout).toContain('confirmed execution');
    });
  });

  describe('Command Execution & Environment', () => {
    it('executes a standard echo command and captures stdout', async () => {
      const tool = new ExecuteBashTool({requireConfirmation: false});
      const res = (await tool.runAsync({
        args: {command: 'node -e "console.log(\'test output 123\')"'},
        toolContext: makeContext(),
      })) as {stdout: string; stderr: string; returncode: number};

      expect(res.returncode).toBe(0);
      expect(res.stdout.trim()).toBe('test output 123');
      expect(res.stderr).toBe('<no stderr captured>');
    });

    it('executes command in the specified workspace directory', async () => {
      const testFilePath = path.join(tempDir, 'sample.txt');
      await fs.writeFile(testFilePath, 'workspace file content');

      const tool = new ExecuteBashTool({
        workspace: tempDir,
        requireConfirmation: false,
      });

      const res = (await tool.runAsync({
        args: {
          command:
            "node -e \"console.log(require('node:fs').readFileSync('sample.txt', 'utf8'))\"",
        },
        toolContext: makeContext(),
      })) as {stdout: string; returncode: number};

      expect(res.returncode).toBe(0);
      expect(res.stdout.trim()).toBe('workspace file content');
    });

    it('captures stderr and non-zero returncode on failure', async () => {
      const tool = new ExecuteBashTool({requireConfirmation: false});
      const res = (await tool.runAsync({
        args: {
          command:
            'node -e "process.stderr.write(\'error_in_test_execution\'); process.exit(1)"',
        },
        toolContext: makeContext(),
      })) as {stdout: string; stderr: string; returncode: number};

      expect(res.returncode).not.toBe(0);
      expect(res.stderr).toContain('error_in_test_execution');
    });

    it('handles command timeouts correctly', async () => {
      const tool = new ExecuteBashTool({
        policy: {timeoutSeconds: 1},
        requireConfirmation: false,
      });

      const res = (await tool.runAsync({
        args: {command: 'node -e "setTimeout(() => {}, 5000)"'},
        toolContext: makeContext(),
      })) as {error: string};

      expect(res.error).toBe('Command timed out after 1 seconds.');
    });
  });

  describe('Telemetry Hook', () => {
    it('detects tool error in response', () => {
      const tool = new ExecuteBashTool();
      expect(tool._detectErrorInResponse({error: 'Failed'})).toBe('TOOL_ERROR');
      expect(
        tool._detectErrorInResponse({
          stdout: 'ok',
          stderr: '<no stderr captured>',
          returncode: 0,
        }),
      ).toBeUndefined();
      expect(tool._detectErrorInResponse(null)).toBeUndefined();
    });
  });
});
