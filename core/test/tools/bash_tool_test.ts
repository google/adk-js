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
  isBashToolPolicy,
  isExecuteBashTool,
  LlmAgent,
  PluginManager,
  ToolConfirmation,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

/**
 * Commands are built from the Node binary running the tests, quoted so the
 * tokenizer keeps a path containing spaces in one argument.
 */
const NODE = JSON.stringify(process.execPath);

const IS_WINDOWS = process.platform === 'win32';

/** The tool refuses to execute at all off POSIX, as adk-python does. */
const describeOnPosix = IS_WINDOWS ? describe.skip : describe;

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

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ExecuteBashTool & BashToolPolicy', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_bash_tool_test_'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 500,
      });
    }
  });

  describe('Initialization and Declaration', () => {
    it('initializes with default options', () => {
      const tool = new ExecuteBashTool();
      expect(tool.name).toBe('execute_bash');
      expect(tool.description).toContain('Executes a command');
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

    it('tells the model that no shell is involved', () => {
      const declaration = new ExecuteBashTool()._getDeclaration();
      expect(declaration?.description).toContain('without a shell');
    });

    it('describes the confirmation gate only when it is enabled', () => {
      expect(new ExecuteBashTool().description).toContain(
        'All commands require user confirmation.',
      );
      expect(
        new ExecuteBashTool({requireConfirmation: false}).description,
      ).not.toContain('confirmation');
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

  describe('Policy Identification', () => {
    it('identifies policies by brand symbol rather than instanceof', () => {
      expect(isBashToolPolicy(new BashToolPolicy())).toBe(true);
      expect(isBashToolPolicy({allowedCommandPrefixes: ['git']})).toBe(false);
      expect(isBashToolPolicy(null)).toBe(false);
    });

    it('accepts a branded policy from another copy of the package', () => {
      // A structural duplicate carrying the same registered symbol, as a
      // second bundled copy of @google/adk would produce. `instanceof` would
      // reject this and silently rewrap it.
      const foreignPolicy = {
        [Symbol.for('google.adk.bashToolPolicy')]: true,
        allowedCommandPrefixes: ['git'],
        blockedOperators: [],
        timeoutSeconds: 7,
      } as unknown as BashToolPolicy;

      const tool = new ExecuteBashTool({policy: foreignPolicy});
      expect(tool.description).toContain('prefixes: git');
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

    it('rejects a command outside the allowed prefixes', async () => {
      const tool = new ExecuteBashTool({
        policy: {allowedCommandPrefixes: [NODE, 'npm run test']},
        requireConfirmation: false,
      });

      const res = await tool.runAsync({
        args: {command: 'cat secret.txt'},
        toolContext: makeContext(),
      });
      expect(res).toEqual({
        error: `Command blocked. Permitted prefixes are: ${NODE}, npm run test`,
      });
    });
  });

  describeOnPosix('Allowed Prefixes', () => {
    it('runs a command matching an allowed prefix', async () => {
      const tool = new ExecuteBashTool({
        policy: {allowedCommandPrefixes: [NODE, 'npm run test']},
        requireConfirmation: false,
      });

      const res = await tool.runAsync({
        args: {command: `${NODE} --version`},
        toolContext: makeContext(),
      });
      expect('returncode' in res).toBe(true);
    });
  });

  describeOnPosix('Shell Metacharacters Are Inert', () => {
    /**
     * Each of these passes the prefix allowlist, and under a shell each would
     * run a second program. The command is exec'd as an argument vector, so the
     * separator reaches `argv[0]` as a literal string and nothing else runs.
     */
    it.each([
      ['semicolon', ';'],
      ['logical and', '&&'],
      ['pipe', '|'],
      ['newline', '\n'],
      ['background', '&'],
    ])(
      'does not let a %s escape the prefix allowlist',
      async (_label, separator) => {
        const marker = path.join(tempDir, 'pwned.txt');
        const payload = `require('node:fs').writeFileSync('pwned.txt', 'x')`;
        const tool = new ExecuteBashTool({
          workspace: tempDir,
          policy: {allowedCommandPrefixes: [NODE]},
          requireConfirmation: false,
        });

        const res = await tool.runAsync({
          args: {
            command:
              `${NODE} -e "process.stdout.write('FIRST')" ` +
              `${separator} ${NODE} -e "${payload}"`,
          },
          toolContext: makeContext(),
        });

        expect(JSON.stringify(res)).not.toContain('PWNED');
        expect(await exists(marker)).toBe(false);
      },
    );

    it('does not let command substitution run a second program', async () => {
      const marker = path.join(tempDir, 'pwned.txt');
      const tool = new ExecuteBashTool({
        workspace: tempDir,
        policy: {allowedCommandPrefixes: [NODE]},
        requireConfirmation: false,
      });

      await tool.runAsync({
        args: {
          command:
            `${NODE} -e "process.stdout.write('FIRST')" ` +
            `$(${NODE} -e "require('node:fs').writeFileSync('pwned.txt','x')")`,
        },
        toolContext: makeContext(),
      });

      expect(await exists(marker)).toBe(false);
    });

    it('does not let redirection write a file', async () => {
      const marker = path.join(tempDir, 'redirected.txt');
      const tool = new ExecuteBashTool({
        workspace: tempDir,
        requireConfirmation: false,
      });

      await tool.runAsync({
        args: {
          command: `${NODE} -e "process.stdout.write('DATA')" > redirected.txt`,
        },
        toolContext: makeContext(),
      });

      expect(await exists(marker)).toBe(false);
    });

    it('passes separators through as literal arguments', async () => {
      const tool = new ExecuteBashTool({
        workspace: tempDir,
        requireConfirmation: false,
      });

      const res = (await tool.runAsync({
        args: {
          command:
            `${NODE} -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" ` +
            `';' '|' 'a b' "c;d" e\\ f`,
        },
        toolContext: makeContext(),
      })) as {stdout: string};

      expect(JSON.parse(res.stdout)).toEqual([';', '|', 'a b', 'c;d', 'e f']);
    });

    it('reports an unbalanced quote instead of executing', async () => {
      const tool = new ExecuteBashTool({
        workspace: tempDir,
        requireConfirmation: false,
      });

      const res = (await tool.runAsync({
        args: {command: `${NODE} -e "unterminated`},
        toolContext: makeContext(),
      })) as {error: string};

      expect(res.error).toBe('Execution failed: No closing quotation');
    });
  });

  describe('Confirmation Gate (Human-in-the-Loop)', () => {
    it('requests confirmation when requireConfirmation is true and context has no confirmation', async () => {
      const tool = new ExecuteBashTool({requireConfirmation: true});
      const context = makeContext();
      const res = await tool.runAsync({
        args: {command: `${NODE} -e "process.stdout.write('hello')"`},
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
        args: {command: `${NODE} -e "process.stdout.write('hello')"`},
        toolContext: context,
      });

      expect(res).toEqual({error: 'This tool call is rejected.'});
    });
  });

  describe('Platform Support', () => {
    // adk-python returns this same error rather than applying POSIX-shaped
    // rules to `cmd.exe`, whose metacharacters differ.
    it.runIf(IS_WINDOWS)(
      'refuses to execute on non-POSIX platforms',
      async () => {
        const tool = new ExecuteBashTool({requireConfirmation: false});
        const res = await tool.runAsync({
          args: {command: `${NODE} --version`},
          toolContext: makeContext(),
        });

        expect(res).toEqual({
          error: 'ExecuteBashTool is only supported on POSIX systems.',
        });
      },
    );

    it.runIf(!IS_WINDOWS)('executes on POSIX platforms', async () => {
      const tool = new ExecuteBashTool({requireConfirmation: false});
      const res = (await tool.runAsync({
        args: {command: `${NODE} --version`},
        toolContext: makeContext(),
      })) as {returncode: number};

      expect(res.returncode).toBe(0);
    });
  });

  describeOnPosix('Command Execution & Environment', () => {
    it('executes command when confirmation is approved', async () => {
      const tool = new ExecuteBashTool({requireConfirmation: true});
      const context = makeContext({
        toolConfirmation: new ToolConfirmation({confirmed: true}),
      });
      const res = (await tool.runAsync({
        args: {
          command: `${NODE} -e "process.stdout.write('confirmed execution')"`,
        },
        toolContext: context,
      })) as {stdout: string; returncode: number};

      expect(res.returncode).toBe(0);
      expect(res.stdout).toContain('confirmed execution');
    });

    it('executes without a confirmation when the gate is disabled', async () => {
      const tool = new ExecuteBashTool({requireConfirmation: false});
      // No `toolConfirmation` on the context: the gate is off, so it runs.
      const res = (await tool.runAsync({
        args: {command: `${NODE} -e "process.stdout.write('ungated')"`},
        toolContext: makeContext(),
      })) as {stdout: string; returncode: number};

      expect(res.returncode).toBe(0);
      expect(res.stdout).toContain('ungated');
    });

    it('executes a standard command and captures stdout', async () => {
      const tool = new ExecuteBashTool({requireConfirmation: false});
      const res = (await tool.runAsync({
        args: {
          command: `${NODE} -e "process.stdout.write('test output 123')"`,
        },
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
          command: `${NODE} -e "process.stdout.write(require('node:fs').readFileSync('sample.txt', 'utf8'))"`,
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
          command: `${NODE} -e "process.stderr.write('error_in_test_execution'); process.exit(1)"`,
        },
        toolContext: makeContext(),
      })) as {stdout: string; stderr: string; returncode: number};

      expect(res.returncode).not.toBe(0);
      expect(res.stderr).toContain('error_in_test_execution');
    });

    it('reports an unknown program as an execution failure', async () => {
      const tool = new ExecuteBashTool({requireConfirmation: false});
      const res = (await tool.runAsync({
        args: {command: 'adk_no_such_binary_for_tests --help'},
        toolContext: makeContext(),
      })) as {error: string};

      expect(res.error).toContain('Execution failed:');
    });
  });

  describeOnPosix('Timeouts', () => {
    it('handles command timeouts correctly', async () => {
      const tool = new ExecuteBashTool({
        policy: {timeoutSeconds: 1},
        requireConfirmation: false,
      });

      const res = (await tool.runAsync({
        args: {command: `${NODE} -e "setTimeout(() => {}, 30000)"`},
        toolContext: makeContext(),
      })) as {error: string};

      expect(res.error).toBe('Command timed out after 1 seconds.');
    });

    it('kills the whole process group, not just the direct child', async () => {
      const marker = path.join(tempDir, 'grandchild.txt');
      const scriptPath = path.join(tempDir, 'spawner.js');
      // The child spawns a grandchild that writes the marker after a delay,
      // then blocks past the timeout. Signalling only the child would leave the
      // grandchild running to write the marker.
      const grandchildScript =
        `setTimeout(() => require('node:fs')` +
        `.writeFileSync(process.argv[1], 'x'), 2000)`;
      await fs.writeFile(
        scriptPath,
        `const {spawn} = require('node:child_process');\n` +
          `spawn(process.execPath, [` +
          `'-e', ${JSON.stringify(grandchildScript)}, ${JSON.stringify(marker)}` +
          `], {stdio: 'ignore'});\n` +
          `setTimeout(() => {}, 30000);\n`,
      );

      const tool = new ExecuteBashTool({
        workspace: tempDir,
        policy: {timeoutSeconds: 1},
        requireConfirmation: false,
      });

      const res = (await tool.runAsync({
        args: {command: `${NODE} ${JSON.stringify(scriptPath)}`},
        toolContext: makeContext(),
      })) as {error: string};

      expect(res.error).toBe('Command timed out after 1 seconds.');

      // Well past the grandchild's 2s delay.
      await sleep(3500);
      expect(await exists(marker)).toBe(false);
    }, 20000);

    it('does not report a non-timeout signal as a timeout', async () => {
      const tool = new ExecuteBashTool({
        policy: {timeoutSeconds: 30},
        requireConfirmation: false,
      });

      // The command signals itself; that is not a timeout and must not be
      // reported as one.
      const res = (await tool.runAsync({
        args: {
          command: `${NODE} -e "process.kill(process.pid, 'SIGKILL')"`,
        },
        toolContext: makeContext(),
      })) as {error?: string; returncode: number | null};

      expect(res.error).toBeUndefined();
      expect(res.returncode).toBeNull();
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
