/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {CodeExecutionInput, InvocationContext} from '@google/adk';
import {CodeExecutionLanguage, VertexAiCodeExecutor} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('google-auth-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('google-auth-library')>();
  return {
    ...actual,
    GoogleAuth: vi.fn(() => ({
      getClient: vi.fn(async () => ({
        getRequestHeaders: vi.fn(
          async () => new Headers({Authorization: 'Bearer test-token'}),
        ),
      })),
    })),
  };
});

interface MockClient {
  importFromHub: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

const invocationContext = {} as unknown as InvocationContext;

function makeInput(
  overrides: Partial<CodeExecutionInput> = {},
): CodeExecutionInput {
  return {
    code: 'print("hi")',
    language: CodeExecutionLanguage.PYTHON,
    inputFiles: [],
    ...overrides,
  };
}

describe('VertexAiCodeExecutor', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    vi.stubEnv('CODE_INTERPRETER_EXTENSION_NAME', '');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');

    mockClient = {
      importFromHub: vi
        .fn()
        .mockResolvedValue('projects/p/locations/us-central1/extensions/999'),
      execute: vi.fn().mockResolvedValue({
        execution_result: 'hello',
        execution_error: '',
        output_files: [],
      }),
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function newExecutor(
    options: {
      resourceName?: string;
      projectId?: string;
      location?: string;
      withClient?: boolean;
    } = {},
  ): VertexAiCodeExecutor {
    return new VertexAiCodeExecutor({
      resourceName: options.resourceName,
      projectId: options.projectId,
      location: options.location,
      client: options.withClient === false ? undefined : (mockClient as never),
    });
  }

  describe('construction', () => {
    it('uses an explicit resourceName and does not import from the hub', async () => {
      const executor = newExecutor({
        resourceName: 'projects/p/locations/us-central1/extensions/1',
      });
      await executor.executeCode({
        invocationContext,
        codeExecutionInput: makeInput(),
      });
      expect(mockClient.importFromHub).not.toHaveBeenCalled();
      expect(mockClient.execute).toHaveBeenCalledWith(
        'projects/p/locations/us-central1/extensions/1',
        expect.anything(),
      );
    });

    it('reads resourceName from CODE_INTERPRETER_EXTENSION_NAME', async () => {
      vi.stubEnv(
        'CODE_INTERPRETER_EXTENSION_NAME',
        'projects/p/locations/us-central1/extensions/env',
      );
      const executor = newExecutor();
      await executor.executeCode({
        invocationContext,
        codeExecutionInput: makeInput(),
      });
      expect(mockClient.importFromHub).not.toHaveBeenCalled();
      expect(mockClient.execute).toHaveBeenCalledWith(
        'projects/p/locations/us-central1/extensions/env',
        expect.anything(),
      );
    });

    it('auto-creates from the hub and writes back the env var', async () => {
      const executor = newExecutor();
      await executor.executeCode({
        invocationContext,
        codeExecutionInput: makeInput(),
      });
      expect(mockClient.importFromHub).toHaveBeenCalledTimes(1);
      expect(process.env.CODE_INTERPRETER_EXTENSION_NAME).toBe(
        'projects/p/locations/us-central1/extensions/999',
      );
      expect(mockClient.execute).toHaveBeenCalledWith(
        'projects/p/locations/us-central1/extensions/999',
        expect.anything(),
      );
    });

    it('imports from the hub only once for concurrent executions', async () => {
      const executor = newExecutor();
      const [r1, r2] = await Promise.all([
        executor.executeCode({
          invocationContext,
          codeExecutionInput: makeInput(),
        }),
        executor.executeCode({
          invocationContext,
          codeExecutionInput: makeInput(),
        }),
      ]);
      expect(mockClient.importFromHub).toHaveBeenCalledTimes(1);
      expect(r1.stdout).toBe('hello');
      expect(r2.stdout).toBe('hello');
    });

    it('accepts an injected client', () => {
      const executor = newExecutor({
        resourceName: 'projects/p/locations/us-central1/extensions/1',
      });
      expect(executor).toBeInstanceOf(VertexAiCodeExecutor);
    });

    it('is stateful and optimizes data files', () => {
      const executor = newExecutor({
        resourceName: 'projects/p/locations/us-central1/extensions/1',
      });
      expect(executor.stateful).toBe(true);
      expect(executor.optimizeDataFile).toBe(true);
    });

    it('throws when auto-creation is needed but no project can be resolved', () => {
      expect(() => new VertexAiCodeExecutor()).toThrow(
        'Project ID is required.',
      );
    });

    it('does not throw when a project is available for the default client', () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
      expect(() => new VertexAiCodeExecutor()).not.toThrow();
    });

    it('does not require a project when a resourceName is provided', () => {
      const executor = new VertexAiCodeExecutor({
        resourceName: 'projects/p/locations/us-central1/extensions/1',
      });
      expect(executor.resourceName).toBe(
        'projects/p/locations/us-central1/extensions/1',
      );
    });

    it('defaults location to us-central1', () => {
      const executor = new VertexAiCodeExecutor({projectId: 'test-project'});
      expect(executor['location']).toBe('us-central1');
    });

    it('reads location from GOOGLE_CLOUD_LOCATION', () => {
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west1');
      const executor = new VertexAiCodeExecutor({projectId: 'test-project'});
      expect(executor['location']).toBe('europe-west1');
    });

    it('reads location from options', () => {
      const executor = new VertexAiCodeExecutor({
        projectId: 'test-project',
        location: 'asia-east1',
      });
      expect(executor['location']).toBe('asia-east1');
    });
  });

  describe('executeCode', () => {
    function run(input: Partial<CodeExecutionInput> = {}) {
      const executor = newExecutor({
        resourceName: 'projects/p/locations/us-central1/extensions/1',
      });
      return executor.executeCode({
        invocationContext,
        codeExecutionInput: makeInput(input),
      });
    }

    it('returns stdout from execution_result', async () => {
      mockClient.execute.mockResolvedValue({execution_result: 'the-stdout'});
      const result = await run();
      expect(result.stdout).toBe('the-stdout');
    });

    it('returns stderr from execution_error', async () => {
      mockClient.execute.mockResolvedValue({execution_error: 'the-stderr'});
      const result = await run();
      expect(result.stderr).toBe('the-stderr');
    });

    it('prefixes code with the imported-library preamble', async () => {
      await run({code: 'print("my code")'});
      const sentCode = mockClient.execute.mock.calls[0][1].code as string;
      expect(sentCode).toContain('import pandas as pd');
      expect(sentCode).toContain('print("my code")');
    });

    it('forwards input files as files:[{name, contents}]', async () => {
      await run({
        inputFiles: [{name: 'data.csv', content: 'YSxi', mimeType: 'text/csv'}],
      });
      expect(mockClient.execute.mock.calls[0][1].files).toEqual([
        {name: 'data.csv', contents: 'YSxi'},
      ]);
    });

    it('does not forward files when there are no input files', async () => {
      await run();
      expect(mockClient.execute.mock.calls[0][1].files).toBeUndefined();
    });

    it('passes and reuses the same session_id across calls', async () => {
      const executor = newExecutor({
        resourceName: 'projects/p/locations/us-central1/extensions/1',
      });
      await executor.executeCode({
        invocationContext,
        codeExecutionInput: makeInput({executionId: 'session-abc'}),
      });
      await executor.executeCode({
        invocationContext,
        codeExecutionInput: makeInput({executionId: 'session-abc'}),
      });
      expect(mockClient.execute.mock.calls[0][1].sessionId).toBe('session-abc');
      expect(mockClient.execute.mock.calls[1][1].sessionId).toBe('session-abc');
    });

    it('does not pass a session_id when there is no execution id', async () => {
      await run();
      expect(mockClient.execute.mock.calls[0][1].sessionId).toBeUndefined();
    });

    it('maps png output to image/png', async () => {
      mockClient.execute.mockResolvedValue({
        output_files: [{name: 'plot.png', contents: 'b64'}],
      });
      const result = await run();
      expect(result.outputFiles[0]).toEqual({
        name: 'plot.png',
        content: 'b64',
        mimeType: 'image/png',
      });
    });

    it('maps jpg output to image/jpg (non-normalized)', async () => {
      mockClient.execute.mockResolvedValue({
        output_files: [{name: 'pic.jpg', contents: 'b64'}],
      });
      const result = await run();
      expect(result.outputFiles[0].mimeType).toBe('image/jpg');
    });

    it('maps jpeg output to image/jpeg', async () => {
      mockClient.execute.mockResolvedValue({
        output_files: [{name: 'pic.jpeg', contents: 'b64'}],
      });
      const result = await run();
      expect(result.outputFiles[0].mimeType).toBe('image/jpeg');
    });

    it('maps csv output to text/csv', async () => {
      mockClient.execute.mockResolvedValue({
        output_files: [{name: 'out.csv', contents: 'b64'}],
      });
      const result = await run();
      expect(result.outputFiles[0].mimeType).toBe('text/csv');
    });

    it('falls back to a MIME guess for unsupported extensions', async () => {
      mockClient.execute.mockResolvedValue({
        output_files: [
          {name: 'report.pdf', contents: 'b64'},
          {name: 'notes.txt', contents: 'b64'},
          {name: 'README', contents: 'b64'},
        ],
      });
      const result = await run();
      expect(result.outputFiles[0].mimeType).toBe('application/pdf');
      expect(result.outputFiles[1].mimeType).toBe('application/octet-stream');
      expect(result.outputFiles[2].mimeType).toBe('application/octet-stream');
    });

    it('returns an empty output file list when none are produced', async () => {
      mockClient.execute.mockResolvedValue({execution_result: 'ok'});
      const result = await run();
      expect(result.outputFiles).toEqual([]);
    });

    it('defaults missing stdout/stderr to empty strings', async () => {
      mockClient.execute.mockResolvedValue({});
      const result = await run();
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
  });

  describe('default REST client', () => {
    function stubFetch(fetchMock: ReturnType<typeof vi.fn>) {
      vi.stubGlobal('fetch', fetchMock);
    }

    it('executes against the regional endpoint and parses the content envelope', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: JSON.stringify({
            execution_result: 'stdout-value',
            output_files: [{name: 'plot.png', contents: 'base64'}],
          }),
        }),
      });
      stubFetch(fetchMock);

      const executor = new VertexAiCodeExecutor({
        resourceName: 'projects/p/locations/us-central1/extensions/456',
      });
      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: makeInput({
          inputFiles: [{name: 'in.csv', content: 'aW4=', mimeType: 'text/csv'}],
          executionId: 'sess-1',
        }),
      });

      expect(result.stdout).toBe('stdout-value');
      expect(result.outputFiles[0]).toEqual({
        name: 'plot.png',
        content: 'base64',
        mimeType: 'image/png',
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/p/locations/us-central1/extensions/456:execute',
      );
      expect(init.method).toBe('POST');
      expect((init.headers as Headers).get('Authorization')).toBe(
        'Bearer test-token',
      );
      expect((init.headers as Headers).get('Content-Type')).toBe(
        'application/json',
      );
      const body = JSON.parse(init.body as string);
      expect(body.operationId).toBe('execute');
      expect(body.operationParams.code).toContain('import pandas as pd');
      expect(body.operationParams.files).toEqual([
        {name: 'in.csv', contents: 'aW4='},
      ]);
      expect(body.operationParams.session_id).toBe('sess-1');
    });

    it('omits files and session_id when not provided', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({content: JSON.stringify({execution_result: 'ok'})}),
      });
      stubFetch(fetchMock);

      const executor = new VertexAiCodeExecutor({
        resourceName: 'projects/p/locations/us-central1/extensions/456',
      });
      await executor.executeCode({
        invocationContext,
        codeExecutionInput: makeInput(),
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.operationParams.files).toBeUndefined();
      expect(body.operationParams.session_id).toBeUndefined();
    });

    it('throws with the status and body on a non-2xx response', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'permission denied',
      });
      stubFetch(fetchMock);

      const executor = new VertexAiCodeExecutor({
        resourceName: 'projects/p/locations/us-central1/extensions/456',
      });
      await expect(
        executor.executeCode({
          invocationContext,
          codeExecutionInput: makeInput(),
        }),
      ).rejects.toThrow(
        'API request failed with status 403: permission denied',
      );
    });

    it('throws on an invalid extension resource name', async () => {
      stubFetch(vi.fn());
      const executor = new VertexAiCodeExecutor({
        resourceName: 'not-a-resource',
      });
      await expect(
        executor.executeCode({
          invocationContext,
          codeExecutionInput: makeInput(),
        }),
      ).rejects.toThrow(
        'Invalid code interpreter extension resource name: not-a-resource',
      );
    });

    it('imports from the hub and returns the created resource name', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: 'projects/p/locations/us-central1/operations/1',
            done: true,
            response: {
              name: 'projects/p/locations/us-central1/extensions/789',
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            content: JSON.stringify({execution_result: 'created'}),
          }),
        });
      stubFetch(fetchMock);

      const executor = new VertexAiCodeExecutor({
        projectId: 'test-project',
        location: 'us-central1',
      });
      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: makeInput(),
      });

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/extensions:import',
      );
      expect(process.env.CODE_INTERPRETER_EXTENSION_NAME).toBe(
        'projects/p/locations/us-central1/extensions/789',
      );
      expect(result.stdout).toBe('created');
    });

    it('polls the import operation until it completes', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({name: 'operations/1', done: false}),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: 'operations/1',
            done: true,
            response: {
              name: 'projects/p/locations/us-central1/extensions/789',
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            content: JSON.stringify({execution_result: 'ok'}),
          }),
        });
      stubFetch(fetchMock);
      vi.useFakeTimers();

      const executor = new VertexAiCodeExecutor({
        projectId: 'test-project',
        location: 'us-central1',
      });
      const executePromise = executor.executeCode({
        invocationContext,
        codeExecutionInput: makeInput(),
      });
      await vi.runAllTimersAsync();
      const result = await executePromise;
      vi.useRealTimers();

      // Second call is the polling GET (no request body).
      expect(fetchMock.mock.calls[1][1].method).toBe('GET');
      expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
      expect(result.stdout).toBe('ok');
    });

    it('throws if the import operation never completes', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({name: 'operations/stuck', done: false}),
      });
      stubFetch(fetchMock);
      vi.useFakeTimers();

      const executor = new VertexAiCodeExecutor({
        projectId: 'test-project',
        location: 'us-central1',
      });
      const executePromise = executor.executeCode({
        invocationContext,
        codeExecutionInput: makeInput(),
      });

      await Promise.all([
        expect(executePromise).rejects.toThrow(
          'Code Interpreter extension creation operation operations/stuck did not complete in time.',
        ),
        vi.runAllTimersAsync(),
      ]);
      vi.useRealTimers();
    });
  });
});
