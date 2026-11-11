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
  RunSkillInlineScriptErrorCode,
  RunSkillInlineScriptTool,
  SkillToolset,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ToolConfirmation} from '../../../src/tools/tool_confirmation.js';
import {materializeFiles} from '../../../src/utils/file_utils.js';

vi.mock('../../../src/utils/file_utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/utils/file_utils.js')>();
  return {
    ...actual,
    materializeFiles: vi.fn().mockImplementation((files) => files),
  };
});

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
  errorCode: RunSkillInlineScriptErrorCode;
}

describe('RunSkillInlineScriptTool', () => {
  // Running a script resolves an output directory and creates it on disk, even
  // here where materializeFiles itself is mocked. Point the tests at a temp
  // directory of their own and remove it in afterEach, so a failing assertion
  // cannot leave directories behind.
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill_inline_test_'));
  });

  afterEach(async () => {
    await fs.rm(outputDir, {recursive: true, force: true});
  });

  function createMockContext(
    agentName = 'test-agent',
    agentExecutor?: BaseCodeExecutor,
    options: {
      functionCallId?: string;
      toolConfirmation?: ToolConfirmation;
    } = {},
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
      functionCallId: options.functionCallId,
      toolConfirmation: options.toolConfirmation,
    });
  }

  /**
   * A confirmed confirmation lets execution proceed past the security gate.
   */
  function confirmed(): ToolConfirmation {
    return new ToolConfirmation({confirmed: true});
  }

  it('returns error if script content is missing', async () => {
    const toolset = new SkillToolset([]);
    const tool = new RunSkillInlineScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {language: CodeExecutionLanguage.JAVASCRIPT},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'Script content is required.',
      errorCode: RunSkillInlineScriptErrorCode.MISSING_SCRIPT_CONTENT,
    });
  });

  it('returns error if language is missing', async () => {
    const toolset = new SkillToolset([]);
    const tool = new RunSkillInlineScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {script_content: 'console.log("test");'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'Language is required.',
      errorCode: RunSkillInlineScriptErrorCode.MISSING_LANGUAGE,
    });
  });

  it('returns error if no code executor configured', async () => {
    const toolset = new SkillToolset([]); // no executor
    const tool = new RunSkillInlineScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log("test");',
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'No code executor configured.',
      errorCode: RunSkillInlineScriptErrorCode.NO_CODE_EXECUTOR,
    });
  });

  it('falls back to agent code executor when toolset executor is absent', async () => {
    const agentExecutor = new MockCodeExecutor();
    agentExecutor.mockResult = {
      stdout: 'agent fallback stdout',
      stderr: '',
      outputFiles: [],
    };

    // No executor: the agent's is used instead.
    const toolset = new SkillToolset([], {scriptOutputDir: outputDir});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log("agent");',
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext('agent-with-exec', agentExecutor, {
        toolConfirmation: confirmed(),
      }),
    })) as CodeExecutionResult;

    expect(result.stdout).toBe('agent fallback stdout');
    expect(agentExecutor.executeCodeParams?.codeExecutionInput.code).toBe(
      'console.log("agent");',
    );
  });

  it('returns execution error when executor throws', async () => {
    const mockExecutor = new MockCodeExecutor();
    mockExecutor.shouldThrow = true;

    const toolset = new SkillToolset([], {codeExecutor: mockExecutor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log("error");',
        language: CodeExecutionLanguage.PYTHON,
      },
      toolContext: createMockContext('test-agent', undefined, {
        toolConfirmation: confirmed(),
      }),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'Failed to execute inline script: Mock execution failure',
      errorCode: RunSkillInlineScriptErrorCode.EXECUTION_ERROR,
    });
  });

  it('successfully passes parameters to code executor', async () => {
    const mockExecutor = new MockCodeExecutor();
    mockExecutor.mockResult = {
      stdout: 'mock output',
      stderr: 'mock warning',
      outputFiles: [],
    };

    const toolset = new SkillToolset([], {
      codeExecutor: mockExecutor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillInlineScriptTool(toolset);

    const mockToolContext = createMockContext('test-agent', undefined, {
      toolConfirmation: confirmed(),
    });

    const result = (await tool.runAsync({
      args: {
        script_content: 'echo "hi"',
        language: CodeExecutionLanguage.SHELL,
        args: {flag: true, count: 5},
      },
      toolContext: mockToolContext,
    })) as CodeExecutionResult;

    expect(result).toEqual({
      stdout: 'mock output',
      stderr: 'mock warning',
      outputFiles: [],
      outputDirectory: outputDir,
    });

    expect(mockExecutor.executeCodeParams).toBeDefined();
    expect(mockExecutor.executeCodeParams?.invocationContext).toBe(
      mockToolContext.invocationContext,
    );
    expect(mockExecutor.executeCodeParams?.codeExecutionInput).toEqual({
      code: 'echo "hi"',
      inputFiles: [],
      language: CodeExecutionLanguage.SHELL,
      args: {flag: true, count: 5},
    });
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

    const toolset = new SkillToolset([], {codeExecutor: mockExecutor});
    const tool = new RunSkillInlineScriptTool(toolset);

    await tool.runAsync({
      args: {
        script_content: 'console.log("test");',
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext('test-agent', undefined, {
        toolConfirmation: confirmed(),
      }),
    });

    // Output file names come from the model-supplied inline script, so they
    // must be resolved against a dedicated output directory rather than
    // process.cwd(). This is the one test that exercises the default
    // directory, so it owns the cleanup: nothing else knows the generated
    // name.
    const defaultDir = await toolset.getScriptOutputDir();
    try {
      expect(materializeFiles).toHaveBeenCalledWith([testFile], defaultDir);
      expect(defaultDir).not.toBe(process.cwd());
      expect(defaultDir.startsWith(os.tmpdir())).toBe(true);
    } finally {
      await fs.rm(defaultDir, {recursive: true, force: true});
    }
  });

  it('successfully passes array arguments to code executor', async () => {
    const mockExecutor = new MockCodeExecutor();
    mockExecutor.mockResult = {
      stdout: 'mock output',
      stderr: '',
      outputFiles: [],
    };

    const toolset = new SkillToolset([], {
      codeExecutor: mockExecutor,
      scriptOutputDir: outputDir,
    });
    const tool = new RunSkillInlineScriptTool(toolset);

    const mockToolContext = createMockContext('test-agent', undefined, {
      toolConfirmation: confirmed(),
    });

    await tool.runAsync({
      args: {
        script_content: 'echo "hi"',
        language: CodeExecutionLanguage.SHELL,
        args: ['arg1', 'arg2'],
      },
      toolContext: mockToolContext,
    });

    expect(mockExecutor.executeCodeParams?.codeExecutionInput.args).toEqual([
      'arg1',
      'arg2',
    ]);
  });

  describe('confirmation gate', () => {
    it('blocks execution and requests confirmation on the first call', async () => {
      const mockExecutor = new MockCodeExecutor();
      const toolset = new SkillToolset([], {codeExecutor: mockExecutor});
      const tool = new RunSkillInlineScriptTool(toolset);

      // No toolConfirmation provided -> the tool must pause and request one.
      const mockToolContext = createMockContext('test-agent', undefined, {
        functionCallId: 'fc-1',
      });

      const result = (await tool.runAsync({
        args: {
          script_content: 'rm -rf /',
          language: CodeExecutionLanguage.SHELL,
        },
        toolContext: mockToolContext,
      })) as {partial: string};

      // Execution must NOT have happened.
      expect(mockExecutor.executeCodeParams).toBeUndefined();

      // An intermediate "needs confirmation" result is returned.
      expect(result).toEqual({
        partial:
          'This tool call needs external confirmation before completion.',
      });

      // A confirmation request was recorded against the function call id and
      // it surfaces the script + language to the client.
      const requested =
        mockToolContext.actions.requestedToolConfirmations['fc-1'];
      expect(requested).toBeDefined();
      expect(requested.confirmed).toBe(false);
      expect(requested.hint).toContain('rm -rf /');
      expect(requested.hint).toContain(CodeExecutionLanguage.SHELL);
      expect(requested.payload).toEqual({
        language: CodeExecutionLanguage.SHELL,
        scriptContent: 'rm -rf /',
      });
    });

    it('rejects execution when confirmation is not confirmed', async () => {
      const mockExecutor = new MockCodeExecutor();
      const toolset = new SkillToolset([], {codeExecutor: mockExecutor});
      const tool = new RunSkillInlineScriptTool(toolset);

      const mockToolContext = createMockContext('test-agent', undefined, {
        functionCallId: 'fc-2',
        toolConfirmation: new ToolConfirmation({confirmed: false}),
      });

      const result = (await tool.runAsync({
        args: {
          script_content: 'console.log("nope");',
          language: CodeExecutionLanguage.JAVASCRIPT,
        },
        toolContext: mockToolContext,
      })) as ToolErrorResponse;

      // Execution must NOT have happened.
      expect(mockExecutor.executeCodeParams).toBeUndefined();
      expect(result).toEqual({
        error: 'Inline script execution was not confirmed and was rejected.',
        errorCode: RunSkillInlineScriptErrorCode.CONFIRMATION_REJECTED,
      });
    });

    it('proceeds with execution once confirmed', async () => {
      const mockExecutor = new MockCodeExecutor();
      mockExecutor.mockResult = {
        stdout: 'confirmed output',
        stderr: '',
        outputFiles: [],
      };
      const toolset = new SkillToolset([], {
        codeExecutor: mockExecutor,
        scriptOutputDir: outputDir,
      });
      const tool = new RunSkillInlineScriptTool(toolset);

      const mockToolContext = createMockContext('test-agent', undefined, {
        functionCallId: 'fc-3',
        toolConfirmation: new ToolConfirmation({confirmed: true}),
      });

      const result = (await tool.runAsync({
        args: {
          script_content: 'console.log("go");',
          language: CodeExecutionLanguage.JAVASCRIPT,
        },
        toolContext: mockToolContext,
      })) as CodeExecutionResult;

      expect(result.stdout).toBe('confirmed output');
      expect(mockExecutor.executeCodeParams?.codeExecutionInput.code).toBe(
        'console.log("go");',
      );
      // No new confirmation was requested when already confirmed.
      expect(
        mockToolContext.actions.requestedToolConfirmations['fc-3'],
      ).toBeUndefined();
    });
  });

  describe('error codes', () => {
    it('exposes stable string values for the error-code enum', () => {
      // The error-code string values are part of the tool's response contract
      // and must remain stable across releases.
      expect(RunSkillInlineScriptErrorCode.MISSING_SCRIPT_CONTENT).toBe(
        'MISSING_SCRIPT_CONTENT',
      );
      expect(RunSkillInlineScriptErrorCode.MISSING_LANGUAGE).toBe(
        'MISSING_LANGUAGE',
      );
      expect(RunSkillInlineScriptErrorCode.NO_CODE_EXECUTOR).toBe(
        'NO_CODE_EXECUTOR',
      );
      expect(RunSkillInlineScriptErrorCode.EXECUTION_ERROR).toBe(
        'EXECUTION_ERROR',
      );
      expect(RunSkillInlineScriptErrorCode.CONFIRMATION_REJECTED).toBe(
        'CONFIRMATION_REJECTED',
      );
    });
  });
});
