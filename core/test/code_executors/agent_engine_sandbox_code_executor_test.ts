/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '@google/adk/agents/invocation_context.js';
import {CodeExecutionLanguage} from '@google/adk/code_executors/code_execution_utils.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {AgentEngineSandboxCodeExecutor} from '../../src/code_executors/agent_engine_sandbox_code_executor.js';

describe('AgentEngineSandboxCodeExecutor', () => {
  let executor: AgentEngineSandboxCodeExecutor;
  interface MockClient {
    agentEnginesInternal: {
      createInternal: ReturnType<typeof vi.fn>;
      getAgentOperationInternal: ReturnType<typeof vi.fn>;
      sandboxes: {
        getInternal: ReturnType<typeof vi.fn>;
        createInternal: ReturnType<typeof vi.fn>;
        getSandboxOperationInternal: ReturnType<typeof vi.fn>;
        executeCodeInternal: ReturnType<typeof vi.fn>;
      };
    };
  }
  let mockClient: MockClient;

  beforeEach(() => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');

    mockClient = {
      agentEnginesInternal: {
        createInternal: vi.fn().mockResolvedValue({
          name: 'operations/create-engine-op',
          done: true,
          response: {
            name: 'projects/test-project/locations/us-central1/reasoningEngines/123',
          },
        }),
        getAgentOperationInternal: vi.fn().mockResolvedValue({
          done: true,
          response: {
            name: 'projects/test-project/locations/us-central1/reasoningEngines/123',
          },
        }),
        sandboxes: {
          getInternal: vi.fn().mockResolvedValue({
            name: 'projects/test-project/locations/us-central1/reasoningEngines/123/sandboxEnvironments/456',
            state: 'STATE_RUNNING',
          }),
          createInternal: vi.fn().mockResolvedValue({
            name: 'operations/create-sandbox-op',
            done: true,
            response: {
              name: 'projects/test-project/locations/us-central1/reasoningEngines/123/sandboxEnvironments/456',
            },
          }),
          getSandboxOperationInternal: vi.fn().mockResolvedValue({
            done: true,
            response: {
              name: 'projects/test-project/locations/us-central1/reasoningEngines/123/sandboxEnvironments/456',
            },
          }),
          executeCodeInternal: vi.fn().mockResolvedValue({
            outputs: [
              {
                mimeType: 'application/json',
                data: Buffer.from(
                  JSON.stringify({msg_out: 'hello world', msg_err: ''}),
                ).toString('base64'),
              },
            ],
          }),
        },
      },
    };
  });

  it('can be initialized with project and location from env', () => {
    executor = new AgentEngineSandboxCodeExecutor({client: mockClient});
    expect(executor).toBeDefined();
  });

  it('throws error if project ID is missing', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    expect(() => new AgentEngineSandboxCodeExecutor({})).toThrow(
      'Project ID is required.',
    );
  });

  it('parses project and location from sandboxResourceName', () => {
    executor = new AgentEngineSandboxCodeExecutor({
      sandboxResourceName:
        'projects/custom-p/locations/custom-l/reasoningEngines/123/sandboxEnvironments/456',
      client: mockClient,
    });
    expect(executor).toBeDefined();
  });

  it('parses project and location from agentEngineResourceName', () => {
    executor = new AgentEngineSandboxCodeExecutor({
      agentEngineResourceName:
        'projects/custom-p/locations/custom-l/reasoningEngines/123',
      client: mockClient,
    });
    expect(executor).toBeDefined();
  });

  it('throws error for invalid sandboxResourceName', () => {
    expect(
      () =>
        new AgentEngineSandboxCodeExecutor({sandboxResourceName: 'invalid'}),
    ).toThrow('Invalid sandbox resource name');
  });

  it('throws error for invalid agentEngineResourceName', () => {
    expect(
      () =>
        new AgentEngineSandboxCodeExecutor({
          agentEngineResourceName: 'invalid',
        }),
    ).toThrow('Invalid agent engine resource name');
  });

  describe('executeCode', () => {
    let invocationContext: InvocationContext;

    beforeEach(() => {
      invocationContext = {
        session: {
          id: 'session-1',
          appName: '123',
          userId: 'user-1',
          events: [],
          lastUpdateTime: Date.now(),
          state: {},
        },
      } as unknown as InvocationContext;
      executor = new AgentEngineSandboxCodeExecutor({client: mockClient});
    });

    it('creates agent engine and sandbox if not provided', async () => {
      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(mockClient.agentEnginesInternal.createInternal).toHaveBeenCalled();
      expect(
        mockClient.agentEnginesInternal.sandboxes.createInternal,
      ).toHaveBeenCalled();
      expect(result.stdout).toBe('hello world');
    });

    it('reuses existing sandbox from session state', async () => {
      invocationContext.session!.state!['sandbox_name'] =
        'projects/test-project/locations/us-central1/reasoningEngines/123/sandboxEnvironments/456';

      await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(mockClient.agentEnginesInternal.createInternal).toHaveBeenCalled();
      expect(
        mockClient.agentEnginesInternal.sandboxes.createInternal,
      ).not.toHaveBeenCalled();
    });

    it('creates new sandbox if existing one is not running', async () => {
      invocationContext.session!.state!['sandbox_name'] =
        'projects/test-project/locations/us-central1/reasoningEngines/123/sandboxEnvironments/456';
      mockClient.agentEnginesInternal.sandboxes.getInternal.mockResolvedValue({
        state: 'STATE_EXPIRED',
      });

      await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(
        mockClient.agentEnginesInternal.sandboxes.createInternal,
      ).toHaveBeenCalled();
    });

    it('passes input files to sandbox', async () => {
      await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [
            {
              name: 'data.csv',
              content: Buffer.from('a,b,c').toString('base64'),
              mimeType: 'text/csv',
            },
          ],
        },
      });

      expect(
        mockClient.agentEnginesInternal.sandboxes.executeCodeInternal,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: expect.arrayContaining([
            expect.objectContaining({
              mimeType: 'application/json',
            }),
            expect.objectContaining({
              metadata: {
                attributes: {
                  file_name: Buffer.from('data.csv').toString('base64'),
                },
              },
            }),
          ]),
        }),
      );
    });

    it('parses file outputs from sandbox', async () => {
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal.mockResolvedValue(
        {
          outputs: [
            {
              mimeType: 'image/png',
              data: 'base64data',
              metadata: {
                attributes: {
                  file_name: Buffer.from('plot.png').toString('base64'),
                },
              },
            },
          ],
        },
      );

      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(result.outputFiles).toHaveLength(1);
      expect(result.outputFiles[0].name).toBe('plot.png');
      expect(result.outputFiles[0].mimeType).toBe('image/png');
    });

    it('guesses mime type if missing in output', async () => {
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal.mockResolvedValue(
        {
          outputs: [
            {
              data: 'base64data',
              metadata: {
                attributes: {
                  file_name: Buffer.from('data.csv').toString('base64'),
                },
              },
            },
          ],
        },
      );

      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("hello")',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(result.outputFiles[0].mimeType).toBe('text/csv');
    });
  });
});
