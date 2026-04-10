/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlugin,
  BaseTool,
  Context,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  ReadonlyContext,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {handleFunctionCallsAsync} from '../../../src/agents/functions.js';
import {TOOL_FILTER_REQUEST_PROCESSOR} from '../../../src/agents/processors/tool_filter_request_processor.js';
import {createEvent} from '../../../src/events/event.js';

class MockTool extends BaseTool {
  constructor(name: string) {
    super({name, description: 'Mock tool'});
  }
  async runAsync() {
    return {};
  }
}

class MockPlugin extends BasePlugin {
  filteredTools: Record<string, BaseTool> | undefined;

  constructor(filteredTools?: Record<string, BaseTool>) {
    super('mock_plugin');
    this.filteredTools = filteredTools;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async beforeToolSelection(params: {
    callbackContext: Context;
    tools: Readonly<Record<string, BaseTool>>;
  }) {
    return this.filteredTools;
  }
}

function createMockInvocationContext(
  agent: BaseAgent,
  plugins: BasePlugin[] = [],
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager(plugins),
  });
}

describe('ToolFilterRequestProcessor', () => {
  it('should do nothing if agent is not LlmAgent', async () => {
    class NonLlmAgent extends BaseAgent {
      protected async *runAsyncImpl() {}
      protected async *runLiveImpl() {}
    }
    const agent = new NonLlmAgent({name: 'non_llm'});
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of TOOL_FILTER_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.allowedTools).toBeUndefined();
  });

  it('should do nothing if agent has no tools', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of TOOL_FILTER_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.allowedTools).toBeUndefined();
  });

  it('should populate allowedTools if plugins return filtered tools', async () => {
    const tool1 = new MockTool('tool1');
    const tool2 = new MockTool('tool2');
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      tools: [tool1, tool2],
    });

    const mockPlugin = new MockPlugin({'tool1': tool1});
    const invocationContext = createMockInvocationContext(agent, [mockPlugin]);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of TOOL_FILTER_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.allowedTools).toBeDefined();
    expect(llmRequest.allowedTools?.includes('tool1')).toBe(true);
    expect(llmRequest.allowedTools?.includes('tool2')).toBe(false);
  });

  it('should not populate allowedTools if plugins return undefined', async () => {
    const tool1 = new MockTool('tool1');
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      tools: [tool1],
    });

    const mockPlugin = new MockPlugin(undefined);
    const invocationContext = createMockInvocationContext(agent, [mockPlugin]);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of TOOL_FILTER_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.allowedTools).toBeUndefined();
  });

  it('should fail if model tries to call a filtered tool', async () => {
    const tool1 = new MockTool('tool1');
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      tools: [tool1],
    });

    const mockPlugin = new MockPlugin({});
    const invocationContext = createMockInvocationContext(agent, [mockPlugin]);

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of TOOL_FILTER_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    const toolContext = new Context({invocationContext});
    const tools = await agent.canonicalTools(
      new ReadonlyContext(invocationContext),
    );
    for (const tool of tools) {
      if (
        llmRequest.allowedTools &&
        !llmRequest.allowedTools.includes(tool.name)
      ) {
        continue;
      }
      await tool.processLlmRequest({toolContext, llmRequest});
    }

    const functionCallEvent = createEvent({
      invocationId: 'test-invocation',
      author: 'test_agent',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'tool1', id: '1'}}],
      },
    });

    await expect(
      handleFunctionCallsAsync({
        invocationContext,
        functionCallEvent,
        toolsDict: llmRequest.toolsDict,
        beforeToolCallbacks: [],
        afterToolCallbacks: [],
      }),
    ).rejects.toThrow('Function tool1 is not found in the toolsDict.');
  });
});
