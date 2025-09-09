/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, BasePlugin, BaseTool, CallbackContext, createEvent, Event, EventActions, InvocationContext, LlmRequest, LlmResponse, ToolContext} from '@google/adk';
import {Content} from '@google/genai';

class TestablePlugin extends BasePlugin {
  constructor(name = 'testable_plugin') {
    super(name);
  }
}

const MOCK_OVERRIDE_EVENT = createEvent({
  id: 'overridden_event_id',
  invocationId: 'overridden_event_invocation_id',
  timestamp: 123,
  actions: {
    stateDelta: {},
    artifactDelta: {},
    requestedAuthConfigs: {},
  },
  content: {parts: [{text: 'overridden_on_event'}]},
});

class FullOverridePlugin extends BasePlugin {
  constructor(name = 'full_override') {
    super(name);
  }

  override async onUserMessageCallback({
    invocationContext,
    userMessage,
  }: {invocationContext: InvocationContext; userMessage: Content;}):
      Promise<Content|undefined> {
    return {parts: [{text: 'overridden_on_user_message'}]};
  }

  override async beforeRunCallback({invocationContext}: {
    invocationContext: InvocationContext;
  }): Promise<Content|undefined> {
    return {parts: [{text: 'overridden_before_run'}]};
  }

  override async afterRunCallback({invocationContext}: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    return;
  }

  override async onEventCallback({invocationContext, event}: {
    invocationContext: InvocationContext; event: Event;
  }): Promise<Event|undefined> {
    return MOCK_OVERRIDE_EVENT;
  }

  override async beforeAgentCallback({agent, callbackContext}: {
    agent: BaseAgent; callbackContext: CallbackContext;
  }): Promise<Content|undefined> {
    return {parts: [{text: 'overridden_before_agent'}]};
  }

  override async afterAgentCallback({agent, callbackContext}: {
    agent: BaseAgent; callbackContext: CallbackContext;
  }): Promise<Content|undefined> {
    return {parts: [{text: 'overridden_after_agent'}]};
  }

  override async beforeToolCallback({tool, toolArgs, toolContext}: {
    tool: BaseTool; toolArgs: Record<string, unknown>; toolContext: ToolContext;
  }): Promise<Record<string, unknown>|undefined> {
    return {value: 'overridden_before_tool'};
  }

  override async afterToolCallback({tool, toolArgs, toolContext, result}: {
    tool: BaseTool; toolArgs: Record<string, unknown>; toolContext: ToolContext;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown>|undefined> {
    return {value: 'overridden_after_tool'};
  }

  override async onToolErrorCallback({tool, toolArgs, toolContext, error}: {
    tool: BaseTool; toolArgs: Record<string, unknown>; toolContext: ToolContext;
    error: Error;
  }): Promise<Record<string, unknown>|undefined> {
    return {value: 'overridden_on_tool_error'};
  }

  override async beforeModelCallback({callbackContext, llmRequest}: {
    callbackContext: CallbackContext; llmRequest: LlmRequest;
  }): Promise<LlmResponse|undefined> {
    return {
      content: {parts: [{text: 'overridden_before_model'}]},
    };
  }

  override async afterModelCallback({callbackContext, llmResponse}: {
    callbackContext: CallbackContext; llmResponse: LlmResponse;
  }): Promise<LlmResponse|undefined> {
    return {
      content: {parts: [{text: 'overridden_after_model'}]},
    };
  }

  override async onModelErrorCallback({callbackContext, llmRequest, error}: {
    callbackContext: CallbackContext; llmRequest: LlmRequest; error: Error;
  }): Promise<LlmResponse|undefined> {
    return {
      content: {parts: [{text: 'overridden_on_model_error'}]},
    };
  }
}

describe('BasePlugin', () => {
  const mockInvocationContext = {} as InvocationContext;
  const mockUserMessage = {} as Content;
  const mockCallbackContext = {} as CallbackContext;
  const mockAgent = {} as BaseAgent;
  const mockTool = {} as BaseTool;
  const mockToolContext = {} as ToolContext;
  const mockLlmRequest = {} as LlmRequest;
  const mockLlmResponse = {} as LlmResponse;
  const mockEvent = {} as Event;
  const mockError = new Error('mock error');

  it('should initialize with the correct name', () => {
    const pluginName = 'my_test_plugin';
    const plugin = new TestablePlugin(pluginName);
    expect(plugin.name).toEqual(pluginName);
  });

  it('default callbacks should return undefined', async () => {
    const plugin = new TestablePlugin('default_plugin');

    expect(
        await plugin.onUserMessageCallback({
          userMessage: mockUserMessage,
          invocationContext: mockInvocationContext,
        }),
        )
        .toBeUndefined();
    expect(
        await plugin.beforeRunCallback(
            {invocationContext: mockInvocationContext}),
        )
        .toBeUndefined();
    expect(
        await plugin.afterRunCallback(
            {invocationContext: mockInvocationContext}),
        )
        .toBeUndefined();
    expect(
        await plugin.onEventCallback({
          invocationContext: mockInvocationContext,
          event: mockEvent,
        }),
        )
        .toBeUndefined();
    expect(
        await plugin.beforeAgentCallback({
          agent: mockAgent,
          callbackContext: mockCallbackContext,
        }),
        )
        .toBeUndefined();
    expect(
        await plugin.afterAgentCallback({
          agent: mockAgent,
          callbackContext: mockCallbackContext,
        }),
        )
        .toBeUndefined();
    expect(
        await plugin.beforeToolCallback({
          tool: mockTool,
          toolArgs: {},
          toolContext: mockToolContext,
        }),
        )
        .toBeUndefined();
    expect(
        await plugin.afterToolCallback({
          tool: mockTool,
          toolArgs: {},
          toolContext: mockToolContext,
          result: {},
        }),
        )
        .toBeUndefined();
    expect(
        await plugin.onToolErrorCallback({
          tool: mockTool,
          toolArgs: {},
          toolContext: mockToolContext,
          error: mockError,
        }),
        )
        .toBeUndefined();
    expect(
        await plugin.beforeModelCallback({
          callbackContext: mockCallbackContext,
          llmRequest: mockLlmRequest,
        }),
        )
        .toBeUndefined();
    expect(
        await plugin.afterModelCallback({
          callbackContext: mockCallbackContext,
          llmResponse: mockLlmResponse,
        }),
        )
        .toBeUndefined();
    expect(
        await plugin.onModelErrorCallback({
          callbackContext: mockCallbackContext,
          llmRequest: mockLlmRequest,
          error: mockError,
        }),
        )
        .toBeUndefined();
  });

  it('all callbacks can be overridden', async () => {
    const plugin = new FullOverridePlugin();

    expect(
        await plugin.onUserMessageCallback({
          userMessage: mockUserMessage,
          invocationContext: mockInvocationContext,
        }),
        )
        .toEqual({parts: [{text: 'overridden_on_user_message'}]});
    expect(
        await plugin.beforeRunCallback(
            {invocationContext: mockInvocationContext}),
        )
        .toEqual({parts: [{text: 'overridden_before_run'}]});
    expect(
        await plugin.afterRunCallback(
            {invocationContext: mockInvocationContext}),
        )
        .toBeUndefined();
    expect(
        await plugin.onEventCallback({
          invocationContext: mockInvocationContext,
          event: mockEvent,
        }),
        )
        .toEqual(MOCK_OVERRIDE_EVENT);
    expect(
        await plugin.beforeAgentCallback({
          agent: mockAgent,
          callbackContext: mockCallbackContext,
        }),
        )
        .toEqual({parts: [{text: 'overridden_before_agent'}]});
    expect(
        await plugin.afterAgentCallback({
          agent: mockAgent,
          callbackContext: mockCallbackContext,
        }),
        )
        .toEqual({parts: [{text: 'overridden_after_agent'}]});
    expect(
        await plugin.beforeModelCallback({
          callbackContext: mockCallbackContext,
          llmRequest: mockLlmRequest,
        }),
        )
        .toEqual(
            {
              content: {parts: [{text: 'overridden_before_model'}]},
            },
        );
    expect(
        await plugin.afterModelCallback({
          callbackContext: mockCallbackContext,
          llmResponse: mockLlmResponse,
        }),
        )
        .toEqual(
            {
              content: {parts: [{text: 'overridden_after_model'}]},
            },
        );
    expect(
        await plugin.beforeToolCallback({
          tool: mockTool,
          toolArgs: {},
          toolContext: mockToolContext,
        }),
        )
        .toEqual({value: 'overridden_before_tool'});
    expect(
        await plugin.afterToolCallback({
          tool: mockTool,
          toolArgs: {},
          toolContext: mockToolContext,
          result: {},
        }),
        )
        .toEqual({value: 'overridden_after_tool'});
    expect(
        await plugin.onToolErrorCallback({
          tool: mockTool,
          toolArgs: {},
          toolContext: mockToolContext,
          error: mockError,
        }),
        )
        .toEqual({value: 'overridden_on_tool_error'});
    expect(
        await plugin.onModelErrorCallback({
          callbackContext: mockCallbackContext,
          llmRequest: mockLlmRequest,
          error: mockError,
        }),
        )
        .toEqual(
            {
              content: {parts: [{text: 'overridden_on_model_error'}]},
            },
        );
  });
});
