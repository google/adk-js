/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionResult,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RunSkillScriptTool,
  Skill,
  SkillToolset,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const IS_WINDOWS = os.platform() === 'win32';
const IS_UNIX = os.platform() === 'linux' || os.platform() === 'darwin';

// PowerShell/cmd cold-start on the windows-latest CI runner can exceed vitest's
// 5000ms default. Must also exceed UnsafeLocalCodeExecutor's default
// timeoutSeconds (30) so the executor's own timeout error surfaces first; see
// core/src/code_executors/unsafe_local_code_executor.ts
const TEST_EXECUTION_TIMEOUT = 40000;

describe('RunSkillScriptTool Integration with UnsafeLocalCodeExecutor', () => {
  // Script output file names are chosen by the executed script, so the tool
  // materializes them into a dedicated directory instead of process.cwd().
  // Every toolset here points at a temp dir owned by the test and removed
  // afterwards: otherwise a failing assertion leaves files in the repository
  // root, and the default (a fresh mkdtemp per toolset, which nothing
  // removes) leaves a directory behind per test.
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'adk_skill_script_it_'),
    );
  });

  afterEach(async () => {
    await fs.rm(outputDir, {recursive: true, force: true});
  });

  function createMockContext(agentName = 'test-agent') {
    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: agentName}),
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
    });

    return new Context({invocationContext});
  }

  const testSkill: Skill = {
    frontmatter: {
      name: 'test-skill',
      description: 'A mock skill for integration tests',
    },
    instructions: 'Run scripts.',
    resources: {
      scripts: {
        'hello.js': {
          src: 'console.log("hello from skill js");',
        },
        'hello.sh': {
          src: 'echo "hello from skill sh"',
        },
        'fail.js': {
          src: 'console.error("skill js error"); process.exit(1);',
        },
        'fail.sh': {
          src: '>&2 echo "skill sh error"; exit 2',
        },
        'hello.py': {
          src: 'print("hello from skill python")',
        },
        'fail.py': {
          src: 'import sys; sys.stderr.write("skill python error\\n"); sys.exit(1)',
        },
        'create_file.js': {
          src: "const fs = require('fs'); fs.writeFileSync('output_from_script.txt', 'hello from script file');",
        },
        'hello.ps1': {
          src: 'Write-Host "hello from skill powershell"',
        },
        'hello.bat': {
          src: '@echo off\necho hello from skill cmd',
        },
        'fail.ps1': {
          src: 'Write-Error "skill powershell error"; exit 1',
        },
        'fail.bat': {
          src: '@echo off\n>&2 echo skill cmd error\nexit /b 1',
        },
      },
    },
  };

  it('successfully executes a real JavaScript skill script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([testSkill], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/hello.js',
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('hello from skill js');
    expect(result.stderr).toBe('');
  });

  it.skipIf(!IS_UNIX)(
    'successfully executes a real Shell skill script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([testSkill], {
        codeExecutor: executor,
        scriptOutputDir: outputDir,
      });
      const tool = new RunSkillScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          skill_name: 'test-skill',
          script_path: 'scripts/hello.sh',
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      expect(result.stdout).toContain('hello from skill sh');
      expect(result.stderr).toBe('');
    },
  );

  it('captures stderr from a failing JavaScript skill script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([testSkill], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/fail.js',
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stderr).toContain('skill js error');
  });

  it.skipIf(!IS_UNIX)(
    'captures stderr and exit code from a failing Shell skill script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([testSkill], {
        codeExecutor: executor,
        scriptOutputDir: outputDir,
      });
      const tool = new RunSkillScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          skill_name: 'test-skill',
          script_path: 'scripts/fail.sh',
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      expect(result.stderr).toContain('skill sh error');
    },
  );

  it('successfully executes a real Python skill script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([testSkill], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/hello.py',
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('hello from skill python');
    expect(result.stderr).toBe('');
  });

  it('captures stderr from a failing Python skill script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([testSkill], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/fail.py',
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stderr).toContain('skill python error');
  });

  it.skipIf(!IS_WINDOWS)(
    'successfully executes a real PowerShell skill script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([testSkill], {
        codeExecutor: executor,
        scriptOutputDir: outputDir,
      });
      const tool = new RunSkillScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          skill_name: 'test-skill',
          script_path: 'scripts/hello.ps1',
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      expect(result.stdout).toContain('hello from skill powershell');
      expect(result.stderr).toBe('');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it.skipIf(!IS_WINDOWS)(
    'captures stderr from a failing PowerShell skill script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([testSkill], {
        codeExecutor: executor,
        scriptOutputDir: outputDir,
      });
      const tool = new RunSkillScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          skill_name: 'test-skill',
          script_path: 'scripts/fail.ps1',
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      expect(result.stderr).toContain('skill');
      expect(result.stderr).toContain('powershell error');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it.skipIf(!IS_WINDOWS)(
    'successfully executes a real CMD skill script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([testSkill], {
        codeExecutor: executor,
        scriptOutputDir: outputDir,
      });
      const tool = new RunSkillScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          skill_name: 'test-skill',
          script_path: 'scripts/hello.bat',
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      expect(result.stdout).toContain('hello from skill cmd');
      expect(result.stderr).toBe('');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it.skipIf(!IS_WINDOWS)(
    'captures stderr from a failing CMD skill script',
    async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([testSkill], {
        codeExecutor: executor,
        scriptOutputDir: outputDir,
      });
      const tool = new RunSkillScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          skill_name: 'test-skill',
          script_path: 'scripts/fail.bat',
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result).toBeDefined();
      expect(result.stderr).toContain('skill cmd error');
    },
    TEST_EXECUTION_TIMEOUT,
  );

  it('materializes output files into the output dir, not process.cwd', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([testSkill], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/create_file.js',
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult & {outputDirectory: string};

    expect(result).toBeDefined();
    expect(result.outputFiles).toBeDefined();
    expect(result.outputFiles?.length).toBeGreaterThan(0);

    const outputFile = result.outputFiles?.find(
      (f) => f.name === 'output_from_script.txt',
    );
    expect(outputFile).toBeDefined();
    expect(result.outputDirectory).toBe(outputDir);

    const fullPath = path.join(outputDir, 'output_from_script.txt');
    const content = await fs.readFile(fullPath, 'utf-8');
    expect(content).toBe('hello from script file');

    // Regression guard: the script picks the output file name, so resolving it
    // against the host application's working directory would let a
    // prompt-injected skill drop files into the running app's cwd.
    await expect(
      fs.access(path.join(process.cwd(), 'output_from_script.txt')),
    ).rejects.toThrow();
  });

  it('handles file collisions by appending a numeric suffix', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([testSkill], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillScriptTool(toolset);

    // Pre-create the target file to force a collision
    const targetFile = path.join(outputDir, 'output_from_script.txt');
    await fs.writeFile(targetFile, 'existing content');

    const result = (await tool.runAsync({
      args: {
        skill_name: 'test-skill',
        script_path: 'scripts/create_file.js',
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.outputFiles).toBeDefined();

    const outputFile = result.outputFiles?.find(
      (f) => f.name === 'output_from_script_2.txt',
    );
    expect(outputFile).toBeDefined();

    const fullPath = path.join(outputDir, 'output_from_script_2.txt');
    const content = await fs.readFile(fullPath, 'utf-8');
    expect(content).toBe('hello from script file');

    // The pre-existing file must be left untouched rather than clobbered.
    expect(await fs.readFile(targetFile, 'utf-8')).toBe('existing content');
  });
});
