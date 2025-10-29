/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {BasePlugin, BaseTool, Event, functionsExportedForTestingOnly, FunctionTool, InvocationContext, LlmAgent, PluginManager, Session, SingleAfterToolCallback, SingleBeforeToolCallback, ToolContext,} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {z} from 'zod';

// Get the test target function
const {handleFunctionCallList} = functionsExportedForTestingOnly;

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
      ...args: Parameters<BasePlugin['beforeToolCallback']>):
      Promise<Record<string, unknown>|undefined> {
    if (this.beforeToolCallbackResponse) {
      return this.beforeToolCallbackResponse;
    }
    return undefined;
  }

  override async afterToolCallback(
      ...args: Parameters<BasePlugin['afterToolCallback']>):
      Promise<Record<string, unknown>|undefined> {
    if (this.afterToolCallbackResponse) {
      return this.afterToolCallbackResponse;
    }
    return undefined;
  }

  override async onToolErrorCallback(
      ...args: Parameters<BasePlugin['onToolErrorCallback']>):
      Promise<Record<string, unknown>|undefined> {
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
    let definedEvent = event as Event;
    expect((definedEvent.content!.parts![0]).functionResponse!.response)
        .toEqual({
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
    let definedEvent = event as Event;
    expect((definedEvent.content!.parts![0]).functionResponse!.response)
        .toEqual({
          result: 'beforeToolCallback executed',
        });
  });

  it('should execute second beforeToolCallback if first returns undefined',
     async () => {
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
       let definedEvent = event as Event;
       expect((definedEvent.content!.parts![0]).functionResponse!.response)
           .toEqual({
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
    let definedEvent = event as Event;
    expect((definedEvent.content!.parts![0]).functionResponse!.response)
        .toEqual({
          result: 'afterToolCallback executed',
        });
  });

  it('should execute second afterToolCallback if first returns undefined',
     async () => {
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
       let definedEvent = event as Event;
       expect((definedEvent.content!.parts![0]).functionResponse!.response)
           .toEqual({
             result: 'afterToolCallback2 executed',
           });
     });

  it('should execute plugin beforeToolCallback and return its result',
     async () => {
       const plugin = new TestPlugin('testPlugin');
       plugin.beforeToolCallbackResponse = {
         result: 'plugin beforeToolCallback executed'
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
       let definedEvent = event as Event;
       expect((definedEvent.content!.parts![0]).functionResponse!.response)
           .toEqual({
             result: 'plugin beforeToolCallback executed',
           });
     });

  it('should execute plugin afterToolCallback and return its result',
     async () => {
       const plugin = new TestPlugin('testPlugin');
       plugin.afterToolCallbackResponse = {
         result: 'plugin afterToolCallback executed'
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
       let definedEvent = event as Event;
       expect((definedEvent.content!.parts![0]).functionResponse!.response)
           .toEqual({
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
    expect((definedEvent.content!.parts![0]).functionResponse!.response)
        .toEqual({
          result: 'onToolErrorCallback executed',
        });
  });

  it('should return error message when error is thrown during tool execution, when no plugin onToolErrorCallback is provided',
     async () => {
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
         error: 'Error in tool \'errorTool\': tool error message content',
       });
     });
});
