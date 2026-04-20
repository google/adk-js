/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  CodeExecutionResult,
  Context,
  InvocationContext,
  RunSkillInlineScriptTool,
  SkillToolset,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

describe('RunSkillInlineScriptTool Integration with UnsafeLocalCodeExecutor', () => {
  function createMockContext(agentName = 'test-agent') {
    return new Context({
      invocationContext: {
        session: {state: {}},
        agent: {name: agentName},
      } as unknown as InvocationContext,
    });
  }

  it('successfully executes a real JavaScript inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
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
    const toolset = new SkillToolset([], {codeExecutor: executor});
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
    const toolset = new SkillToolset([], {codeExecutor: executor});
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
    const toolset = new SkillToolset([], {codeExecutor: executor});
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
    const toolset = new SkillToolset([], {codeExecutor: executor});
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
    const toolset = new SkillToolset([], {codeExecutor: executor});
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

  it('creates files in process.cwd returned from execution', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const testFileName = `test_output_${Date.now()}.txt`;
    const testFileContent = 'hello from output file';

    const result = (await tool.runAsync({
      args: {
        script_content: `const fs = require('fs'); fs.writeFileSync('${testFileName}', '${testFileContent}');`,
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.outputFiles).toBeDefined();
    expect(result.outputFiles?.length).toBeGreaterThan(0);

    const outputFile = result.outputFiles?.find((f) => f.name === testFileName);
    expect(outputFile).toBeDefined();

    // Verify file was created in process.cwd()
    const fullPath = path.join(process.cwd(), testFileName);
    const exists = await fs
      .access(fullPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    const content = await fs.readFile(fullPath, 'utf-8');
    expect(content).toBe(testFileContent);

    // Clean up
    await fs.unlink(fullPath);
  });

  it('successfully passes array arguments to a JavaScript inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
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
    const toolset = new SkillToolset([], {codeExecutor: executor});
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
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const testFileName = `test_inline_output_${Date.now()}.txt`;
    const testFileContent = 'hello from output file';

    // Pre-create the target file to force a collision
    const targetFile = path.join(process.cwd(), testFileName);
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

    // Verify collision file was created in process.cwd()
    const fullPath = path.join(process.cwd(), expectedName);
    const exists = await fs
      .access(fullPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    const content = await fs.readFile(fullPath, 'utf-8');
    expect(content).toBe(testFileContent);

    // Clean up both files
    await fs.unlink(targetFile);
    await fs.unlink(fullPath);
  });
});
