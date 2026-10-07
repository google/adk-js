/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  FileContentEncoding,
  InMemoryArtifactService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  ScopedArtifactService,
  createSession,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {
  CODE_EXECUTION_REQUEST_PROCESSOR,
  CodeExecutionResponseProcessor,
} from '../../../src/agents/processors/code_execution_request_processor.js';
import {
  BaseCodeExecutor,
  ExecuteCodeParams,
} from '../../../src/code_executors/base_code_executor.js';
import {
  CodeExecutionInput,
  CodeExecutionResult,
} from '../../../src/code_executors/code_execution_utils.js';
import {base64Encode} from '../../../src/utils/env_aware_utils.js';

class MockBaseAgent extends BaseAgent {
  constructor(name: string) {
    super({name});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

class TestCodeExecutor extends BaseCodeExecutor {
  async executeCode(_params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    return {stdout: '', stderr: '', outputFiles: []};
  }
}

class RecordingCodeExecutor extends BaseCodeExecutor {
  readonly inputs: CodeExecutionInput[] = [];

  constructor(private readonly result: CodeExecutionResult) {
    super();
    this.optimizeDataFile = true;
  }

  async executeCode(params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    this.inputs.push(params.codeExecutionInput);
    return this.result;
  }
}

function createMockInvocationContext(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function createContextWithArtifacts(agent: BaseAgent): {
  ctx: InvocationContext;
  artifactService: ScopedArtifactService;
} {
  const artifactService = new ScopedArtifactService(
    new InMemoryArtifactService(),
    'test-app',
    'test-user',
    'test-session',
  );
  const ctx = new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
    artifactService,
  });
  return {ctx, artifactService};
}

function createLlmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
    ...overrides,
  };
}

async function collectEvents<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const event of gen) {
    results.push(event);
  }
  return results;
}

const CSV_TEXT = 'a,b\n1,2\n';

describe('CodeExecutionRequestProcessor', () => {
  describe('early-exit paths', () => {
    it('yields no events and leaves request unchanged for a non-LlmAgent', async () => {
      const agent = new MockBaseAgent('non-llm-agent');
      const ctx = createMockInvocationContext(agent);
      const llmRequest = createLlmRequest({
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
      });

      const events = await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      expect(events).toHaveLength(0);
      expect(llmRequest.contents).toHaveLength(1);
    });

    it('yields no events when LlmAgent has no codeExecutor', async () => {
      const agent = new LlmAgent({
        name: 'agent-no-executor',
        model: 'gemini-2.5-flash',
      });
      const ctx = createMockInvocationContext(agent);
      const llmRequest = createLlmRequest({
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
      });

      const events = await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      expect(events).toHaveLength(0);
    });

    it('calls runPreProcessor and proceeds to convertCodeExecutionParts when codeExecutor is BaseCodeExecutor', async () => {
      const executor = new TestCodeExecutor();
      const agent = new LlmAgent({
        name: 'agent-with-executor',
        model: 'gemini-2.5-flash',
        codeExecutor: executor,
      });
      const ctx = createMockInvocationContext(agent);
      const llmRequest = createLlmRequest({
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
      });

      // Should not throw — runPreProcessor exits early because
      // isBuiltInCodeExecutor is false and optimizeDataFile is false
      const events = await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      expect(events).toHaveLength(0);
      // Content should still be present after processing
      expect(llmRequest.contents).toHaveLength(1);
    });
  });

  describe('data files', () => {
    function createCsvRequest(): LlmRequest {
      return createLlmRequest({
        contents: [
          {
            role: 'user',
            parts: [
              {text: 'Summarize this file.'},
              {
                inlineData: {
                  mimeType: 'text/csv',
                  data: base64Encode(CSV_TEXT),
                },
              },
            ],
          },
        ],
      });
    }

    function createAgent(executor: BaseCodeExecutor): LlmAgent {
      return new LlmAgent({
        name: 'data_agent',
        model: 'gemini-flash-latest',
        codeExecutor: executor,
      });
    }

    it('replaces the inline CSV part with a text placeholder and passes the file to the executor', async () => {
      const executor = new RecordingCodeExecutor({
        stdout: 'explored',
        stderr: '',
        outputFiles: [],
      });
      const {ctx} = createContextWithArtifacts(createAgent(executor));
      const llmRequest = createCsvRequest();

      await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      expect(llmRequest.contents[0].parts![1]).toEqual({
        text: '\nAvailable file: `data_1_2.csv`\n',
      });
      expect(executor.inputs).toHaveLength(1);
      expect(executor.inputs[0].inputFiles).toEqual([
        {name: 'data_1_2.csv', content: CSV_TEXT, mimeType: 'text/csv'},
      ]);
    });

    it('adds the executor stdout to the request as user text', async () => {
      const executor = new RecordingCodeExecutor({
        stdout: 'Total rows: 1',
        stderr: '',
        outputFiles: [],
      });
      const {ctx} = createContextWithArtifacts(createAgent(executor));
      const llmRequest = createCsvRequest();

      await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      const last = llmRequest.contents[llmRequest.contents.length - 1];
      expect(last.role).toBe('user');
      expect(last.parts).toEqual([
        {
          text: '```tool_output\nCode execution result:\nTotal rows: 1\n\n```',
        },
      ]);
    });

    it('saves a UTF-8 output file as base64 inline data', async () => {
      const executor = new RecordingCodeExecutor({
        stdout: '',
        stderr: '',
        outputFiles: [
          {
            name: 'summary.txt',
            content: 'hello',
            contentEncoding: FileContentEncoding.UTF8,
            mimeType: 'text/plain',
          },
        ],
      });
      const {ctx, artifactService} = createContextWithArtifacts(
        createAgent(executor),
      );
      const saveSpy = vi.spyOn(artifactService, 'saveArtifact');

      await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, createCsvRequest()),
      );

      expect(saveSpy).toHaveBeenCalledWith({
        filename: 'summary.txt',
        artifact: {
          inlineData: {data: base64Encode('hello'), mimeType: 'text/plain'},
        },
      });
    });

    it('saves a base64 output file unchanged', async () => {
      const encoded = base64Encode('\x89PNG');
      const executor = new RecordingCodeExecutor({
        stdout: '',
        stderr: '',
        outputFiles: [
          {
            name: 'chart.png',
            content: encoded,
            contentEncoding: FileContentEncoding.BASE64,
            mimeType: 'image/png',
          },
        ],
      });
      const {ctx, artifactService} = createContextWithArtifacts(
        createAgent(executor),
      );
      const saveSpy = vi.spyOn(artifactService, 'saveArtifact');

      await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, createCsvRequest()),
      );

      expect(saveSpy).toHaveBeenCalledWith({
        filename: 'chart.png',
        artifact: {inlineData: {data: encoded, mimeType: 'image/png'}},
      });
    });
  });
});

describe('CodeExecutionResponseProcessor', () => {
  const responseProcessor = new CodeExecutionResponseProcessor();

  describe('early-exit paths', () => {
    it('yields no events for a partial response', async () => {
      const agent = new LlmAgent({
        name: 'agent',
        model: 'gemini-2.5-flash',
        codeExecutor: new TestCodeExecutor(),
      });
      const ctx = createMockInvocationContext(agent);
      const partialResponse = {
        partial: true,
        content: {role: 'model', parts: [{text: 'thinking...'}]},
      };

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, partialResponse),
      );

      expect(events).toHaveLength(0);
    });

    it('yields no events for a non-LlmAgent', async () => {
      const agent = new MockBaseAgent('non-llm');
      const ctx = createMockInvocationContext(agent);
      const llmResponse = {
        partial: false,
        content: {role: 'model', parts: [{text: 'done'}]},
      };

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, llmResponse),
      );

      expect(events).toHaveLength(0);
    });

    it('yields no events when LlmAgent has no codeExecutor', async () => {
      const agent = new LlmAgent({
        name: 'agent-no-executor',
        model: 'gemini-2.5-flash',
      });
      const ctx = createMockInvocationContext(agent);
      const llmResponse = {
        partial: false,
        content: {role: 'model', parts: [{text: 'done'}]},
      };

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, llmResponse),
      );

      expect(events).toHaveLength(0);
    });

    it('yields no events when response has no content', async () => {
      const agent = new LlmAgent({
        name: 'agent-with-executor',
        model: 'gemini-2.5-flash',
        codeExecutor: new TestCodeExecutor(),
      });
      const ctx = createMockInvocationContext(agent);
      const llmResponse = {partial: false};

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, llmResponse),
      );

      expect(events).toHaveLength(0);
    });

    it('yields no events when response content has no code block', async () => {
      const agent = new LlmAgent({
        name: 'agent-with-executor',
        model: 'gemini-2.5-flash',
        codeExecutor: new TestCodeExecutor(),
      });
      const ctx = createMockInvocationContext(agent);
      const llmResponse = {
        partial: false,
        content: {role: 'model', parts: [{text: 'plain text response'}]},
      };

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, llmResponse),
      );

      expect(events).toHaveLength(0);
    });
  });

  describe('code execution', () => {
    it('runs the code block, reports the output and saves a UTF-8 file as base64', async () => {
      const executor = new RecordingCodeExecutor({
        stdout: '2',
        stderr: '',
        outputFiles: [
          {
            name: 'result.txt',
            content: '2',
            contentEncoding: FileContentEncoding.UTF8,
            mimeType: 'text/plain',
          },
        ],
      });
      const agent = new LlmAgent({
        name: 'agent-with-executor',
        model: 'gemini-flash-latest',
        codeExecutor: executor,
      });
      const {ctx, artifactService} = createContextWithArtifacts(agent);
      const saveSpy = vi.spyOn(artifactService, 'saveArtifact');
      const llmResponse = {
        partial: false,
        content: {
          role: 'model',
          parts: [{text: '```python\nprint(1 + 1)\n```'}],
        },
      };

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, llmResponse),
      );

      expect(executor.inputs.map((input) => input.code)).toEqual([
        'print(1 + 1)',
      ]);
      expect(events).toHaveLength(2);
      expect(events[1].content?.parts?.[0].codeExecutionResult?.output).toBe(
        'Code execution result:\n2\n\n\nSaved artifacts:\n`result.txt`',
      );
      expect(saveSpy).toHaveBeenCalledWith({
        filename: 'result.txt',
        artifact: {
          inlineData: {data: base64Encode('2'), mimeType: 'text/plain'},
        },
      });
      expect(llmResponse.content).toBeUndefined();
    });
  });
});
