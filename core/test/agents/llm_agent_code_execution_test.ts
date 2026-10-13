/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseCodeExecutor,
  BaseLlm,
  BaseLlmConnection,
  BaseLlmResponseProcessor,
  CodeExecutionLanguage,
  CodeExecutionResponseProcessor,
  CodeExecutionResult,
  Event,
  ExecuteCodeParams,
  InMemoryArtifactService,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Runner,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

/**
 * Returns `turns[n]` on the n-th call and keeps a copy of every request.
 */
class ScriptedLlm extends BaseLlm {
  readonly requests: Content[][] = [];

  constructor(private readonly turns: LlmResponse[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(structuredClone(request.contents));
    const turn = this.turns[this.requests.length - 1];
    if (turn) {
      yield structuredClone(turn);
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not supported by ScriptedLlm.');
  }
}

class StubCodeExecutor extends BaseCodeExecutor {
  readonly codes: string[] = [];
  readonly languages: CodeExecutionLanguage[] = [];

  constructor(private readonly result: CodeExecutionResult) {
    super();
  }

  async executeCode({
    codeExecutionInput,
  }: ExecuteCodeParams): Promise<CodeExecutionResult> {
    this.codes.push(codeExecutionInput.code);
    this.languages.push(codeExecutionInput.language);
    return this.result;
  }
}

const CODE_TURN: LlmResponse = {
  content: {
    role: 'model',
    parts: [{text: 'Let me compute it.\n```tool_code\nprint(1 + 1)\n```'}],
  },
};

const ANSWER_TURN: LlmResponse = {
  content: {role: 'model', parts: [{text: 'The answer is 2.'}]},
};

async function runAgent(
  model: ScriptedLlm,
  executor: BaseCodeExecutor,
  responseProcessors?: BaseLlmResponseProcessor[],
): Promise<Event[]> {
  const agent = new LlmAgent({
    name: 'calculator',
    model,
    codeExecutor: executor,
    responseProcessors,
  });
  const sessionService = new InMemorySessionService();
  const runner = new Runner({
    appName: 'test_app',
    agent,
    sessionService,
    artifactService: new InMemoryArtifactService(),
  });
  const session = await sessionService.createSession({
    appName: 'test_app',
    userId: 'test_user',
  });

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'What is 1 + 1?'}]},
  })) {
    events.push(event);
  }
  return events;
}

describe('LlmAgent with a client-side code executor', () => {
  it('runs the model code, sends the output to the model, and returns its answer', async () => {
    const model = new ScriptedLlm([CODE_TURN, ANSWER_TURN]);
    const executor = new StubCodeExecutor({
      stdout: '2',
      stderr: '',
      outputFiles: [],
    });

    const events = await runAgent(model, executor);

    expect(executor.codes).toEqual(['print(1 + 1)']);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1].slice(-2)).toEqual([
      {
        role: 'model',
        parts: [
          {text: 'Let me compute it.\n'},
          {text: '```tool_code\nprint(1 + 1)\n```'},
        ],
      },
      {
        role: 'user',
        parts: [{text: '```tool_output\nCode execution result:\n2\n\n```'}],
      },
    ]);
    expect(events[events.length - 1].content?.parts?.[0].text).toBe(
      'The answer is 2.',
    );
  });

  it('sends stderr to the model when the code fails', async () => {
    const model = new ScriptedLlm([CODE_TURN, ANSWER_TURN]);
    const executor = new StubCodeExecutor({
      stdout: '',
      stderr: 'NameError: name "x" is not defined',
      outputFiles: [],
    });

    await runAgent(model, executor);

    expect(model.requests[1][model.requests[1].length - 1]).toEqual({
      role: 'user',
      parts: [
        {text: '```tool_output\nNameError: name "x" is not defined\n```'},
      ],
    });
  });

  it('calls the model again when a usage-only event follows the code result', async () => {
    const model = new ScriptedLlm([
      {
        ...CODE_TURN,
        usageMetadata: {promptTokenCount: 10, totalTokenCount: 10},
      },
      ANSWER_TURN,
    ]);
    const executor = new StubCodeExecutor({
      stdout: '2',
      stderr: '',
      outputFiles: [],
    });

    const events = await runAgent(model, executor);

    expect(model.requests).toHaveLength(2);
    expect(events[events.length - 1].content?.parts?.[0].text).toBe(
      'The answer is 2.',
    );
  });

  it('runs a tool_code block as Python', async () => {
    const model = new ScriptedLlm([CODE_TURN, ANSWER_TURN]);
    const executor = new StubCodeExecutor({
      stdout: '2',
      stderr: '',
      outputFiles: [],
    });

    await runAgent(model, executor);

    expect(executor.languages).toEqual([CodeExecutionLanguage.PYTHON]);
  });

  it('runs a bash block as a shell script', async () => {
    const model = new ScriptedLlm([
      {
        content: {
          role: 'model',
          parts: [{text: 'Run this:\n```bash\nls -la\n```\nThen check.'}],
        },
      },
      ANSWER_TURN,
    ]);
    const executor = new StubCodeExecutor({
      stdout: 'total 0',
      stderr: '',
      outputFiles: [],
    });

    const events = await runAgent(model, executor);

    expect(executor.codes).toEqual(['ls -la']);
    expect(executor.languages).toEqual([CodeExecutionLanguage.SHELL]);
    expect(model.requests).toHaveLength(2);
    expect(events[events.length - 1].content?.parts?.[0].text).toBe(
      'The answer is 2.',
    );
  });

  it('runs the model code with an exported processor in a custom response processor list', async () => {
    const model = new ScriptedLlm([CODE_TURN, ANSWER_TURN]);
    const executor = new StubCodeExecutor({
      stdout: '2',
      stderr: '',
      outputFiles: [],
    });

    const events = await runAgent(model, executor, [
      new CodeExecutionResponseProcessor(),
    ]);

    expect(executor.codes).toEqual(['print(1 + 1)']);
    expect(model.requests).toHaveLength(2);
    expect(events[events.length - 1].content?.parts?.[0].text).toBe(
      'The answer is 2.',
    );
  });
});
