/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  CodeExecutionResult,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RunSkillInlineScriptTool,
  SkillToolset,
  ToolConfirmation,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

describe('RunSkillInlineScriptTool Integration with UnsafeLocalCodeExecutor', () => {
  // Inline-script output file names are chosen by the executed script, so the
  // tool materializes them into a dedicated directory instead of process.cwd().
  // Every toolset here points at a temp dir owned by the test and removed
  // afterwards: otherwise a failing assertion leaves files in the repository
  // root, and the default (a fresh mkdtemp per toolset, which nothing
  // removes) leaves a directory behind per test.
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'adk_skill_inline_it_'),
    );
  });

  afterEach(async () => {
    await fs.rm(outputDir, {recursive: true, force: true});
  });

  // These integration tests exercise real code execution, which is gated behind
  // a human-in-the-loop confirmation. Supply an already-confirmed confirmation
  // so the tool proceeds to execute (see run_skill_inline_script_tool.ts).
  function createMockContext(agentName = 'test-agent') {
    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: agentName}),
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
    });

    return new Context({
      invocationContext,
      toolConfirmation: new ToolConfirmation({confirmed: true}),
    });
  }

  it('successfully executes a real JavaScript inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log("hello from real js");',
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('hello from real js');
    expect(result.stderr).toBe('');
  });

  it('successfully executes a real Shell inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'echo "hello from real sh"',
        language: CodeExecutionLanguage.SHELL,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('hello from real sh');
    expect(result.stderr).toBe('');
  });

  it('captures stderr from a real JavaScript inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.error("some js error"); process.exit(1);',
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stderr).toContain('some js error');
  });

  it('captures stderr and exit code from a real Shell inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: '>&2 echo "some sh error"; exit 2',
        language: CodeExecutionLanguage.SHELL,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stderr).toContain('some sh error');
  });

  it('successfully executes a real Python inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'print("hello from real python")',
        language: CodeExecutionLanguage.PYTHON,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('hello from real python');
    expect(result.stderr).toBe('');
  });

  it('captures stderr from a real Python inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content:
          'import sys; sys.stderr.write("some python error\\n"); sys.exit(1)',
        language: CodeExecutionLanguage.PYTHON,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stderr).toContain('some python error');
  });

  it('materializes output files into the output dir, not process.cwd', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillInlineScriptTool(toolset);

    const testFileName = `test_output_${Date.now()}.txt`;
    const testFileContent = 'hello from output file';

    const result = (await tool.runAsync({
      args: {
        script_content: `const fs = require('fs'); fs.writeFileSync('${testFileName}', '${testFileContent}');`,
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult & {outputDirectory: string};

    expect(result).toBeDefined();
    expect(result.outputFiles).toBeDefined();
    expect(result.outputFiles?.length).toBeGreaterThan(0);

    const outputFile = result.outputFiles?.find((f) => f.name === testFileName);
    expect(outputFile).toBeDefined();
    expect(result.outputDirectory).toBe(outputDir);

    const fullPath = path.join(outputDir, testFileName);
    const content = await fs.readFile(fullPath, 'utf-8');
    expect(content).toBe(testFileContent);

    // Regression guard: the inline script is model-supplied and picks the
    // output file name, so resolving it against the host application's working
    // directory would let a prompt injection write into the running app's cwd.
    await expect(
      fs.access(path.join(process.cwd(), testFileName)),
    ).rejects.toThrow();
  });

  it('successfully passes array arguments to a JavaScript inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log(process.argv.slice(2).join(" "));',
        language: CodeExecutionLanguage.JAVASCRIPT,
        args: ['arg1', 'arg2'],
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('arg1 arg2');
  });

  it('successfully passes object arguments to a JavaScript inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log(process.argv.slice(2).join(" "));',
        language: CodeExecutionLanguage.JAVASCRIPT,
        args: {flag1: 'val1', flag2: 'val2'},
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('--flag1 val1 --flag2 val2');
  });

  it('handles file collisions by appending a numeric suffix', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {
      codeExecutor: executor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillInlineScriptTool(toolset);

    const testFileName = `test_inline_output_${Date.now()}.txt`;
    const testFileContent = 'hello from output file';

    // Pre-create the target file to force a collision
    const targetFile = path.join(outputDir, testFileName);
    await fs.writeFile(targetFile, 'existing content');

    const result = (await tool.runAsync({
      args: {
        script_content: `const fs = require('fs'); fs.writeFileSync('${testFileName}', '${testFileContent}');`,
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.outputFiles).toBeDefined();

    const baseName = path.basename(testFileName, '.txt');
    const expectedName = `${baseName}_2.txt`;

    const outputFile = result.outputFiles?.find((f) => f.name === expectedName);
    expect(outputFile).toBeDefined();

    const fullPath = path.join(outputDir, expectedName);
    const content = await fs.readFile(fullPath, 'utf-8');
    expect(content).toBe(testFileContent);

    // The pre-existing file must be left untouched rather than clobbered.
    expect(await fs.readFile(targetFile, 'utf-8')).toBe('existing content');
  });
});
