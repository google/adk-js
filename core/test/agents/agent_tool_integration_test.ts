/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests: LlmAgent running multiple tools through the full
 * Runner → Agent → LLM → handleFunctionCallList → tools pipeline.
 *
 * These tests use a MockLlm that returns function calls on the first
 * invocation and a text response on the second (after tool results),
 * exercising the real agent loop including parallel/sequential tool dispatch.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Runner,
} from '@google/adk';
import {Content} from '@google/genai';
import {z} from 'zod';

const APP = 'test_app';
const USER = 'test_user';

// ---------------------------------------------------------------------------
// Mock LLM — yields a sequence of responses, one per generateContentAsync call
// ---------------------------------------------------------------------------

class SequentialMockLlm extends BaseLlm {
  private responses: LlmResponse[];
  private callIndex = 0;

  constructor(responses: LlmResponse[]) {
    super({model: 'mock-llm'});
    this.responses = responses;
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const resp = this.responses[this.callIndex];
    this.callIndex++;
    if (resp) {
      yield resp;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return {
      sendHistory: async (_h: Content[]) => {},
      sendContent: async (_c: Content) => {},
      sendRealtime: async (_b: {data: string; mimeType: string}) => {},
      receive: async function* () {},
      close: async () => {},
    } as BaseLlmConnection;
  }
}

// ---------------------------------------------------------------------------
// Helper: collect all events from runner.runAsync
// ---------------------------------------------------------------------------

async function runAgent(
  agent: LlmAgent,
  message: string,
  runConfig?: {
    parallelToolExecution?: boolean;
    maxConcurrentToolCalls?: number;
  },
): Promise<Event[]> {
  const sessionService = new InMemorySessionService();
  const runner = new Runner({
    appName: APP,
    agent,
    sessionService,
  });

  const session = await sessionService.createSession({
    appName: APP,
    userId: USER,
  });

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER,
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: message}]},
    runConfig,
  })) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Helper: build LlmResponse with multiple function calls
// ---------------------------------------------------------------------------

function functionCallResponse(
  calls: Array<{id: string; name: string; args?: Record<string, unknown>}>,
): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: calls.map((c) => ({
        functionCall: {id: c.id, name: c.name, args: c.args ?? {}},
      })),
    },
  };
}

function textResponse(text: string): LlmResponse {
  return {
    content: {role: 'model', parts: [{text}]},
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function makeTimedTool(
  name: string,
  delayMs: number,
  result: string,
  tracker?: string[],
) {
  return new FunctionTool({
    name,
    description: name,
    parameters: z.object({}),
    execute: async () => {
      if (tracker) tracker.push(`${name}-start`);
      await new Promise((r) => setTimeout(r, delayMs));
      if (tracker) tracker.push(`${name}-end`);
      return {result};
    },
  });
}

// ===========================================================================
// Tests
// ===========================================================================

describe('agent calling multiple tools (integration)', () => {
  it('executes 3 parallel tool calls and returns all results to the model', async () => {
    const toolA = makeTimedTool('toolA', 30, 'A-result');
    const toolB = makeTimedTool('toolB', 30, 'B-result');
    const toolC = makeTimedTool('toolC', 30, 'C-result');

    const llm = new SequentialMockLlm([
      functionCallResponse([
        {id: 'c1', name: 'toolA'},
        {id: 'c2', name: 'toolB'},
        {id: 'c3', name: 'toolC'},
      ]),
      textResponse('All tools done.'),
    ]);

    const agent = new LlmAgent({
      name: 'test_agent',
      model: llm,
      tools: [toolA, toolB, toolC],
    });

    const events = await runAgent(agent, 'run all tools');

    const functionResponseEvent = events.find(
      (e) =>
        e.content?.parts?.some((p) => p.functionResponse != null),
    );
    expect(functionResponseEvent).toBeDefined();

    const parts = functionResponseEvent!.content!.parts!;
    const responses = parts
      .filter((p) => p.functionResponse)
      .map((p) => ({
        name: p.functionResponse!.name,
        result: (p.functionResponse!.response as Record<string, string>)
          .result,
      }));

    expect(responses).toHaveLength(3);
    expect(responses).toContainEqual({name: 'toolA', result: 'A-result'});
    expect(responses).toContainEqual({name: 'toolB', result: 'B-result'});
    expect(responses).toContainEqual({name: 'toolC', result: 'C-result'});

    const textEvent = events.find(
      (e) => e.content?.parts?.some((p) => p.text === 'All tools done.'),
    );
    expect(textEvent).toBeDefined();
  });

  it('parallel mode is faster than sequential for multiple tool calls', async () => {
    const DELAY = 80;

    async function runWithMode(parallel: boolean): Promise<number> {
      const toolA = makeTimedTool('toolA', DELAY, 'A');
      const toolB = makeTimedTool('toolB', DELAY, 'B');
      const toolC = makeTimedTool('toolC', DELAY, 'C');

      const llm = new SequentialMockLlm([
        functionCallResponse([
          {id: 'c1', name: 'toolA'},
          {id: 'c2', name: 'toolB'},
          {id: 'c3', name: 'toolC'},
        ]),
        textResponse('done'),
      ]);

      const agent = new LlmAgent({
        name: 'test_agent',
        model: llm,
        tools: [toolA, toolB, toolC],
      });

      const start = Date.now();
      await runAgent(agent, 'go', {parallelToolExecution: parallel});
      return Date.now() - start;
    }

    const parallelTime = await runWithMode(true);
    const sequentialTime = await runWithMode(false);

    expect(sequentialTime).toBeGreaterThan(parallelTime * 1.5);
  });

  it('sequential mode preserves strict tool execution order', async () => {
    const tracker: string[] = [];

    const toolA = makeTimedTool('toolA', 40, 'A', tracker);
    const toolB = makeTimedTool('toolB', 40, 'B', tracker);

    const llm = new SequentialMockLlm([
      functionCallResponse([
        {id: 'c1', name: 'toolA'},
        {id: 'c2', name: 'toolB'},
      ]),
      textResponse('done'),
    ]);

    const agent = new LlmAgent({
      name: 'test_agent',
      model: llm,
      tools: [toolA, toolB],
    });

    await runAgent(agent, 'go', {parallelToolExecution: false});

    expect(tracker).toEqual([
      'toolA-start',
      'toolA-end',
      'toolB-start',
      'toolB-end',
    ]);
  });

  it('one failing tool does not prevent others from completing', async () => {
    const goodTool = makeTimedTool('goodTool', 10, 'success');
    const failTool = new FunctionTool({
      name: 'failTool',
      description: 'fails',
      parameters: z.object({}),
      execute: async () => {
        throw new Error('boom');
      },
    });

    const llm = new SequentialMockLlm([
      functionCallResponse([
        {id: 'c1', name: 'goodTool'},
        {id: 'c2', name: 'failTool'},
      ]),
      textResponse('handled'),
    ]);

    const agent = new LlmAgent({
      name: 'test_agent',
      model: llm,
      tools: [goodTool, failTool],
    });

    const events = await runAgent(agent, 'go');

    const frEvent = events.find(
      (e) =>
        e.content?.parts?.some((p) => p.functionResponse != null),
    );
    expect(frEvent).toBeDefined();

    const parts = frEvent!.content!.parts!.filter(
      (p) => p.functionResponse,
    );
    expect(parts).toHaveLength(2);

    const good = parts.find((p) => p.functionResponse!.name === 'goodTool');
    expect(
      (good!.functionResponse!.response as Record<string, string>).result,
    ).toBe('success');

    const fail = parts.find((p) => p.functionResponse!.name === 'failTool');
    expect(
      (fail!.functionResponse!.response as Record<string, string>).error,
    ).toBeDefined();
  });

  it('callbacks fire for each tool in a multi-tool call', async () => {
    const callbackLog: string[] = [];

    const toolA = makeTimedTool('toolA', 10, 'A');
    const toolB = makeTimedTool('toolB', 10, 'B');

    const llm = new SequentialMockLlm([
      functionCallResponse([
        {id: 'c1', name: 'toolA'},
        {id: 'c2', name: 'toolB'},
      ]),
      textResponse('done'),
    ]);

    const agent = new LlmAgent({
      name: 'test_agent',
      model: llm,
      tools: [toolA, toolB],
      beforeToolCallback: async ({tool}) => {
        callbackLog.push(`before:${tool.name}`);
        return undefined;
      },
      afterToolCallback: async ({tool}) => {
        callbackLog.push(`after:${tool.name}`);
        return undefined;
      },
    });

    await runAgent(agent, 'go');

    expect(callbackLog).toContain('before:toolA');
    expect(callbackLog).toContain('before:toolB');
    expect(callbackLog).toContain('after:toolA');
    expect(callbackLog).toContain('after:toolB');
    expect(callbackLog).toHaveLength(4);
  });

  it('agent completes the loop: tools → model summary', async () => {
    const toolA = makeTimedTool('toolA', 10, 'data-from-A');

    const llm = new SequentialMockLlm([
      functionCallResponse([{id: 'c1', name: 'toolA'}]),
      textResponse('Summary: got data-from-A'),
    ]);

    const agent = new LlmAgent({
      name: 'test_agent',
      model: llm,
      tools: [toolA],
    });

    const events = await runAgent(agent, 'fetch data');

    const hasToolResponse = events.some(
      (e) =>
        e.content?.parts?.some(
          (p) =>
            p.functionResponse?.name === 'toolA' &&
            (p.functionResponse.response as Record<string, string>).result ===
              'data-from-A',
        ),
    );
    expect(hasToolResponse).toBe(true);

    const hasSummary = events.some(
      (e) =>
        e.content?.parts?.some(
          (p) => p.text === 'Summary: got data-from-A',
        ),
    );
    expect(hasSummary).toBe(true);
  });

  it('maxConcurrentToolCalls limits concurrency through the full agent loop', async () => {
    let peakConcurrency = 0;
    let activeCalls = 0;

    function makeConcurrencyTool(name: string) {
      return new FunctionTool({
        name,
        description: name,
        parameters: z.object({}),
        execute: async () => {
          activeCalls++;
          if (activeCalls > peakConcurrency) {
            peakConcurrency = activeCalls;
          }
          await new Promise((r) => setTimeout(r, 40));
          activeCalls--;
          return {result: `${name}-done`};
        },
      });
    }

    const tools = [
      makeConcurrencyTool('t1'),
      makeConcurrencyTool('t2'),
      makeConcurrencyTool('t3'),
      makeConcurrencyTool('t4'),
    ];

    const llm = new SequentialMockLlm([
      functionCallResponse([
        {id: 'c1', name: 't1'},
        {id: 'c2', name: 't2'},
        {id: 'c3', name: 't3'},
        {id: 'c4', name: 't4'},
      ]),
      textResponse('all done'),
    ]);

    const agent = new LlmAgent({
      name: 'test_agent',
      model: llm,
      tools,
    });

    const events = await runAgent(agent, 'go', {
      parallelToolExecution: true,
      maxConcurrentToolCalls: 2,
    });

    const frEvent = events.find(
      (e) => e.content?.parts?.some((p) => p.functionResponse != null),
    );
    expect(frEvent).toBeDefined();
    expect(
      frEvent!.content!.parts!.filter((p) => p.functionResponse),
    ).toHaveLength(4);

    expect(peakConcurrency).toBeLessThanOrEqual(2);
    expect(peakConcurrency).toBeGreaterThanOrEqual(1);
  });

  it('parallel execution proves concurrency via overlapping execution order', async () => {
    const tracker: string[] = [];

    const toolA = makeTimedTool('toolA', 50, 'A', tracker);
    const toolB = makeTimedTool('toolB', 50, 'B', tracker);

    const llm = new SequentialMockLlm([
      functionCallResponse([
        {id: 'c1', name: 'toolA'},
        {id: 'c2', name: 'toolB'},
      ]),
      textResponse('done'),
    ]);

    const agent = new LlmAgent({
      name: 'test_agent',
      model: llm,
      tools: [toolA, toolB],
    });

    await runAgent(agent, 'go');

    // In parallel, both tools start before either finishes
    expect(tracker.indexOf('toolA-start')).toBeLessThan(
      tracker.indexOf('toolA-end'),
    );
    expect(tracker.indexOf('toolB-start')).toBeLessThan(
      tracker.indexOf('toolB-end'),
    );
    // Both starts happen before any end (proves overlap)
    const firstEnd = Math.min(
      tracker.indexOf('toolA-end'),
      tracker.indexOf('toolB-end'),
    );
    expect(tracker.indexOf('toolA-start')).toBeLessThan(firstEnd);
    expect(tracker.indexOf('toolB-start')).toBeLessThan(firstEnd);
  });
});
