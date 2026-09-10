/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  Event,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LongRunningFunctionTool,
  ParallelAgent,
  Runner,
  SequentialAgent,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

class MockLlmConnection implements BaseLlmConnection {
  sendHistory(_history: Content[]): Promise<void> {
    return Promise.resolve();
  }
  sendContent(_content: Content): Promise<void> {
    return Promise.resolve();
  }
  sendRealtime(_blob: {data: string; mimeType: string}): Promise<void> {
    return Promise.resolve();
  }
  async *receive(): AsyncGenerator<LlmResponse, void, void> {}
  async close(): Promise<void> {
    return Promise.resolve();
  }
}

class MockLlm extends BaseLlm {
  responses: (LlmResponse | null)[];
  requests: LlmRequest[] = [];

  constructor(responses: (LlmResponse | null)[]) {
    super({model: 'mock-llm'});
    this.responses = responses;
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(request);
    const resp = this.responses.shift();
    if (resp) {
      yield resp;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new MockLlmConnection();
  }
}

const USER_ID = 'test_user';
const SESSION_ID = 'test_session';

async function setupRunner(agent: BaseAgent): Promise<Runner> {
  const sessionService = new InMemorySessionService();
  await sessionService.createSession({
    appName: 'test',
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  return new Runner({
    appName: 'test',
    agent,
    sessionService,
  });
}

async function runTurn(
  runner: Runner,
  userMessageText: string,
): Promise<Event[]> {
  const events: Event[] = [];
  const generator = runner.runAsync({
    userId: USER_ID,
    sessionId: SESSION_ID,
    newMessage: {role: 'user', parts: [{text: userMessageText}]},
  });
  for await (const e of generator) {
    events.push(e);
  }
  return events;
}

async function resumeTurn(
  runner: Runner,
  prevEvents: Event[],
  toolName: string,
  toolResponseValue: unknown = 'done',
): Promise<Event[]> {
  const fcIds: string[] = [];
  for (const e of prevEvents) {
    if (e.content?.parts) {
      for (const p of e.content.parts) {
        if (p.functionCall?.name === toolName && p.functionCall.id) {
          fcIds.push(p.functionCall.id);
        }
      }
    }
  }

  if (fcIds.length === 0) {
    for (const e of prevEvents) {
      if (e.longRunningToolIds && e.longRunningToolIds.length > 0) {
        fcIds.push(...e.longRunningToolIds);
        break;
      }
    }
  }

  const frParts = fcIds.map((id) => ({
    functionResponse: {
      name: toolName,
      id,
      response:
        typeof toolResponseValue === 'object' && toolResponseValue !== null
          ? (toolResponseValue as Record<string, unknown>)
          : {result: toolResponseValue},
    },
  }));

  const events: Event[] = [];
  const generator = runner.runAsync({
    userId: USER_ID,
    sessionId: SESSION_ID,
    newMessage: {role: 'user', parts: frParts},
  });
  for await (const e of generator) {
    events.push(e);
  }
  return events;
}

function getTextParts(events: Event[]): string[] {
  const texts: string[] = [];
  for (const e of events) {
    if (e.content?.parts) {
      for (const p of e.content.parts) {
        if (p.text) {
          texts.push(p.text);
        }
      }
    }
  }
  return texts;
}

describe('LlmAgent Interruptions', () => {
  it('test_single_agent_yields_on_long_running_tool', async () => {
    const lroTool = new LongRunningFunctionTool({
      name: 'long_running_op',
      description: 'LRO tool',
      execute: async () => null,
    });

    const mockModel = new MockLlm([
      {
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'long_running_op', args: {}}}],
        },
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'Final answer'}],
        },
      },
    ]);

    const agent = new LlmAgent({
      name: 'test_agent',
      model: mockModel,
      tools: [lroTool],
    });

    const runner = await setupRunner(agent);
    const events = await runTurn(runner, 'Go');

    expect(
      events.some((e) =>
        e.content?.parts?.some(
          (p) => p.functionCall && p.functionCall.name === 'long_running_op',
        ),
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) => e.longRunningToolIds && e.longRunningToolIds.length > 0,
      ),
    ).toBe(true);
    expect(mockModel.requests.length).toBe(1);

    const resumeEvents = await resumeTurn(runner, events, 'long_running_op');
    expect(
      getTextParts(resumeEvents).some((t) => t.includes('Final answer')),
    ).toBe(true);
    expect(mockModel.requests.length).toBe(2);
  });

  it('test_single_agent_request_input_tool_interrupt_and_resume', async () => {
    const requestInputTool = new LongRunningFunctionTool({
      name: 'adk_request_input',
      description: 'Request input from user',
      execute: async () => null,
    });

    const mockModel = new MockLlm([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'adk_request_input',
                args: {message: 'Which file?'},
              },
            },
          ],
        },
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'Continuing with file: file_a.txt'}],
        },
      },
    ]);

    const agent = new LlmAgent({
      name: 'test_agent',
      model: mockModel,
      tools: [requestInputTool],
    });

    const runner = await setupRunner(agent);
    const events = await runTurn(runner, 'Start');

    expect(
      events.some(
        (e) => e.longRunningToolIds && e.longRunningToolIds.length > 0,
      ),
    ).toBe(true);
    expect(
      events.some((e) =>
        e.content?.parts?.some(
          (p) => p.functionCall && p.functionCall.name === 'adk_request_input',
        ),
      ),
    ).toBe(true);
    expect(mockModel.requests.length).toBe(1);

    const resumeEvents = await resumeTurn(
      runner,
      events,
      'adk_request_input',
      'file_a.txt',
    );
    expect(
      getTextParts(resumeEvents).some((t) =>
        t.includes('Continuing with file: file_a.txt'),
      ),
    ).toBe(true);
    expect(mockModel.requests.length).toBe(2);
  });

  it('test_child_agent_interrupt_and_resume', async () => {
    const transferTool = new FunctionTool({
      name: 'transfer_to_child',
      description: 'Transfer to child agent',
      execute: (_args, toolContext) => {
        if (!toolContext) {
          throw new Error('toolContext is required.');
        }
        toolContext.actions.transferToAgent = 'child_agent';
        return 'transferring';
      },
    });

    const lroTool = new LongRunningFunctionTool({
      name: 'child_lro',
      description: 'Child LRO tool',
      execute: async () => null,
    });

    const childMockModel = new MockLlm([
      {
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'child_lro', args: {}}}],
        },
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'Child final answer'}],
        },
      },
    ]);

    const childAgent = new LlmAgent({
      name: 'child_agent',
      model: childMockModel,
      tools: [lroTool],
    });

    const parentMockModel = new MockLlm([
      {
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'transfer_to_child', args: {}}}],
        },
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'Parent final answer'}],
        },
      },
    ]);

    const parentAgent = new LlmAgent({
      name: 'parent_agent',
      model: parentMockModel,
      tools: [transferTool],
      subAgents: [childAgent],
    });

    const runner = await setupRunner(parentAgent);
    const events = await runTurn(runner, 'Go');

    expect(
      events.some(
        (e) => e.longRunningToolIds && e.longRunningToolIds.length > 0,
      ),
    ).toBe(true);
    expect(parentMockModel.requests.length).toBe(1);
    expect(childMockModel.requests.length).toBe(1);

    const resumeEvents = await resumeTurn(runner, events, 'child_lro');
    expect(
      getTextParts(resumeEvents).some((t) => t.includes('Child final answer')),
    ).toBe(true);
    expect(childMockModel.requests.length).toBe(2);
  });

  it('test_sequential_agent_interrupt_and_resume', async () => {
    const child1Lro = new LongRunningFunctionTool({
      name: 'child1_lro',
      description: 'Child 1 LRO tool',
      execute: async () => null,
    });

    const child1Mock = new MockLlm([
      {
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'child1_lro', args: {}}}],
        },
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'Child 1 answer'}],
        },
      },
    ]);

    const child1 = new LlmAgent({
      name: 'child1',
      model: child1Mock,
      tools: [child1Lro],
    });

    const child2Mock = new MockLlm([
      {
        content: {
          role: 'model',
          parts: [{text: 'Child 2 answer'}],
        },
      },
    ]);

    const child2 = new LlmAgent({
      name: 'child2',
      model: child2Mock,
    });

    const sequentialAgent = new SequentialAgent({
      name: 'seq_agent',
      subAgents: [child1, child2],
    });

    const runner = await setupRunner(sequentialAgent);
    const events = await runTurn(runner, 'Start');

    expect(child1Mock.requests.length).toBe(1);
    expect(child2Mock.requests.length).toBe(0);
    expect(
      events.some(
        (e) => e.longRunningToolIds && e.longRunningToolIds.length > 0,
      ),
    ).toBe(true);

    const resumeEvents = await resumeTurn(runner, events, 'child1_lro');
    expect(child1Mock.requests.length).toBe(2);
    expect(child2Mock.requests.length).toBe(1);
    expect(
      getTextParts(resumeEvents).some((t) => t.includes('Child 1 answer')),
    ).toBe(true);
    expect(
      getTextParts(resumeEvents).some((t) => t.includes('Child 2 answer')),
    ).toBe(true);
  });

  it('test_parallel_agent_interrupt_and_resume', async () => {
    const sibling1Lro = new LongRunningFunctionTool({
      name: 'sibling1_lro',
      description: 'Sibling 1 LRO tool',
      execute: async () => null,
    });

    const sibling1Mock = new MockLlm([
      {
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'sibling1_lro', args: {}}}],
        },
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'Sibling 1 answer'}],
        },
      },
    ]);

    const sibling1 = new LlmAgent({
      name: 'sibling1',
      model: sibling1Mock,
      tools: [sibling1Lro],
    });

    const sibling2Mock = new MockLlm([
      {
        content: {
          role: 'model',
          parts: [{text: 'Sibling 2 answer'}],
        },
      },
    ]);

    const sibling2 = new LlmAgent({
      name: 'sibling2',
      model: sibling2Mock,
    });

    const parallelAgent = new ParallelAgent({
      name: 'parallel_agent',
      subAgents: [sibling1, sibling2],
    });

    const runner = await setupRunner(parallelAgent);
    const events = await runTurn(runner, 'Start');

    expect(sibling1Mock.requests.length).toBe(1);
    expect(sibling2Mock.requests.length).toBe(1);
    expect(
      events.some(
        (e) => e.longRunningToolIds && e.longRunningToolIds.length > 0,
      ),
    ).toBe(true);
    expect(
      getTextParts(events).some((t) => t.includes('Sibling 2 answer')),
    ).toBe(true);

    const resumeEvents = await resumeTurn(runner, events, 'sibling1_lro');
    expect(sibling1Mock.requests.length).toBe(2);
    expect(
      getTextParts(resumeEvents).some((t) => t.includes('Sibling 1 answer')),
    ).toBe(true);
  });
});
