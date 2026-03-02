/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  BasePlugin,
  BaseTool,
  createEvent,
  Event,
  functionsExportedForTestingOnly,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Session,
  SingleAfterToolCallback,
  SingleBeforeToolCallback,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {z} from 'zod';

// Get the test target function
const {
  handleFunctionCallList,
  generateAuthEvent,
  generateRequestConfirmationEvent,
} = functionsExportedForTestingOnly;
const handleFunctionCallsAsync = (
  functionsExportedForTestingOnly as unknown as {
    handleFunctionCallsAsync: (args: {
      invocationContext: InvocationContext;
      functionCallEvent: Event;
      toolsDict: Record<string, BaseTool>;
      beforeToolCallbacks: SingleBeforeToolCallback[];
      afterToolCallbacks: SingleAfterToolCallback[];
      filters?: Set<string>;
    }) => AsyncGenerator<Event, void, void>;
  }
).handleFunctionCallsAsync;

// Tool for testing
const testTool = new FunctionTool({
  name: 'testTool',
  description: 'test tool',
  parameters: z.object({}),
  execute: async () => {
    return {result: 'tool executed'};
  },
});

const errorTool = new FunctionTool({
  name: 'errorTool',
  description: 'error tool',
  parameters: z.object({}),
  execute: async () => {
    throw new Error('tool error message content');
  },
});

// Plugin for testing
class TestPlugin extends BasePlugin {
  beforeToolCallbackResponse?: Record<string, unknown>;
  afterToolCallbackResponse?: Record<string, unknown>;
  onToolErrorCallbackResponse?: Record<string, unknown>;

  override async beforeToolCallback(
    ..._args: Parameters<BasePlugin['beforeToolCallback']>
  ): Promise<Record<string, unknown> | undefined> {
    if (this.beforeToolCallbackResponse) {
      return this.beforeToolCallbackResponse;
    }
    return undefined;
  }

  override async afterToolCallback(
    ..._args: Parameters<BasePlugin['afterToolCallback']>
  ): Promise<Record<string, unknown> | undefined> {
    if (this.afterToolCallbackResponse) {
      return this.afterToolCallbackResponse;
    }
    return undefined;
  }

  override async onToolErrorCallback(
    ..._args: Parameters<BasePlugin['onToolErrorCallback']>
  ): Promise<Record<string, unknown> | undefined> {
    if (this.onToolErrorCallbackResponse) {
      return this.onToolErrorCallbackResponse;
    }
    return undefined;
  }
}

function randomIdForTestingOnly(): string {
  return (Math.random() * 100).toString();
}

describe('handleFunctionCallList', () => {
  let invocationContext: InvocationContext;
  let pluginManager: PluginManager;
  let functionCall: FunctionCall;
  let toolsDict: Record<string, BaseTool>;

  beforeEach(() => {
    pluginManager = new PluginManager();
    const agent = new LlmAgent({name: 'test_agent', model: 'test_model'});
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent,
      pluginManager,
    });
    functionCall = {
      id: randomIdForTestingOnly(),
      name: 'testTool',
      args: {},
    };
    toolsDict = {'testTool': testTool};
  });

  it('should execute tool with no callbacks or plugins', async () => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'tool executed',
    });
  });

  it('should execute beforeToolCallback and return its result', async () => {
    const beforeToolCallback: SingleBeforeToolCallback = async () => {
      return {result: 'beforeToolCallback executed'};
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [beforeToolCallback],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'beforeToolCallback executed',
    });
  });

  it('should execute second beforeToolCallback if first returns undefined', async () => {
    const beforeToolCallback1: SingleBeforeToolCallback = async () => {
      return undefined;
    };
    const beforeToolCallback2: SingleBeforeToolCallback = async () => {
      return {result: 'beforeToolCallback2 executed'};
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [beforeToolCallback1, beforeToolCallback2],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'beforeToolCallback2 executed',
    });
  });

  it('should execute afterToolCallback and return its result', async () => {
    const afterToolCallback: SingleAfterToolCallback = async () => {
      return {result: 'afterToolCallback executed'};
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [afterToolCallback],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'afterToolCallback executed',
    });
  });

  it('should execute second afterToolCallback if first returns undefined', async () => {
    const afterToolCallback1: SingleAfterToolCallback = async () => {
      return undefined;
    };
    const afterToolCallback2: SingleAfterToolCallback = async () => {
      return {result: 'afterToolCallback2 executed'};
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [afterToolCallback1, afterToolCallback2],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'afterToolCallback2 executed',
    });
  });

  it('should execute plugin beforeToolCallback and return its result', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.beforeToolCallbackResponse = {
      result: 'plugin beforeToolCallback executed',
    };
    pluginManager.registerPlugin(plugin);
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'plugin beforeToolCallback executed',
    });
  });

  it('should execute plugin afterToolCallback and return its result', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.afterToolCallbackResponse = {
      result: 'plugin afterToolCallback executed',
    };
    pluginManager.registerPlugin(plugin);
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'plugin afterToolCallback executed',
    });
  });

  it('should call plugin onToolErrorCallback when tool throws', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.onToolErrorCallbackResponse = {
      result: 'onToolErrorCallback executed',
    };
    pluginManager.registerPlugin(plugin);
    const errorFunctionCall: FunctionCall = {
      id: randomIdForTestingOnly(),
      name: 'errorTool',
      args: {},
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [errorFunctionCall],
      toolsDict: {'errorTool': errorTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event).not.toBeNull();
    const definedEvent = event as Event;
    expect(definedEvent.content!.parts![0].functionResponse!.response).toEqual({
      result: 'onToolErrorCallback executed',
    });
  });

  it('should return error message when error is thrown during tool execution, when no plugin onToolErrorCallback is provided', async () => {
    const errorFunctionCall: FunctionCall = {
      id: randomIdForTestingOnly(),
      name: 'errorTool',
      args: {},
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [errorFunctionCall],
      toolsDict: {'errorTool': errorTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event!.content!.parts![0].functionResponse!.response).toEqual({
      error: "Error in tool 'errorTool': tool error message content",
    });
  });

  it('should deep-copy args so callback mutations do not affect original FunctionCall', async () => {
    const originalArgs = {key: 'original'};
    const mutatingCallback: SingleBeforeToolCallback = async ({args}) => {
      (args as Record<string, unknown>).key = 'mutated-by-callback';
      return undefined;
    };

    const calls: FunctionCall[] = [
      {id: randomIdForTestingOnly(), name: 'testTool', args: originalArgs},
    ];

    await handleFunctionCallList({
      invocationContext,
      functionCalls: calls,
      toolsDict: {testTool},
      beforeToolCallbacks: [mutatingCallback],
      afterToolCallbacks: [],
    });

    expect(originalArgs.key).toBe('original');
    expect(calls[0].args!.key).toBe('original');
  });

  it('should invoke onToolErrorCallback when tool is not found', async () => {
    const plugin = new TestPlugin('testPlugin');
    plugin.onToolErrorCallbackResponse = {
      result: 'error handled gracefully',
    };
    pluginManager.registerPlugin(plugin);

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'id-1', name: 'nonexistentTool', args: {}}],
      toolsDict: {},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    expect(event!.content!.parts![0].functionResponse!.response).toEqual({
      result: 'error handled gracefully',
    });
  });
});

describe('parallel tool execution', () => {
  let invocationContext: InvocationContext;
  let pluginManager: PluginManager;

  beforeEach(() => {
    pluginManager = new PluginManager();
    const agent = new LlmAgent({name: 'test_agent', model: 'test_model'});
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent,
      pluginManager,
    });
  });

  function makeDelayedTool(name: string, delayMs: number, result: string) {
    return new FunctionTool({
      name,
      description: name,
      parameters: z.object({}),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return {result};
      },
    });
  }

  function makeFailingTool(name: string, delayMs: number) {
    return new FunctionTool({
      name,
      description: name,
      parameters: z.object({}),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        throw new Error(`${name} failed`);
      },
    });
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('should execute multiple tools concurrently (faster than sequential)', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };
    const DELAY = 100;
    const toolA = makeDelayedTool('toolA', DELAY, 'A done');
    const toolB = makeDelayedTool('toolB', DELAY, 'B done');
    const toolC = makeDelayedTool('toolC', DELAY, 'C done');

    const toolsDict = {toolA, toolB, toolC};
    const calls: FunctionCall[] = [
      {id: 'id-a', name: 'toolA', args: {}},
      {id: 'id-b', name: 'toolB', args: {}},
      {id: 'id-c', name: 'toolC', args: {}},
    ];

    const start = Date.now();
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: calls,
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    const elapsed = Date.now() - start;

    expect(event).not.toBeNull();
    const parts = event!.content!.parts!;
    expect(parts).toHaveLength(3);

    const responses = parts.map(
      (p) => (p.functionResponse!.response as Record<string, string>).result,
    );
    expect(responses).toContain('A done');
    expect(responses).toContain('B done');
    expect(responses).toContain('C done');

    // Parallel: should take ~DELAY, not ~3*DELAY.
    // Use 2*DELAY as threshold to account for test runner overhead.
    expect(elapsed).toBeLessThan(DELAY * 2);
  });

  it('should isolate errors — failed tool does not prevent other tools from returning', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };
    const toolA = makeDelayedTool('toolA', 50, 'A done');
    const toolB = makeFailingTool('toolB', 50);
    const toolC = makeDelayedTool('toolC', 50, 'C done');

    const toolsDict = {toolA, toolB, toolC};
    const calls: FunctionCall[] = [
      {id: 'id-a', name: 'toolA', args: {}},
      {id: 'id-b', name: 'toolB', args: {}},
      {id: 'id-c', name: 'toolC', args: {}},
    ];

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: calls,
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const parts = event!.content!.parts!;
    expect(parts).toHaveLength(3);

    const responseA = parts.find((p) => p.functionResponse!.name === 'toolA');
    expect(
      (responseA!.functionResponse!.response as Record<string, string>).result,
    ).toBe('A done');

    const responseB = parts.find((p) => p.functionResponse!.name === 'toolB');
    expect(
      (responseB!.functionResponse!.response as Record<string, string>).error,
    ).toContain('toolB failed');

    const responseC = parts.find((p) => p.functionResponse!.name === 'toolC');
    expect(
      (responseC!.functionResponse!.response as Record<string, string>).result,
    ).toBe('C done');
  });

  it('should preserve result order matching input function call order', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };
    // Tool A is slow, B is fast — results should still be in [A, B] order
    const toolA = makeDelayedTool('toolA', 100, 'A done');
    const toolB = makeDelayedTool('toolB', 10, 'B done');

    const toolsDict = {toolA, toolB};
    const calls: FunctionCall[] = [
      {id: 'id-a', name: 'toolA', args: {}},
      {id: 'id-b', name: 'toolB', args: {}},
    ];

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: calls,
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const parts = event!.content!.parts!;
    expect(parts[0].functionResponse!.name).toBe('toolA');
    expect(parts[1].functionResponse!.name).toBe('toolB');
  });

  it('parallel mode: order preserved even when fast tool finishes before slow tool', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };
    const toolA = makeDelayedTool('toolA', 150, 'A done');
    const toolB = makeDelayedTool('toolB', 10, 'B done');
    const toolC = makeDelayedTool('toolC', 80, 'C done');

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'id-a', name: 'toolA', args: {}},
        {id: 'id-b', name: 'toolB', args: {}},
        {id: 'id-c', name: 'toolC', args: {}},
      ],
      toolsDict: {toolA, toolB, toolC},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const parts = event!.content!.parts!;
    expect(parts).toHaveLength(3);
    // B finishes first (~10ms), C second (~80ms), A last (~150ms)
    // but results must follow input order: A, B, C
    expect(parts[0].functionResponse!.name).toBe('toolA');
    expect(parts[1].functionResponse!.name).toBe('toolB');
    expect(parts[2].functionResponse!.name).toBe('toolC');
  });

  it('should run callbacks concurrently for each parallel tool call', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };
    const callbackOrder: string[] = [];

    const toolA = makeDelayedTool('toolA', 50, 'A done');
    const toolB = makeDelayedTool('toolB', 50, 'B done');

    const beforeCallback: SingleBeforeToolCallback = async ({tool}) => {
      callbackOrder.push(`before:${tool.name}`);
      return undefined;
    };
    const afterCallback: SingleAfterToolCallback = async ({tool}) => {
      callbackOrder.push(`after:${tool.name}`);
      return undefined;
    };

    const toolsDict = {toolA, toolB};
    const calls: FunctionCall[] = [
      {id: 'id-a', name: 'toolA', args: {}},
      {id: 'id-b', name: 'toolB', args: {}},
    ];

    await handleFunctionCallList({
      invocationContext,
      functionCalls: calls,
      toolsDict,
      beforeToolCallbacks: [beforeCallback],
      afterToolCallbacks: [afterCallback],
    });

    // Both before callbacks should fire, both after callbacks should fire
    expect(callbackOrder).toContain('before:toolA');
    expect(callbackOrder).toContain('before:toolB');
    expect(callbackOrder).toContain('after:toolA');
    expect(callbackOrder).toContain('after:toolB');
    expect(callbackOrder).toHaveLength(4);
  });

  it('single function call behaves identically to previous sequential implementation', async () => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'id-1', name: 'testTool', args: {}}],
      toolsDict: {testTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    expect(event!.content!.parts!).toHaveLength(1);
    expect(event!.content!.parts![0].functionResponse!.response).toEqual({
      result: 'tool executed',
    });
  });

  it('should fall back to sequential when parallelToolExecution is false', async () => {
    const executionOrder: string[] = [];
    const toolA = new FunctionTool({
      name: 'toolA',
      description: 'A',
      parameters: z.object({}),
      execute: async () => {
        executionOrder.push('A-start');
        await new Promise((r) => setTimeout(r, 50));
        executionOrder.push('A-end');
        return {result: 'A done'};
      },
    });
    const toolB = new FunctionTool({
      name: 'toolB',
      description: 'B',
      parameters: z.object({}),
      execute: async () => {
        executionOrder.push('B-start');
        await new Promise((r) => setTimeout(r, 50));
        executionOrder.push('B-end');
        return {result: 'B done'};
      },
    });

    invocationContext.runConfig = {
      parallelToolExecution: false,
      maxLlmCalls: 500,
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'id-a', name: 'toolA', args: {}},
        {id: 'id-b', name: 'toolB', args: {}},
      ],
      toolsDict: {toolA, toolB},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    // Sequential: A must finish before B starts
    expect(executionOrder).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);
  });

  it('sequential mode: error in one tool does not stop subsequent tools', async () => {
    const toolA = makeFailingTool('toolA', 10);
    const toolB = makeDelayedTool('toolB', 10, 'B done');

    invocationContext.runConfig = {
      parallelToolExecution: false,
      maxLlmCalls: 500,
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'id-a', name: 'toolA', args: {}},
        {id: 'id-b', name: 'toolB', args: {}},
      ],
      toolsDict: {toolA, toolB},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const parts = event!.content!.parts!;
    expect(parts).toHaveLength(2);

    const respA = parts.find((p) => p.functionResponse!.name === 'toolA');
    expect(
      (respA!.functionResponse!.response as Record<string, string>).error,
    ).toContain('toolA failed');

    const respB = parts.find((p) => p.functionResponse!.name === 'toolB');
    expect(
      (respB!.functionResponse!.response as Record<string, string>).result,
    ).toBe('B done');
  });

  it('defaults to sequential when runConfig is undefined', async () => {
    invocationContext.runConfig = undefined;

    const executionOrder: string[] = [];
    const toolA = new FunctionTool({
      name: 'toolA',
      description: 'tool A',
      parameters: z.object({}),
      execute: async () => {
        executionOrder.push('A-start');
        await new Promise((r) => setTimeout(r, 30));
        executionOrder.push('A-end');
        return {result: 'A done'};
      },
    });
    const toolB = new FunctionTool({
      name: 'toolB',
      description: 'tool B',
      parameters: z.object({}),
      execute: async () => {
        executionOrder.push('B-start');
        await new Promise((r) => setTimeout(r, 30));
        executionOrder.push('B-end');
        return {result: 'B done'};
      },
    });

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'id-a', name: 'toolA', args: {}},
        {id: 'id-b', name: 'toolB', args: {}},
      ],
      toolsDict: {toolA, toolB},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    expect(event!.content!.parts!).toHaveLength(2);
    // Sequential: A must fully finish before B starts
    expect(executionOrder).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);
  });

  it('parallel mode: tool-not-found produces error event without crashing others', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };
    const toolA = makeDelayedTool('toolA', 10, 'A done');

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'id-a', name: 'toolA', args: {}},
        {id: 'id-missing', name: 'missingTool', args: {}},
      ],
      toolsDict: {toolA},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const parts = event!.content!.parts!;
    expect(parts).toHaveLength(2);

    const respA = parts.find((p) => p.functionResponse!.name === 'toolA');
    expect(
      (respA!.functionResponse!.response as Record<string, string>).result,
    ).toBe('A done');

    const respMissing = parts.find(
      (p) => p.functionResponse!.name === 'missingTool',
    );
    expect(
      (respMissing!.functionResponse!.response as Record<string, string>).error,
    ).toContain('missingTool');
  });

  it('returns null when all function calls are filtered out', async () => {
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'id-a', name: 'testTool', args: {}}],
      toolsDict: {testTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
      filters: new Set(['some-other-id']),
    });

    expect(event).toBeNull();
  });

  it('sequential mode takes longer than parallel for same workload', async () => {
    const DELAY = 60;
    const toolA = makeDelayedTool('toolA', DELAY, 'A');
    const toolB = makeDelayedTool('toolB', DELAY, 'B');
    const toolC = makeDelayedTool('toolC', DELAY, 'C');
    const tools = {toolA, toolB, toolC};
    const calls: FunctionCall[] = [
      {id: 'a', name: 'toolA', args: {}},
      {id: 'b', name: 'toolB', args: {}},
      {id: 'c', name: 'toolC', args: {}},
    ];

    // Parallel run
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };
    const pStart = Date.now();
    await handleFunctionCallList({
      invocationContext,
      functionCalls: calls,
      toolsDict: tools,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    const pElapsed = Date.now() - pStart;

    // Sequential run
    invocationContext.runConfig = {
      parallelToolExecution: false,
      maxLlmCalls: 500,
    };
    const sStart = Date.now();
    await handleFunctionCallList({
      invocationContext,
      functionCalls: calls,
      toolsDict: tools,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    const sElapsed = Date.now() - sStart;

    // Sequential should take at least 2x longer than parallel
    expect(sElapsed).toBeGreaterThan(pElapsed * 1.5);
  });

  it('maxConcurrentToolCalls limits batch size in parallel mode', async () => {
    const concurrencyTracker: number[] = [];
    let activeCalls = 0;

    function makeTrackedTool(name: string, delayMs: number) {
      return new FunctionTool({
        name,
        description: name,
        parameters: z.object({}),
        execute: async () => {
          activeCalls++;
          concurrencyTracker.push(activeCalls);
          await new Promise((r) => setTimeout(r, delayMs));
          activeCalls--;
          return {result: `${name} done`};
        },
      });
    }

    const tools = ['t1', 't2', 't3', 't4', 't5'].reduce(
      (acc, name) => ({...acc, [name]: makeTrackedTool(name, 50)}),
      {} as Record<string, BaseTool>,
    );

    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxConcurrentToolCalls: 2,
      maxLlmCalls: 500,
    };

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: Object.keys(tools).map((name) => ({
        id: name,
        name,
        args: {},
      })),
      toolsDict: tools,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    expect(event!.content!.parts!).toHaveLength(5);
    // Peak concurrency should never exceed the batch size of 2
    expect(Math.max(...concurrencyTracker)).toBeLessThanOrEqual(2);
  });

  it('maxConcurrentToolCalls is ignored in sequential mode', async () => {
    const executionOrder: string[] = [];

    function makeOrderTool(name: string) {
      return new FunctionTool({
        name,
        description: name,
        parameters: z.object({}),
        execute: async () => {
          executionOrder.push(`${name}-start`);
          await new Promise((r) => setTimeout(r, 20));
          executionOrder.push(`${name}-end`);
          return {result: name};
        },
      });
    }

    const toolA = makeOrderTool('toolA');
    const toolB = makeOrderTool('toolB');
    const toolC = makeOrderTool('toolC');

    invocationContext.runConfig = {
      parallelToolExecution: false,
      maxConcurrentToolCalls: 2,
      maxLlmCalls: 500,
    };

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'a', name: 'toolA', args: {}},
        {id: 'b', name: 'toolB', args: {}},
        {id: 'c', name: 'toolC', args: {}},
      ],
      toolsDict: {toolA, toolB, toolC},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(executionOrder).toEqual([
      'toolA-start',
      'toolA-end',
      'toolB-start',
      'toolB-end',
      'toolC-start',
      'toolC-end',
    ]);
  });

  it('warns on stateDelta key conflicts in parallel mode', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };
    const warnSpy = vi.spyOn(console, 'warn');

    const toolA = new FunctionTool({
      name: 'toolA',
      description: 'sets counter',
      parameters: z.object({}),
      execute: async (_args, context) => {
        context!.actions.stateDelta['counter'] = 1;
        return {result: 'A'};
      },
    });
    const toolB = new FunctionTool({
      name: 'toolB',
      description: 'also sets counter',
      parameters: z.object({}),
      execute: async (_args, context) => {
        context!.actions.stateDelta['counter'] = 2;
        return {result: 'B'};
      },
    });

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'a', name: 'toolA', args: {}},
        {id: 'b', name: 'toolB', args: {}},
      ],
      toolsDict: {toolA, toolB},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();

    const warnCalls = warnSpy.mock.calls
      .map((args) => args.join(' '))
      .filter((msg) => msg.includes('stateDelta'));
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(warnCalls[0]).toContain('counter');

    warnSpy.mockRestore();
  });

  it('no stateDelta warning when parallel tools write different keys', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };
    const warnSpy = vi.spyOn(console, 'warn');

    const toolA = new FunctionTool({
      name: 'toolA',
      description: 'sets key_a',
      parameters: z.object({}),
      execute: async (_args, context) => {
        context!.actions.stateDelta['key_a'] = 1;
        return {result: 'A'};
      },
    });
    const toolB = new FunctionTool({
      name: 'toolB',
      description: 'sets key_b',
      parameters: z.object({}),
      execute: async (_args, context) => {
        context!.actions.stateDelta['key_b'] = 2;
        return {result: 'B'};
      },
    });

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'a', name: 'toolA', args: {}},
        {id: 'b', name: 'toolB', args: {}},
      ],
      toolsDict: {toolA, toolB},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const stateDeltaWarns = warnSpy.mock.calls
      .map((args) => args.join(' '))
      .filter((msg) => msg.includes('stateDelta'));
    expect(stateDeltaWarns).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it('parallel mode: each tool gets independent deep-copied args', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };

    const sharedArgs = {counter: 0};
    const mutatingCallback: SingleBeforeToolCallback = async ({tool, args}) => {
      if (tool.name === 'toolA') {
        (args as Record<string, unknown>).counter = 999;
      }
      return undefined;
    };

    const toolA = makeDelayedTool('toolA', 10, 'A done');
    const toolB = makeDelayedTool('toolB', 10, 'B done');

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'a', name: 'toolA', args: sharedArgs},
        {id: 'b', name: 'toolB', args: sharedArgs},
      ],
      toolsDict: {toolA, toolB},
      beforeToolCallbacks: [mutatingCallback],
      afterToolCallbacks: [],
    });

    expect(sharedArgs.counter).toBe(0);
  });

  it('parallel mode: nested stateDelta is deep-merged across tools', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };

    const toolA = new FunctionTool({
      name: 'toolA',
      description: 'sets user.name',
      parameters: z.object({}),
      execute: async (_args, context) => {
        context!.actions.stateDelta['user'] = {name: 'Alice'};
        return {result: 'A'};
      },
    });

    const toolB = new FunctionTool({
      name: 'toolB',
      description: 'sets user.age',
      parameters: z.object({}),
      execute: async (_args, context) => {
        context!.actions.stateDelta['user'] = {age: 30};
        return {result: 'B'};
      },
    });

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'a', name: 'toolA', args: {}},
        {id: 'b', name: 'toolB', args: {}},
      ],
      toolsDict: {toolA, toolB},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event!.actions!.stateDelta['user']).toEqual({
      name: 'Alice',
      age: 30,
    });
  });

  it('parallel mode: tool-not-found invokes error callback instead of generic error', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };

    const plugin = new TestPlugin('testPlugin');
    plugin.onToolErrorCallbackResponse = {result: 'missing tool handled'};
    pluginManager.registerPlugin(plugin);

    const toolA = makeDelayedTool('toolA', 10, 'A done');

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'id-a', name: 'toolA', args: {}},
        {id: 'id-missing', name: 'nonexistentTool', args: {}},
      ],
      toolsDict: {toolA},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const parts = event!.content!.parts!;
    expect(parts).toHaveLength(2);

    const respA = parts.find((p) => p.functionResponse!.name === 'toolA');
    expect(
      (respA!.functionResponse!.response as Record<string, string>).result,
    ).toBe('A done');

    const respMissing = parts.find(
      (p) => p.functionResponse!.name === 'nonexistentTool',
    );
    expect(
      (respMissing!.functionResponse!.response as Record<string, string>)
        .result,
    ).toBe('missing tool handled');
  });

  it('tool-not-found error callback receives a tool with description (BUG 2)', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: false,
      maxLlmCalls: 500,
    };
    let receivedDescription: string | undefined;

    class CapturingPlugin extends BasePlugin {
      override async onToolErrorCallback({
        tool,
      }: {
        tool: BaseTool;
        toolArgs: Record<string, unknown>;
        toolContext: unknown;
        error: Error;
      }): Promise<Record<string, unknown> | undefined> {
        receivedDescription = tool.description;
        return {result: 'handled'};
      }
    }

    pluginManager.registerPlugin(new CapturingPlugin('capturingPlugin'));

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'id-m', name: 'missingTool', args: {}}],
      toolsDict: {},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    expect(receivedDescription).toBeDefined();
    expect(typeof receivedDescription).toBe('string');
  });

  it('maxConcurrentToolCalls with fractional value is floored to nearest integer (BUG 3)', async () => {
    let activeCalls = 0;
    const peakConcurrency: number[] = [];

    function makeTracked(name: string) {
      return new FunctionTool({
        name,
        description: name,
        parameters: z.object({}),
        execute: async () => {
          activeCalls++;
          peakConcurrency.push(activeCalls);
          await new Promise((r) => setTimeout(r, 30));
          activeCalls--;
          return {result: name};
        },
      });
    }

    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxConcurrentToolCalls: 1.5,
      maxLlmCalls: 500,
    };

    const tools: Record<string, BaseTool> = {
      a: makeTracked('a'),
      b: makeTracked('b'),
      c: makeTracked('c'),
      d: makeTracked('d'),
    };
    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: Object.keys(tools).map((n) => ({
        id: n,
        name: n,
        args: {},
      })),
      toolsDict: tools,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    expect(event!.content!.parts!).toHaveLength(4);
    expect(Math.max(...peakConcurrency)).toBeLessThanOrEqual(1);
  });

  it('parallel mode: circular stateDelta values do not crash conflict warning (BUG 4)', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };

    const circular: Record<string, unknown> = {a: 1};
    circular.self = circular;

    const toolA = new FunctionTool({
      name: 'toolA',
      description: 'A',
      parameters: z.object({}),
      execute: async (_args, context) => {
        context!.actions.stateDelta['data'] = circular;
        return {result: 'A'};
      },
    });
    const toolB = new FunctionTool({
      name: 'toolB',
      description: 'B',
      parameters: z.object({}),
      execute: async (_args, context) => {
        context!.actions.stateDelta['data'] = {b: 2};
        return {result: 'B'};
      },
    });

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'a', name: 'toolA', args: {}},
        {id: 'b', name: 'toolB', args: {}},
      ],
      toolsDict: {toolA, toolB},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    expect(event!.content!.parts!).toHaveLength(2);
  });

  it('sequential mode: tool-not-found does not prevent subsequent tools from running (BUG 5)', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: false,
      maxLlmCalls: 500,
    };
    const toolB = makeDelayedTool('toolB', 10, 'B done');

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'id-missing', name: 'missingTool', args: {}},
        {id: 'id-b', name: 'toolB', args: {}},
      ],
      toolsDict: {toolB},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    const parts = event!.content!.parts!;
    expect(parts).toHaveLength(2);

    const respMissing = parts.find(
      (p) => p.functionResponse!.name === 'missingTool',
    );
    expect(
      (respMissing!.functionResponse!.response as Record<string, string>).error,
    ).toContain('missingTool');

    const respB = parts.find((p) => p.functionResponse!.name === 'toolB');
    expect(
      (respB!.functionResponse!.response as Record<string, string>).result,
    ).toBe('B done');
  });

  it('merged event preserves invocationId from all source events', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };
    const toolA = makeDelayedTool('toolA', 10, 'A done');
    const toolB = makeDelayedTool('toolB', 10, 'B done');

    const event = await handleFunctionCallList({
      invocationContext,
      functionCalls: [
        {id: 'id-a', name: 'toolA', args: {}},
        {id: 'id-b', name: 'toolB', args: {}},
      ],
      toolsDict: {toolA, toolB},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(event).not.toBeNull();
    // The merged event must carry the invocationId from the source events.
    // Without the fix, createEvent defaults invocationId to '' when not passed.
    expect(event!.invocationId).toBe('inv_123');
  });

  it('handleFunctionCallsAsync streams per batch when maxConcurrentToolCalls is set', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxConcurrentToolCalls: 2,
      maxLlmCalls: 500,
    };

    const toolA = makeDelayedTool('toolA', 80, 'A done');
    const toolB = makeDelayedTool('toolB', 80, 'B done');
    const toolC = makeDelayedTool('toolC', 80, 'C done');

    const functionCallEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'id-a', name: 'toolA', args: {}}},
          {functionCall: {id: 'id-b', name: 'toolB', args: {}}},
          {functionCall: {id: 'id-c', name: 'toolC', args: {}}},
        ],
      },
    });

    const iterator = handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent,
      toolsDict: {toolA, toolB, toolC},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const first = await iterator.next();
    const second = await iterator.next();
    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    const firstEvent = first.value as Event;
    const secondEvent = second.value as Event;
    expect(firstEvent.content!.parts![0].functionResponse!.name).toBe('toolA');
    expect(secondEvent.content!.parts![0].functionResponse!.name).toBe('toolB');

    const thirdPending = iterator.next();
    const earlyResolution = await Promise.race([
      thirdPending.then(() => 'resolved'),
      sleep(30).then(() => 'timeout'),
    ]);
    expect(earlyResolution).toBe('timeout');

    const third = await thirdPending;
    expect(third.done).toBe(false);
    const thirdEvent = third.value as Event;
    expect(thirdEvent.content!.parts![0].functionResponse!.name).toBe('toolC');
    expect((await iterator.next()).done).toBe(true);
  });

  it('handleFunctionCallsAsync with unlimited parallel has no early streaming', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };

    const toolA = makeDelayedTool('toolA', 80, 'A done');
    const toolB = makeDelayedTool('toolB', 10, 'B done');
    const toolC = makeDelayedTool('toolC', 10, 'C done');

    const functionCallEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'id-a', name: 'toolA', args: {}}},
          {functionCall: {id: 'id-b', name: 'toolB', args: {}}},
          {functionCall: {id: 'id-c', name: 'toolC', args: {}}},
        ],
      },
    });

    const iterator = handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent,
      toolsDict: {toolA, toolB, toolC},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const firstPending = iterator.next();
    const earlyResolution = await Promise.race([
      firstPending.then(() => 'resolved'),
      sleep(30).then(() => 'timeout'),
    ]);
    expect(earlyResolution).toBe('timeout');

    const first = await firstPending;
    const second = await iterator.next();
    const third = await iterator.next();

    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    expect(third.done).toBe(false);
    const firstEvent = first.value as Event;
    const secondEvent = second.value as Event;
    const thirdEvent = third.value as Event;
    expect(firstEvent.content!.parts![0].functionResponse!.name).toBe('toolA');
    expect(secondEvent.content!.parts![0].functionResponse!.name).toBe('toolB');
    expect(thirdEvent.content!.parts![0].functionResponse!.name).toBe('toolC');
    expect((await iterator.next()).done).toBe(true);
  });

  it('handleFunctionCallsAsync filters out null results from long-running tools', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };

    const longRunningTool = new FunctionTool({
      name: 'longTool',
      description: 'long running tool',
      parameters: z.object({}),
      isLongRunning: true,
      execute: async () => undefined,
    });
    const normalTool = makeDelayedTool('normalTool', 10, 'normal done');

    const functionCallEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'id-long', name: 'longTool', args: {}}},
          {functionCall: {id: 'id-normal', name: 'normalTool', args: {}}},
        ],
      },
    });

    const streamed: Event[] = [];
    for await (const event of handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent,
      toolsDict: {longTool: longRunningTool, normalTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    })) {
      streamed.push(event);
    }

    expect(streamed).toHaveLength(1);
    expect(streamed[0].content!.parts![0].functionResponse!.name).toBe(
      'normalTool',
    );
  });

  it('handleFunctionCallsAsync with maxConcurrentToolCalls=1 behaves like sequential streaming', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxConcurrentToolCalls: 1,
      maxLlmCalls: 500,
    };

    const toolA = makeDelayedTool('toolA', 60, 'A done');
    const toolB = makeDelayedTool('toolB', 60, 'B done');
    const toolC = makeDelayedTool('toolC', 60, 'C done');

    const functionCallEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'id-a', name: 'toolA', args: {}}},
          {functionCall: {id: 'id-b', name: 'toolB', args: {}}},
          {functionCall: {id: 'id-c', name: 'toolC', args: {}}},
        ],
      },
    });

    const iterator = handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent,
      toolsDict: {toolA, toolB, toolC},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(
      (first.value as Event).content!.parts![0].functionResponse!.name,
    ).toBe('toolA');

    const secondPending = iterator.next();
    const earlyResolution = await Promise.race([
      secondPending.then(() => 'resolved'),
      sleep(20).then(() => 'timeout'),
    ]);
    expect(earlyResolution).toBe('timeout');

    const second = await secondPending;
    const third = await iterator.next();
    expect(
      (second.value as Event).content!.parts![0].functionResponse!.name,
    ).toBe('toolB');
    expect(
      (third.value as Event).content!.parts![0].functionResponse!.name,
    ).toBe('toolC');
    expect((await iterator.next()).done).toBe(true);
  });

  it('handleFunctionCallsAsync: failed tool does not block streaming of other results', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };
    const goodTool = makeDelayedTool('goodTool', 10, 'good result');
    const badTool = makeFailingTool('badTool', 5);
    const functionCallEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'id-good', name: 'goodTool', args: {}}},
          {functionCall: {id: 'id-bad', name: 'badTool', args: {}}},
        ],
      },
    });

    const streamed: Event[] = [];
    for await (const event of handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent,
      toolsDict: {goodTool, badTool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    })) {
      streamed.push(event);
    }

    expect(streamed).toHaveLength(2);
    expect(streamed[0].content!.parts![0].functionResponse!.name).toBe(
      'goodTool',
    );
    expect(
      (
        streamed[1].content!.parts![0].functionResponse!.response as Record<
          string,
          string
        >
      ).error,
    ).toContain('badTool failed');
  });

  it('handleFunctionCallsAsync in parallel mode: all events yielded despite stateDelta key conflicts', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: true,
      maxLlmCalls: 500,
    };
    const toolA = new FunctionTool({
      name: 'toolA',
      description: 'sets counter to 1',
      parameters: z.object({}),
      execute: async (_args, context) => {
        context!.actions.stateDelta['counter'] = 1;
        return {result: 'A'};
      },
    });
    const toolB = new FunctionTool({
      name: 'toolB',
      description: 'sets counter to 2',
      parameters: z.object({}),
      execute: async (_args, context) => {
        context!.actions.stateDelta['counter'] = 2;
        return {result: 'B'};
      },
    });
    const functionCallEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'id-a', name: 'toolA', args: {}}},
          {functionCall: {id: 'id-b', name: 'toolB', args: {}}},
        ],
      },
    });

    const streamed: Event[] = [];
    for await (const event of handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent,
      toolsDict: {toolA, toolB},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    })) {
      streamed.push(event);
    }

    // Both events streamed despite the conflict; conflict is a warning not an error
    expect(streamed).toHaveLength(2);
    expect(streamed[0].content!.parts![0].functionResponse!.name).toBe('toolA');
    expect(streamed[1].content!.parts![0].functionResponse!.name).toBe('toolB');
  });

  it('handleFunctionCallsAsync in sequential mode yields each response individually', async () => {
    invocationContext.runConfig = {
      parallelToolExecution: false,
      maxLlmCalls: 500,
    };
    const toolA = makeDelayedTool('toolA', 60, 'A done');
    const toolB = makeDelayedTool('toolB', 60, 'B done');
    const functionCallEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'id-a', name: 'toolA', args: {}}},
          {functionCall: {id: 'id-b', name: 'toolB', args: {}}},
        ],
      },
    });

    const iterator = handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent,
      toolsDict: {toolA, toolB},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    // toolA resolves first; toolB has not started yet
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(
      (first.value as Event).content!.parts![0].functionResponse!.name,
    ).toBe('toolA');

    // toolB hasn't started yet so second should not resolve within 20ms
    const secondPending = iterator.next();
    const earlyResolution = await Promise.race([
      secondPending.then(() => 'resolved'),
      sleep(20).then(() => 'timeout'),
    ]);
    expect(earlyResolution).toBe('timeout');

    const second = await secondPending;
    expect(second.done).toBe(false);
    expect(
      (second.value as Event).content!.parts![0].functionResponse!.name,
    ).toBe('toolB');
    expect((await iterator.next()).done).toBe(true);
  });
});

describe('generateAuthEvent', () => {
  let invocationContext: InvocationContext;
  let pluginManager: PluginManager;

  beforeEach(() => {
    pluginManager = new PluginManager();
    const agent = new LlmAgent({name: 'test_agent', model: 'test_model'});
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent,
      pluginManager,
    });
  });

  it('should return undefined if no requestedAuthConfigs', () => {
    const functionResponseEvent = {
      actions: {},
      content: {role: 'model'},
    } as unknown as Event;

    const event = generateAuthEvent(invocationContext, functionResponseEvent);
    expect(event).toBeUndefined();
  });

  it('should return undefined if requestedAuthConfigs is empty', () => {
    const functionResponseEvent = {
      actions: {requestedAuthConfigs: {}},
      content: {role: 'model'},
    } as unknown as Event;

    const event = generateAuthEvent(invocationContext, functionResponseEvent);
    expect(event).toBeUndefined();
  });

  it('should return auth event if requestedAuthConfigs is present', () => {
    const functionResponseEvent = {
      actions: {
        requestedAuthConfigs: {
          'call_1': 'auth_config_1',
          'call_2': 'auth_config_2',
        },
      },
      content: {role: 'model'},
    } as unknown as Event;

    const event = generateAuthEvent(invocationContext, functionResponseEvent);
    expect(event).toBeDefined();
    expect(event!.invocationId).toBe('inv_123');
    expect(event!.author).toBe('test_agent');
    expect(event!.content!.parts!.length).toBe(2);

    const parts = event!.content!.parts!;
    const call1 = parts.find(
      (p) => p.functionCall?.args?.['function_call_id'] === 'call_1',
    );
    expect(call1).toBeDefined();
    expect(call1!.functionCall!.name).toBe('adk_request_credential');
    expect(call1!.functionCall!.args!['auth_config']).toBe('auth_config_1');

    const call2 = parts.find(
      (p) => p.functionCall?.args?.['function_call_id'] === 'call_2',
    );
    expect(call2).toBeDefined();
    expect(call2!.functionCall!.name).toBe('adk_request_credential');
    expect(call2!.functionCall!.args!['auth_config']).toBe('auth_config_2');
  });
});

describe('generateRequestConfirmationEvent', () => {
  let invocationContext: InvocationContext;
  let pluginManager: PluginManager;

  beforeEach(() => {
    pluginManager = new PluginManager();
    const agent = new LlmAgent({name: 'test_agent', model: 'test_model'});
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent,
      pluginManager,
    });
  });

  it('should return undefined if no requestedToolConfirmations', () => {
    const functionCallEvent = {content: {parts: []}} as unknown as Event;
    const functionResponseEvent = {
      actions: {},
      content: {role: 'model'},
    } as unknown as Event;

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });
    expect(event).toBeUndefined();
  });

  it('should return undefined if requestedToolConfirmations is empty', () => {
    const functionCallEvent = {content: {parts: []}} as unknown as Event;
    const functionResponseEvent = {
      actions: {requestedToolConfirmations: {}},
      content: {role: 'model'},
    } as unknown as Event;

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });
    expect(event).toBeUndefined();
  });

  it('should return confirmation event if requestedToolConfirmations is present', () => {
    const functionCallEvent = {
      content: {
        parts: [
          {
            functionCall: {
              name: 'tool_1',
              args: {arg: 'val1'},
              id: 'call_1',
            },
          },
          {
            functionCall: {
              name: 'tool_2',
              args: {arg: 'val2'},
              id: 'call_2',
            },
          },
        ],
      },
    } as unknown as Event;

    const functionResponseEvent = {
      actions: {
        requestedToolConfirmations: {
          'call_1': {message: 'confirm tool 1'},
          'call_2': {message: 'confirm tool 2'},
        },
      },
      content: {role: 'model'},
    } as unknown as Event;

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });

    expect(event).toBeDefined();
    expect(event!.invocationId).toBe('inv_123');
    expect(event!.author).toBe('test_agent');
    expect(event!.content!.parts!.length).toBe(2);

    const parts = event!.content!.parts!;
    const call1 = parts.find(
      (p) =>
        (p.functionCall?.args?.['originalFunctionCall'] as FunctionCall)?.id ===
        'call_1',
    );
    expect(call1).toBeDefined();
    expect(call1!.functionCall!.name).toBe('adk_request_confirmation');
    expect(call1!.functionCall!.args!['toolConfirmation']).toEqual({
      message: 'confirm tool 1',
    });

    const call2 = parts.find(
      (p) =>
        (p.functionCall?.args?.['originalFunctionCall'] as FunctionCall)?.id ===
        'call_2',
    );
    expect(call2).toBeDefined();
    expect(call2!.functionCall!.name).toBe('adk_request_confirmation');
    expect(call2!.functionCall!.args!['toolConfirmation']).toEqual({
      message: 'confirm tool 2',
    });
  });

  it('should skip confirmation if original function call is not found', () => {
    const functionCallEvent = {
      content: {
        parts: [
          {
            functionCall: {
              name: 'tool_1',
              args: {arg: 'val1'},
              id: 'call_1',
            },
          },
        ],
      },
    } as unknown as Event;

    const functionResponseEvent = {
      actions: {
        requestedToolConfirmations: {
          'call_1': {message: 'confirm tool 1'},
          'call_missing': {message: 'confirm tool missing'},
        },
      },
      content: {role: 'model'},
    } as unknown as Event;

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });

    expect(event).toBeDefined();
    expect(event!.content!.parts!.length).toBe(1);
    const parts = event!.content!.parts!;
    const call1 = parts.find(
      (p) =>
        (p.functionCall?.args?.['originalFunctionCall'] as FunctionCall)?.id ===
        'call_1',
    );
    expect(call1).toBeDefined();
  });
});
