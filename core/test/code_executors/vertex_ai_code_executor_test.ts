/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  VertexAiCodeExecutor as BarrelVertexAiCodeExecutor,
  CodeExecutionLanguage,
  type ExecuteCodeParams,
} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {
  type CodeInterpreterExecuteParams,
  type CodeInterpreterExtension,
  type CodeInterpreterResponse,
  VertexAiCodeExecutor,
} from '../../src/code_executors/vertex_ai_code_executor.js';
import {VertexAiCodeExecutor as IndexVertexAiCodeExecutor} from '../../src/index.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';
import {logger} from '../../src/utils/logger.js';

const VALID_RESOURCE_NAME =
  'projects/test-project/locations/us-central1/extensions/12345';

function createFakeExtension(
  response: CodeInterpreterResponse = {},
): CodeInterpreterExtension & {calls: CodeInterpreterExecuteParams[]} {
  const calls: CodeInterpreterExecuteParams[] = [];
  return {
    resourceName: VALID_RESOURCE_NAME,
    calls,
    async execute(
      params: CodeInterpreterExecuteParams,
    ): Promise<CodeInterpreterResponse> {
      calls.push(params);
      return response;
    },
  };
}

function makeExecuteParams(
  overrides: Partial<ExecuteCodeParams['codeExecutionInput']> = {},
): ExecuteCodeParams {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    session: createSession({
      id: 'session-1',
      appName: 'test-app',
      userId: 'user-1',
    }),
    pluginManager: new PluginManager(),
  });
  return {
    invocationContext,
    codeExecutionInput: {
      code: 'print("hello")',
      language: CodeExecutionLanguage.PYTHON,
      inputFiles: [],
      ...overrides,
    },
  };
}

describe('VertexAiCodeExecutor', () => {
  const originalEnv = process.env.CODE_INTERPRETER_EXTENSION_NAME;

  beforeEach(() => {
    delete process.env.CODE_INTERPRETER_EXTENSION_NAME;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CODE_INTERPRETER_EXTENSION_NAME;
    } else {
      process.env.CODE_INTERPRETER_EXTENSION_NAME = originalEnv;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constructor and resourceName validation', () => {
    it('accepts a well-formed resourceName and is exported from the main barrel', () => {
      expect(IndexVertexAiCodeExecutor).toBe(VertexAiCodeExecutor);
      const executor = new VertexAiCodeExecutor({
        resourceName: VALID_RESOURCE_NAME,
      });
      const barrelExecutor = new BarrelVertexAiCodeExecutor({
        resourceName: VALID_RESOURCE_NAME,
      });
      expect(executor.resourceName).toBe(VALID_RESOURCE_NAME);
      expect(barrelExecutor.resourceName).toBe(VALID_RESOURCE_NAME);
    });

    it('throws when options.resourceName is malformed', () => {
      expect(
        () =>
          new VertexAiCodeExecutor({
            resourceName: 'projects/test-project/extensions/12345',
          }),
      ).toThrow(
        'Extension resource name projects/test-project/extensions/12345 is not valid.',
      );
    });

    it('reads resourceName from CODE_INTERPRETER_EXTENSION_NAME when options.resourceName is omitted', () => {
      process.env.CODE_INTERPRETER_EXTENSION_NAME = VALID_RESOURCE_NAME;
      const executor = new VertexAiCodeExecutor();
      expect(executor.resourceName).toBe(VALID_RESOURCE_NAME);
    });

    it('logs a warning and leaves resourceName undefined when CODE_INTERPRETER_EXTENSION_NAME is malformed', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      process.env.CODE_INTERPRETER_EXTENSION_NAME = 'invalid-env-resource';

      const executor = new VertexAiCodeExecutor();

      expect(executor.resourceName).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        'Extension resource name invalid-env-resource is not valid.',
      );
    });

    it('forwards BaseCodeExecutor configuration options', () => {
      const executor = new VertexAiCodeExecutor({
        resourceName: VALID_RESOURCE_NAME,
        optimizeDataFile: true,
        stateful: true,
        errorRetryAttempts: 5,
        codeBlockDelimiters: [['```py\n', '\n```']],
        executionResultDelimiters: ['<out>', '</out>'],
      });

      expect(executor.optimizeDataFile).toBe(true);
      expect(executor.stateful).toBe(true);
      expect(executor.errorRetryAttempts).toBe(5);
      expect(executor.codeBlockDelimiters).toEqual([['```py\n', '\n```']]);
      expect(executor.executionResultDelimiters).toEqual(['<out>', '</out>']);
    });
  });

  describe('executeCode', () => {
    it('prepends default library imports and helper functions to the executed code', async () => {
      const extension = createFakeExtension({
        execution_result: '42\n',
      });
      const executor = new VertexAiCodeExecutor({
        codeInterpreterExtension: extension,
      });

      const result = await executor.executeCode(
        makeExecuteParams({code: 'print(40 + 2)'}),
      );

      expect(result).toEqual({
        stdout: '42\n',
        stderr: '',
        outputFiles: [],
      });
      expect(extension.calls).toHaveLength(1);
      expect(extension.calls[0].operationId).toBe('execute');
      const executedCode = extension.calls[0].operationParams.code;
      expect(executedCode).toContain('import matplotlib.pyplot as plt');
      expect(executedCode).toContain('import numpy as np');
      expect(executedCode).toContain('import pandas as pd');
      expect(executedCode).toContain("return s[: max_chars - 3] + '...'");
      expect(executedCode).toContain('def explore_df(');
      expect(executedCode.endsWith('\n\nprint(40 + 2)\n')).toBe(true);
      expect(extension.calls[0].operationParams.files).toBeUndefined();
      expect(extension.calls[0].operationParams.session_id).toBeUndefined();
    });

    it('includes inputFiles and executionId in operationParams when provided', async () => {
      const extension = createFakeExtension({
        execution_result: 'ok',
        execution_error: 'warn',
      });
      const executor = new VertexAiCodeExecutor({
        codeInterpreterExtension: extension,
      });

      const result = await executor.executeCode(
        makeExecuteParams({
          code: 'df = pd.read_csv("input.csv")',
          inputFiles: [
            {
              name: 'input.csv',
              content: 'col1,col2\n1,2',
              mimeType: 'text/csv',
            },
          ],
          executionId: 'session-abc',
        }),
      );

      expect(result.stdout).toBe('ok');
      expect(result.stderr).toBe('warn');
      expect(extension.calls[0].operationParams.files).toEqual([
        {name: 'input.csv', contents: 'col1,col2\n1,2'},
      ]);
      expect(extension.calls[0].operationParams.session_id).toBe('session-abc');
    });

    it('formats plot, csv, and generic output files with timestamp prefixes and MIME types', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 0, 2, 3, 4, 5));

      const extension = createFakeExtension({
        execution_result: 'done',
        output_files: [
          {name: 'notes.txt', contents: 'dHh0'},
          {name: 'chart.png', contents: 'cG5n'},
          {name: 'photo.jpeg', contents: 'anBlZw=='},
          {name: 'summary.csv', contents: 'Y3N2'},
        ],
      });
      const executor = new VertexAiCodeExecutor({
        codeInterpreterExtension: extension,
      });

      const result = await executor.executeCode(makeExecuteParams());

      expect(result.outputFiles).toEqual([
        {
          name: '20250102_030405_0.txt',
          content: 'dHh0',
          mimeType: 'text/plain',
        },
        {
          name: 'plot_20250102_030405_0.png',
          content: 'cG5n',
          mimeType: 'image/png',
        },
        {
          name: 'plot_20250102_030405_1.jpeg',
          content: 'anBlZw==',
          mimeType: 'image/jpeg',
        },
        {
          name: 'data_20250102_030405_2.csv',
          content: 'Y3N2',
          mimeType: 'text/csv',
        },
      ]);
    });
  });

  describe('default REST extension client', () => {
    const originalProject = process.env.GOOGLE_CLOUD_PROJECT;
    const originalGcloudProject = process.env.GCLOUD_PROJECT;

    beforeEach(() => {
      process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
      delete process.env.GCLOUD_PROJECT;
      vi.spyOn(GoogleAuth.prototype, 'getAccessToken').mockResolvedValue(
        'fake-token',
      );
    });

    afterEach(() => {
      if (originalProject === undefined) {
        delete process.env.GOOGLE_CLOUD_PROJECT;
      } else {
        process.env.GOOGLE_CLOUD_PROJECT = originalProject;
      }
      if (originalGcloudProject === undefined) {
        delete process.env.GCLOUD_PROJECT;
      } else {
        process.env.GCLOUD_PROJECT = originalGcloudProject;
      }
    });

    it('executes code via the Vertex AI Extensions REST endpoint when resourceName is set', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            output: {
              content: JSON.stringify({
                execution_result: 'rest-stdout\n',
                execution_error: '',
                output_files: [],
              }),
            },
          }),
          {status: 200, headers: {'content-type': 'application/json'}},
        ),
      );

      const executor = new VertexAiCodeExecutor({
        resourceName: VALID_RESOURCE_NAME,
      });

      const result = await executor.executeCode(
        makeExecuteParams({code: 'print("rest")'}),
      );

      expect(result.stdout).toBe('rest-stdout\n');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe(
        `https://us-central1-aiplatform.googleapis.com/v1beta1/${VALID_RESOURCE_NAME}:execute`,
      );
    });

    it('imports a Code Interpreter extension from hub when resourceName is omitted', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              name: 'projects/test-project/locations/us-central1/operations/op-1',
              response: {
                name: VALID_RESOURCE_NAME,
              },
            }),
            {status: 200, headers: {'content-type': 'application/json'}},
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              execution_result: 'hub-stdout\n',
            }),
            {status: 200, headers: {'content-type': 'application/json'}},
          ),
        );

      const executor = new VertexAiCodeExecutor();
      const result = await executor.executeCode(
        makeExecuteParams({code: 'print("hub")'}),
      );

      expect(executor.resourceName).toBe(VALID_RESOURCE_NAME);
      expect(result.stdout).toBe('hub-stdout\n');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0][0]).toBe(
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/extensions:import',
      );
    });

    it('throws when GOOGLE_CLOUD_PROJECT is unset and resourceName is omitted', async () => {
      delete process.env.GOOGLE_CLOUD_PROJECT;
      const executor = new VertexAiCodeExecutor();

      await expect(executor.executeCode(makeExecuteParams())).rejects.toThrow(
        'GOOGLE_CLOUD_PROJECT environment variable must be set when resourceName is not provided for VertexAiCodeExecutor.',
      );
    });

    it('throws when the extension :import HTTP request returns a non-OK status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('permission denied', {status: 403}),
      );
      const executor = new VertexAiCodeExecutor();

      await expect(executor.executeCode(makeExecuteParams())).rejects.toThrow(
        'Failed to import Vertex AI extension (403): permission denied',
      );
    });

    it('throws when the extension :execute HTTP request returns a non-OK status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('internal error', {status: 500}),
      );
      const executor = new VertexAiCodeExecutor({
        resourceName: VALID_RESOURCE_NAME,
      });

      await expect(executor.executeCode(makeExecuteParams())).rejects.toThrow(
        'Vertex AI Code Interpreter execution failed (500): internal error',
      );
    });
  });
});
