/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseCodeExecutor,
  CodeExecutionLanguage,
  CodeExecutionResult,
  Context,
  ExecuteCodeParams,
  File,
  FileContentEncoding,
  InvocationContext,
  LlmAgent,
  RunSkillScriptTool,
  Skill,
  SkillToolset,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {materializeFiles} from '../../../src/utils/file_utils.js';

vi.mock('../../../src/utils/file_utils.js', () => ({
  materializeFiles: vi.fn(),
}));

class MockCodeExecutor extends BaseCodeExecutor {
  mockResult: CodeExecutionResult = {
    stdout: '',
    stderr: '',
    outputFiles: [],
  };
  executeCodeParams: ExecuteCodeParams | undefined;
  shouldThrow = false;

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    this.executeCodeParams = params;
    if (this.shouldThrow) {
      throw new Error('Mock execution failure');
    }
    return this.mockResult;
  }
}

interface ToolErrorResponse {
  error: string;
  errorCode: string;
}

describe('RunSkillScriptTool', () => {
  // Running a script resolves an output directory and creates it on disk, even
  // here where materializeFiles itself is mocked. Point the tests at a temp
  // directory of their own and remove it in afterEach, so a failing assertion
  // cannot leave directories behind.
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill_script_test_'));
  });

  afterEach(async () => {
    await fs.rm(outputDir, {recursive: true, force: true});
  });

  function createMockContext(
    agentName = 'test-agent',
    agentExecutor?: BaseCodeExecutor,
  ): Context {
    const agentObj: Record<string | symbol, unknown> = {name: agentName};
    if (agentExecutor) {
      agentObj['codeExecutor'] = agentExecutor;
      agentObj[Symbol.for('google.adk.llmAgent')] = true;
    }

    return new Context({
      invocationContext: {
        session: {state: {}},
        agent: agentObj as unknown as LlmAgent,
      } as unknown as InvocationContext,
    });
  }

  const mockSkill: Skill = {
    frontmatter: {
      name: 'test-skill',
      description: 'A test skill',
    },
    instructions: 'Test instructions',
    resources: {
      scripts: {
        'setup.js': {src: 'console.log("setup");'},
        'run.sh': {src: 'echo "run";'},
      },
      references: {
        'doc.txt': 'Doc content',
      },
      assets: {
        'binary.dat': Buffer.from('hello', 'utf8'),
      },
    },
  };

  it('returns error if skill name is missing', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'Skill name is required.',
      errorCode: 'MISSING_SKILL_NAME',
    });
  });

  it('returns error if script path is missing', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'Script path is required.',
      errorCode: 'MISSING_SCRIPT_PATH',
    });
  });

  it('returns error if skill not found', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {skill_name: 'invalid-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: "Skill 'invalid-skill' not found.",
      errorCode: 'SKILL_NOT_FOUND',
    });
  });

  it('returns error if script not found in skill', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/invalid.js'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: "Script 'scripts/invalid.js' not found in skill 'test-skill'.",
      errorCode: 'SCRIPT_NOT_FOUND',
    });
  });

  it('returns error if no code executor configured', async () => {
    const toolset = new SkillToolset([mockSkill]); // no executor
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'No code executor configured.',
      errorCode: 'NO_CODE_EXECUTOR',
    });
  });

  it('executes script successfully via mock executor with JS wrapper', async () => {
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([mockSkill], {
      codeExecutor: mockExecutor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result.stdout).toBe('');
    expect(mockExecutor.executeCodeParams?.codeExecutionInput.code).toBe(
      "require('./scripts/setup.js');",
    );
    expect(mockExecutor.executeCodeParams?.codeExecutionInput.language).toBe(
      CodeExecutionLanguage.JAVASCRIPT,
    );
  });

  it('extracts skill resource files correctly', async () => {
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([mockSkill], {
      codeExecutor: mockExecutor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    });

    const inputFiles =
      mockExecutor.executeCodeParams?.codeExecutionInput.inputFiles;
    expect(inputFiles).toBeDefined();

    // 1 script, 1 reference, 1 asset
    expect(inputFiles?.length).toBe(4); // setup.js, run.sh, doc.txt, binary.dat

    const fileNames = inputFiles?.map((f) => f.name);
    expect(fileNames).toContain('scripts/setup.js');
    expect(fileNames).toContain('scripts/run.sh');
    expect(fileNames).toContain('references/doc.txt');
    expect(fileNames).toContain('assets/binary.dat');

    const binaryFile = inputFiles?.find((f) => f.name === 'assets/binary.dat');
    expect(binaryFile?.contentEncoding).toBe('base64');
  });

  it('sends a TypeScript script resource as UTF-8 text', async () => {
    const typescriptSkill: Skill = {
      frontmatter: {
        name: 'typescript-skill',
        description: 'A skill with a TypeScript script',
      },
      instructions: 'Test instructions',
      resources: {
        scripts: {'helper.ts': {src: 'export const x = 1;'}},
      },
    };
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([typescriptSkill], {
      codeExecutor: mockExecutor,
    });
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {
        skill_name: 'typescript-skill',
        script_path: 'scripts/helper.ts',
      },
      toolContext: createMockContext(),
    });

    const helper =
      mockExecutor.executeCodeParams?.codeExecutionInput.inputFiles?.find(
        (f) => f.name === 'scripts/helper.ts',
      );
    expect(helper?.contentEncoding).toBe(FileContentEncoding.UTF8);
    expect(helper?.mimeType).toBe('text/javascript');
    expect(helper?.content).toBe('export const x = 1;');
  });

  it('calls materializeFiles with output files from executor', async () => {
    const mockExecutor = new MockCodeExecutor();
    const testFile: File = {
      name: 'output.txt',
      content: 'hello',
      contentEncoding: FileContentEncoding.UTF8,
      mimeType: 'text/plain',
    };
    mockExecutor.mockResult = {
      stdout: '',
      stderr: '',
      outputFiles: [testFile],
    };

    const toolset = new SkillToolset([mockSkill], {
      codeExecutor: mockExecutor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    });

    expect(materializeFiles).toHaveBeenCalledWith([testFile], outputDir);
  });

  it('materializes output files into a dedicated dir, never the cwd', async () => {
    // Output file names are chosen by the executed script, i.e. by whatever a
    // prompt injection persuaded the model/skill to emit. Resolving them
    // against process.cwd() would let that content drop files into the host
    // application's working directory.
    const mockExecutor = new MockCodeExecutor();
    mockExecutor.mockResult = {stdout: '', stderr: '', outputFiles: []};

    const toolset = new SkillToolset([mockSkill], {codeExecutor: mockExecutor});
    const tool = new RunSkillScriptTool(toolset);

    // The module mock is shared by every test in this file and nothing clears
    // it between them, so reset first: otherwise a run that never reached
    // materializeFiles would silently assert against an earlier test's call.
    vi.mocked(materializeFiles).mockClear();

    await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    });

    expect(materializeFiles).toHaveBeenCalledTimes(1);
    const [, dir] = vi.mocked(materializeFiles).mock.calls[0];

    // This is the one test that exercises the default directory, so it owns
    // the cleanup: nothing else knows the generated name.
    try {
      expect(dir).toBeTypeOf('string');
      expect(dir).not.toBe(process.cwd());
      expect(path.resolve(dir)).toBe(dir);
      expect(dir.startsWith(os.tmpdir())).toBe(true);
    } finally {
      await fs.rm(dir, {recursive: true, force: true});
    }
  });

  it('honors an explicitly configured script output dir', async () => {
    const mockExecutor = new MockCodeExecutor();
    mockExecutor.mockResult = {stdout: '', stderr: '', outputFiles: []};

    const toolset = new SkillToolset([mockSkill], {
      codeExecutor: mockExecutor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    })) as {outputDirectory: string};

    expect(materializeFiles).toHaveBeenLastCalledWith([], outputDir);
    expect(result.outputDirectory).toBe(outputDir);
  });
});
