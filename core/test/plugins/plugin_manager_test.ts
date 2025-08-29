/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {BaseAgent} from '../../src/agents/base_agent.js';
import {CallbackContext} from '../../src/agents/callback_context.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {BasePlugin} from '../../src/plugins/base_plugin.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {BaseTool} from '../../src/tools/base_tool.js';
import {ToolContext} from '../../src/tools/tool_context.js';

type PluginCallbackName = keyof BasePlugin;

class TestPlugin extends BasePlugin {
  callLog: PluginCallbackName[] = [];
  returnValues: Partial<Record<PluginCallbackName, unknown>> = {};
  exceptionsToRaise: Partial<Record<PluginCallbackName, Error>> = {};

  constructor(name: string) {
    super(name);
  }

  private async handleCallback(
      name: PluginCallbackName,
      ): Promise<unknown|undefined> {
    this.callLog.push(name);
    if (this.exceptionsToRaise[name]) {
      throw this.exceptionsToRaise[name];
    }
    return this.returnValues[name];
  }

  override async onUserMessageCallback(kwargs: {
    invocationContext: InvocationContext; userMessage: Content;
  }): Promise<Content|undefined> {
    return (await this.handleCallback('onUserMessageCallback')) as | Content |
        undefined;
  }

  override async beforeRunCallback(kwargs: {
    invocationContext: InvocationContext;
  }): Promise<Content|undefined> {
    return (await this.handleCallback('beforeRunCallback')) as | Content |
        undefined;
  }

  override async afterRunCallback(kwargs: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    await this.handleCallback('afterRunCallback');
  }

  override async onEventCallback(kwargs: {
    invocationContext: InvocationContext; event: Event;
  }): Promise<Event|undefined> {
    return (await this.handleCallback('onEventCallback')) as Event | undefined;
  }

  override async beforeAgentCallback(kwargs: {
    agent: BaseAgent; callbackContext: CallbackContext;
  }): Promise<Content|undefined> {
    return (await this.handleCallback('beforeAgentCallback')) as | Content |
        undefined;
  }

  override async afterAgentCallback(kwargs: {
    agent: BaseAgent; callbackContext: CallbackContext;
  }): Promise<Content|undefined> {
    return (await this.handleCallback('afterAgentCallback')) as | Content |
        undefined;
  }

  override async beforeToolCallback(kwargs: {
    tool: BaseTool; toolArgs: Record<string, unknown>; toolContext: ToolContext;
  }): Promise<Record<string, unknown>|undefined> {
    return (await this.handleCallback('beforeToolCallback')) as |
        Record<string, unknown>| undefined;
  }

  override async afterToolCallback(kwargs: {
    tool: BaseTool; toolArgs: Record<string, unknown>; toolContext: ToolContext;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown>|undefined> {
    return (await this.handleCallback('afterToolCallback')) as |
        Record<string, unknown>| undefined;
  }

  override async onToolErrorCallback(kwargs: {
    tool: BaseTool; toolArgs: Record<string, unknown>; toolContext: ToolContext;
    error: Error;
  }): Promise<Record<string, unknown>|undefined> {
    return (await this.handleCallback('onToolErrorCallback')) as |
        Record<string, unknown>| undefined;
  }

  override async beforeModelCallback(kwargs: {
    callbackContext: CallbackContext; llmRequest: LlmRequest;
  }): Promise<LlmResponse|undefined> {
    return (await this.handleCallback('beforeModelCallback')) as | LlmResponse |
        undefined;
  }

  override async afterModelCallback(kwargs: {
    callbackContext: CallbackContext; llmResponse: LlmResponse;
  }): Promise<LlmResponse|undefined> {
    return (await this.handleCallback('afterModelCallback')) as | LlmResponse |
        undefined;
  }

  override async onModelErrorCallback(kwargs: {
    callbackContext: CallbackContext; llmRequest: LlmRequest; error: Error;
  }): Promise<LlmResponse|undefined> {
    return (await this.handleCallback('onModelErrorCallback')) as |
        LlmResponse | undefined;
  }
}

describe('PluginManager', () => {
  let service: PluginManager;
  let plugin1: TestPlugin;
  let plugin2: TestPlugin;
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

  beforeEach(() => {
    service = new PluginManager();
    plugin1 = new TestPlugin('plugin1');
    plugin2 = new TestPlugin('plugin2');
  });

  it('should register and get a plugin', () => {
    service.registerPlugin(plugin1);
    expect(service.getPlugin('plugin1')).toBe(plugin1);
  });

  it('should throw an error when registering a duplicate plugin object', () => {
    service.registerPlugin(plugin1);
    expect(() => service.registerPlugin(plugin1))
        .toThrowError(
            /Plugin 'plugin1' already registered/,
        );
  });

  it('should throw an error when registering a duplicate plugin name', () => {
    service.registerPlugin(plugin1);
    const plugin1Duplicate = new TestPlugin('plugin1');
    expect(() => service.registerPlugin(plugin1Duplicate))
        .toThrowError(
            /Plugin with name 'plugin1' already registered/,
        );
  });

  it('should stop subsequent plugins if early exit occurs', async () => {
    const mockResponse = {} as Content;
    plugin1.returnValues['beforeRunCallback'] = mockResponse;
    service.registerPlugin(plugin1);
    service.registerPlugin(plugin2);

    const result = await service.runBeforeRunCallback({
      invocationContext: mockInvocationContext,
    });

    expect(result).toBe(mockResponse);
    expect(plugin1.callLog).toContain('beforeRunCallback');
    expect(plugin2.callLog).not.toContain('beforeRunCallback');
  });

  it('should call all plugins if no plugin returns a value', async () => {
    service.registerPlugin(plugin1);
    service.registerPlugin(plugin2);

    const result = await service.runBeforeRunCallback({
      invocationContext: mockInvocationContext,
    });

    expect(result).toBeUndefined();
    expect(plugin1.callLog).toContain('beforeRunCallback');
    expect(plugin2.callLog).toContain('beforeRunCallback');
  });

  it('should wrap plugin exception in a runtime error', async () => {
    const originalException =
        new Error('Something went wrong inside the plugin!');
    plugin1.exceptionsToRaise['beforeRunCallback'] = originalException;
    service.registerPlugin(plugin1);

    try {
        await service.runBeforeRunCallback({
          invocationContext: mockInvocationContext,
        });
    } catch (e) {
      expect((e as Error).message).toContain('Error in plugin \'plugin1\' during \'beforeRunCallback\' callback');
    }
  });

  it('should support all callbacks', async () => {
    service.registerPlugin(plugin1);

    await service.runOnUserMessageCallback({
      userMessage: mockUserMessage,
      invocationContext: mockInvocationContext,
    });
    await service.runBeforeRunCallback(
        {invocationContext: mockInvocationContext});
    await service.runAfterRunCallback(
        {invocationContext: mockInvocationContext});
    await service.runOnEventCallback({
      invocationContext: mockInvocationContext,
      event: mockEvent,
    });
    await service.runBeforeAgentCallback({
      agent: mockAgent,
      callbackContext: mockCallbackContext,
    });
    await service.runAfterAgentCallback({
      agent: mockAgent,
      callbackContext: mockCallbackContext,
    });
    await service.runBeforeToolCallback({
      tool: mockTool,
      toolArgs: {},
      toolContext: mockToolContext,
    });
    await service.runAfterToolCallback({
      tool: mockTool,
      toolArgs: {},
      toolContext: mockToolContext,
      result: {},
    });
    await service.runOnToolErrorCallback({
      tool: mockTool,
      toolArgs: {},
      toolContext: mockToolContext,
      error: mockError,
    });
    await service.runBeforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest: mockLlmRequest,
    });
    await service.runAfterModelCallback({
      callbackContext: mockCallbackContext,
      llmResponse: mockLlmResponse,
    });
    await service.runOnModelErrorCallback({
      callbackContext: mockCallbackContext,
      llmRequest: mockLlmRequest,
      error: mockError,
    });

    const expectedCallbacks: PluginCallbackName[] = [
      'onUserMessageCallback',
      'beforeRunCallback',
      'afterRunCallback',
      'onEventCallback',
      'beforeAgentCallback',
      'afterAgentCallback',
      'beforeToolCallback',
      'afterToolCallback',
      'onToolErrorCallback',
      'beforeModelCallback',
      'afterModelCallback',
      'onModelErrorCallback',
    ];
    expect(plugin1.callLog.sort()).toEqual(expectedCallbacks.sort());
  });
});
