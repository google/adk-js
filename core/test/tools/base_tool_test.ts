/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  InMemorySessionService,
  InvocationContext,
  LlmRequest,
  PluginManager,
  SequentialAgent,
} from '@google/adk';
import {FunctionDeclaration, Tool, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

class TestingTool extends BaseTool {
  private readonly declaration?: FunctionDeclaration;

  constructor(declaration?: FunctionDeclaration) {
    super({name: 'test_tool', description: 'test_description'});
    this.declaration = declaration;
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.declaration;
  }

  override async runAsync(): Promise<unknown> {
    return undefined;
  }
}

async function createToolContext(): Promise<Context> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'test_app',
    userId: 'test_user',
  });
  const agent = new SequentialAgent({name: 'test_agent'});
  const invocationContext = new InvocationContext({
    invocationId: 'invocation_id',
    agent,
    session,
    sessionService,
    pluginManager: new PluginManager(),
  });
  return new Context({invocationContext});
}

describe('BaseTool.processLlmRequest', () => {
  it('leaves the request config unset when the tool has no declaration', async () => {
    const tool = new TestingTool();
    const toolContext = await createToolContext();
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config).toBeUndefined();
  });

  it('adds the tool declaration to the request config', async () => {
    const declaration: FunctionDeclaration = {
      name: 'test_tool',
      description: 'test_description',
      parameters: {
        type: Type.STRING,
        title: 'param_1',
      },
    };
    const tool = new TestingTool(declaration);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const toolContext = await createToolContext();

    await tool.processLlmRequest({toolContext, llmRequest});

    const firstTool = llmRequest.config?.tools?.[0] as Tool | undefined;
    expect(firstTool?.functionDeclarations).toEqual([declaration]);
  });

  it('appends a new function declarations entry after an existing built-in tool', async () => {
    const declaration: FunctionDeclaration = {
      name: 'test_tool',
      description: 'test_description',
      parameters: {
        type: Type.STRING,
        title: 'param_1',
      },
    };
    const tool = new TestingTool(declaration);
    const llmRequest: LlmRequest = {
      contents: [],
      config: {
        tools: [{googleSearch: {}}],
      },
      toolsDict: {},
      liveConnectConfig: {},
    };
    const toolContext = await createToolContext();

    await tool.processLlmRequest({toolContext, llmRequest});

    const secondTool = llmRequest.config?.tools?.[1] as Tool | undefined;
    expect(secondTool?.functionDeclarations).toEqual([declaration]);
  });

  it('adds the declaration to the existing function declarations entry next to a built-in tool', async () => {
    const declaration: FunctionDeclaration = {
      name: 'test_tool',
      description: 'test_description',
      parameters: {
        type: Type.STRING,
        title: 'param_1',
      },
    };
    const existingDeclaration: FunctionDeclaration = {
      name: 'existing_tool',
    };
    const tool = new TestingTool(declaration);
    const llmRequest: LlmRequest = {
      contents: [],
      config: {
        tools: [
          {googleSearch: {}},
          {functionDeclarations: [existingDeclaration]},
        ],
      },
      toolsDict: {},
      liveConnectConfig: {},
    };
    const toolContext = await createToolContext();

    await tool.processLlmRequest({toolContext, llmRequest});

    const secondTool = llmRequest.config?.tools?.[1] as Tool | undefined;
    expect(secondTool?.functionDeclarations?.[1]).toEqual(declaration);
  });
});
