/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  BasePlugin,
  BaseTool,
  createEvent,
  createEventActions,
  Event,
  functionsExportedForTestingOnly,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Session,
  SingleAfterToolCallback,
  SingleBeforeToolCallback,
  ToolConfirmation,
} from '@google/adk';
import {Content, FunctionCall} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  generateClientFunctionCallId,
  getLongRunningFunctionCalls,
  mergeParallelFunctionResponseEvents,
  populateClientFunctionCallId,
  removeClientFunctionCallId,
} from '../../src/agents/functions.js';

// Get the test target function
const {
  handleFunctionCallList,
  generateAuthEvent,
  generateRequestConfirmationEvent,
} = functionsExportedForTestingOnly;

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
    const functionResponseEvent = createEvent({
      content: {role: 'model', parts: []},
    });

    const event = generateAuthEvent(invocationContext, functionResponseEvent);
    expect(event).toBeUndefined();
  });

  it('should return undefined if requestedAuthConfigs is empty', () => {
    const functionResponseEvent = createEvent({
      content: {role: 'model', parts: []},
    });

    const event = generateAuthEvent(invocationContext, functionResponseEvent);
    expect(event).toBeUndefined();
  });

  it('should return auth event if requestedAuthConfigs is present', () => {
    const functionResponseEvent = createEvent({
      actions: createEventActions({
        requestedAuthConfigs: {
          'call_1': 'auth_config_1',
          'call_2': 'auth_config_2',
        },
      }),
      content: {role: 'model', parts: []},
    });

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
    const functionCallEvent = createEvent({content: {role: 'user', parts: []}});
    const functionResponseEvent = createEvent({
      content: {role: 'model', parts: []},
    });

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });
    expect(event).toBeUndefined();
  });

  it('should return undefined if requestedToolConfirmations is empty', () => {
    const functionCallEvent = createEvent({content: {role: 'user', parts: []}});
    const functionResponseEvent = createEvent({
      actions: createEventActions({requestedToolConfirmations: {}}),
      content: {role: 'model', parts: []},
    });

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });
    expect(event).toBeUndefined();
  });

  it('should return confirmation event if requestedToolConfirmations is present', () => {
    const functionCallEvent = createEvent({
      content: {
        role: 'user',
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
    });

    const functionResponseEvent = createEvent({
      actions: createEventActions({
        requestedToolConfirmations: {
          'call_1': new ToolConfirmation({
            hint: 'confirm tool 1',
            confirmed: false,
          }),
          'call_2': new ToolConfirmation({
            hint: 'confirm tool 2',
            confirmed: false,
          }),
        },
      }),
      content: {role: 'model', parts: []},
    });

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
    expect(call1!.functionCall!.args!['toolConfirmation']).toEqual(
      new ToolConfirmation({
        hint: 'confirm tool 1',
        confirmed: false,
      }),
    );

    const call2 = parts.find(
      (p) =>
        (p.functionCall?.args?.['originalFunctionCall'] as FunctionCall)?.id ===
        'call_2',
    );
    expect(call2).toBeDefined();
    expect(call2!.functionCall!.name).toBe('adk_request_confirmation');
    expect(call2!.functionCall!.args!['toolConfirmation']).toEqual(
      new ToolConfirmation({
        hint: 'confirm tool 2',
        confirmed: false,
      }),
    );
  });

  it('should skip confirmation if original function call is not found', () => {
    const functionCallEvent = createEvent({
      content: {
        role: 'user',
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
    });

    const functionResponseEvent = createEvent({
      actions: createEventActions({
        requestedToolConfirmations: {
          'call_1': new ToolConfirmation({
            hint: 'confirm tool 1',
            confirmed: false,
          }),
          'call_missing': new ToolConfirmation({
            hint: 'confirm tool missing',
            confirmed: false,
          }),
        },
      }),
      content: {role: 'model', parts: []},
    });

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

describe('generateClientFunctionCallId', () => {
  it('should generate a valid ID with prefix', () => {
    const id = generateClientFunctionCallId();
    expect(id).toMatch(/^adk-/);
  });
});

describe('populateClientFunctionCallId', () => {
  it('should populate ID if missing', () => {
    const event = createEvent({
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'testTool', args: {}}}],
      },
    });
    populateClientFunctionCallId(event);
    expect(event.content!.parts![0].functionCall!.id).toBeDefined();
    expect(event.content!.parts![0].functionCall!.id).toMatch(/^adk-/);
  });

  it('should not overwrite existing ID', () => {
    const event = createEvent({
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: 'testTool', args: {}, id: 'existing-id'}},
        ],
      },
    });
    populateClientFunctionCallId(event);
    expect(event.content!.parts![0].functionCall!.id).toBe('existing-id');
  });

  it('should handle event with no function calls', () => {
    const event = createEvent({
      content: {
        role: 'model',
        parts: [{text: 'hello'}],
      },
    });
    populateClientFunctionCallId(event);
    expect(event.content!.parts![0].text).toBe('hello');
  });
});

describe('removeClientFunctionCallId', () => {
  it('should remove client generated ID from functionCall', () => {
    const content: Content = {
      role: 'model',
      parts: [{functionCall: {name: 'testTool', args: {}, id: 'adk-test-id'}}],
    };
    removeClientFunctionCallId(content);
    expect(content.parts![0].functionCall!.id).toBeUndefined();
  });

  it('should remove client generated ID from functionResponse', () => {
    const content: Content = {
      role: 'user',
      parts: [
        {functionResponse: {name: 'testTool', response: {}, id: 'adk-test-id'}},
      ],
    };
    removeClientFunctionCallId(content);
    expect(content.parts![0].functionResponse!.id).toBeUndefined();
  });

  it('should not remove non-client generated ID', () => {
    const content: Content = {
      role: 'model',
      parts: [{functionCall: {name: 'testTool', args: {}, id: 'server-id'}}],
    };
    removeClientFunctionCallId(content);
    expect(content.parts![0].functionCall!.id).toBe('server-id');
  });
});

describe('getLongRunningFunctionCalls', () => {
  it('should return IDs of long running function calls', () => {
    const functionCalls = [
      {name: 'longTool', id: 'call-1'},
      {name: 'shortTool', id: 'call-2'},
    ];
    const toolsDict: Record<string, BaseTool> = {
      'longTool': new FunctionTool({
        name: 'longTool',
        description: 'long',
        execute: async () => ({}),
        isLongRunning: true,
      }),
      'shortTool': new FunctionTool({
        name: 'shortTool',
        description: 'short',
        execute: async () => ({}),
        isLongRunning: false,
      }),
    };
    // @ts-expect-error ts will argue about toolsDict because getLongRunningFunctionCalls is improted from the source and BaseTool is imported from '@google/adk'.
    const result = getLongRunningFunctionCalls(functionCalls, toolsDict);
    expect(result.has('call-1')).toBe(true);
    expect(result.has('call-2')).toBe(false);
  });
});

describe('mergeParallelFunctionResponseEvents', () => {
  it('should merge multiple events into one', () => {
    const event1 = createEvent({
      invocationId: 'inv-1',
      author: 'agent-1',
      content: {
        role: 'user',
        parts: [
          {functionResponse: {name: 'tool1', response: {result: 1}, id: 'id1'}},
        ],
      },
    });
    const event2 = createEvent({
      invocationId: 'inv-1',
      author: 'agent-1',
      content: {
        role: 'user',
        parts: [
          {functionResponse: {name: 'tool2', response: {result: 2}, id: 'id2'}},
        ],
      },
    });
    const merged = mergeParallelFunctionResponseEvents([event1, event2]);
    expect(merged.content!.parts!.length).toBe(2);
    expect(merged.content!.parts![0].functionResponse!.name).toBe('tool1');
    expect(merged.content!.parts![1].functionResponse!.name).toBe('tool2');
  });

  it('should throw if no events provided', () => {
    expect(() => mergeParallelFunctionResponseEvents([])).toThrow(
      'No function response events provided.',
    );
  });

  it('should return the same event if only one provided', () => {
    const event = createEvent();
    const merged = mergeParallelFunctionResponseEvents([event]);
    expect(merged).toBe(event);
  });
});
