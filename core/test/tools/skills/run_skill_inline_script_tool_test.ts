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
  RunSkillInlineScriptTool,
  SkillToolset,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {materializeFiles} from '../../../src/utils/file_utils.js';

vi.mock('../../../src/utils/file_utils.js', () => ({
  materializeFiles: vi.fn().mockImplementation((files) => files),
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

describe('RunSkillInlineScriptTool', () => {
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

  it('returns error if script content is missing', async () => {
    const toolset = new SkillToolset([]);
    const tool = new RunSkillInlineScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {language: CodeExecutionLanguage.JAVASCRIPT},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'Script content is required.',
      errorCode: 'MISSING_SCRIPT_CONTENT',
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
      errorCode: 'MISSING_LANGUAGE',
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
      errorCode: 'NO_CODE_EXECUTOR',
    });
  });

  it('falls back to agent code executor when toolset executor is absent', async () => {
    const agentExecutor = new MockCodeExecutor();
    agentExecutor.mockResult = {
      stdout: 'agent fallback stdout',
      stderr: '',
      outputFiles: [],
    };

    const toolset = new SkillToolset([]); // no executor
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log("agent");',
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext('agent-with-exec', agentExecutor),
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
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'Failed to execute inline script: Mock execution failure',
      errorCode: 'EXECUTION_ERROR',
    });
  });

  it('successfully passes parameters to code executor', async () => {
    const mockExecutor = new MockCodeExecutor();
    mockExecutor.mockResult = {
      stdout: 'mock output',
      stderr: 'mock warning',
      outputFiles: [],
    };

    const toolset = new SkillToolset([], {codeExecutor: mockExecutor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const mockToolContext = createMockContext();

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
      toolContext: createMockContext(),
    });

    expect(materializeFiles).toHaveBeenCalledWith([testFile]);
  });

  it('successfully passes array arguments to code executor', async () => {
    const mockExecutor = new MockCodeExecutor();
    mockExecutor.mockResult = {
      stdout: 'mock output',
      stderr: '',
      outputFiles: [],
    };

    const toolset = new SkillToolset([], {codeExecutor: mockExecutor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const mockToolContext = createMockContext();

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
});
