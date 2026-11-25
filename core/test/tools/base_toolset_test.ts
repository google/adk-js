/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActiveStreamingTool,
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  BaseToolset,
  BaseToolsetOptions,
  type CallLiveToolRequest,
  Context,
  createEvent,
  createSession,
  FunctionTool,
  handleFunctionCallsLive,
  InMemorySessionService,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  ReadonlyContext,
  ToolPredicate,
} from '@google/adk';
import {describe, expect, expectTypeOf, it} from 'vitest';
import {z} from 'zod/v4';

class DummyTool extends BaseTool {
  constructor(name: string) {
    super({name, description: 'Dummy tool'});
  }
  _getDeclaration() {
    return {name: this.name, description: this.description};
  }

  async runAsync(): Promise<unknown> {
    return 'dummy';
  }
}

class DummyToolset extends BaseToolset {
  constructor(prefix?: string) {
    super([], prefix);
  }

  async getTools(): Promise<BaseTool[]> {
    const rawTools = [new DummyTool('tool1'), new DummyTool('tool2')];
    return rawTools.map((tool) => {
      return new DummyTool(
        this.prefix ? `${this.prefix}_${tool.name}` : tool.name,
      );
    });
  }

  async close(): Promise<void> {}
}

class FilteringToolset extends BaseToolset {
  constructor(toolFilter?: ToolPredicate | string[]) {
    super(toolFilter);
  }

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const rawTools = [new DummyTool('tool1'), new DummyTool('tool2')];
    return rawTools.filter((tool) => this.isToolSelected(tool, context));
  }

  async close(): Promise<void> {}
}

describe('BaseToolset.isToolSelected', () => {
  const context = {} as unknown as ReadonlyContext;

  it('selects all tools when super() is called with no arguments', async () => {
    const toolset = new FilteringToolset();
    expect(toolset.toolFilter).toEqual([]);
    const tools = await toolset.getTools(context);
    expect(tools.map((tool) => tool.name)).toEqual(['tool1', 'tool2']);
  });

  it('selects all tools when the toolFilter is an empty array', async () => {
    const toolset = new FilteringToolset([]);
    const tools = await toolset.getTools(context);
    expect(tools.map((tool) => tool.name)).toEqual(['tool1', 'tool2']);
  });

  it('selects only the named tools for a non-empty string[] filter', async () => {
    const toolset = new FilteringToolset(['tool2']);
    const tools = await toolset.getTools(context);
    expect(tools.map((tool) => tool.name)).toEqual(['tool2']);
  });

  it('applies a ToolPredicate filter', async () => {
    const toolset = new FilteringToolset((tool) => tool.name === 'tool1');
    const tools = await toolset.getTools(context);
    expect(tools.map((tool) => tool.name)).toEqual(['tool1']);
  });

  it('applies a ToolPredicate filter when called without context', async () => {
    const toolset = new FilteringToolset((tool) => tool.name === 'tool1');
    const tools = await toolset.getTools();
    expect(tools.map((tool) => tool.name)).toEqual(['tool1']);
  });
});

describe('ToolPredicate type compatibility', () => {
  it('accepts one-parameter and two-parameter predicates and callable with or without context', () => {
    const dummy = new DummyTool('tool1');
    const context = {} as unknown as ReadonlyContext;

    const pOne: ToolPredicate = (tool: BaseTool) => tool.name === 'tool1';
    const pTwo: ToolPredicate = (
      tool: BaseTool,
      readonlyContext: ReadonlyContext,
    ) => tool.name === 'tool1' && readonlyContext !== undefined;
    const pOpt: ToolPredicate = (
      tool: BaseTool,
      readonlyContext?: ReadonlyContext,
    ) => tool.name === 'tool1' && readonlyContext !== undefined;

    expect(pOne(dummy)).toBe(true);
    expect(pTwo(dummy, context)).toBe(true);
    expect(pOpt(dummy, context)).toBe(true);

    expect(pOne(dummy)).toBe(true);
    expect(pTwo(dummy)).toBe(false);
    expect(pOpt(dummy)).toBe(false);

    expect(pOne(dummy, undefined)).toBe(true);
    expect(pTwo(dummy, undefined)).toBe(false);
    expect(pOpt(dummy, undefined)).toBe(false);

    expectTypeOf(pOne).toBeCallableWith(dummy);
    expectTypeOf(pTwo).toBeCallableWith(dummy);
    expectTypeOf(pTwo).toBeCallableWith(dummy, context);
    expectTypeOf(pTwo).toBeCallableWith(dummy, undefined);
    expectTypeOf(pOpt).toBeCallableWith(dummy);
    expectTypeOf(pOpt).toBeCallableWith(dummy, context);
    expectTypeOf(pOpt).toBeCallableWith(dummy, undefined);
  });
});

describe('BaseToolset integration with LLM Request', () => {
  it('No prefix means the tool names match original names', async () => {
    const toolset = new DummyToolset();
    const tools = await toolset.getTools();
    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe('tool1');
    expect(tools[1].name).toBe('tool2');
  });

  it('Toolsets with a configured prefix correctly prefix names', async () => {
    const toolset = new DummyToolset('myprefix');
    const tools = await toolset.getTools();
    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe('myprefix_tool1');
    expect(tools[1].name).toBe('myprefix_tool2');
  });

  it('Multiple toolsets with no prefix and conflicting tool names cause an error', async () => {
    const toolset1 = new DummyToolset();
    const toolset2 = new DummyToolset(); // will emit tool1 and tool2 again

    const tools1 = await toolset1.getTools();
    const tools2 = await toolset2.getTools();

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    // Set up dummy context
    const context = new Context({
      invocationContext: {session: {state: {}}} as unknown as InvocationContext,
    });

    for (const tool of tools1) {
      await tool.processLlmRequest({toolContext: context, llmRequest});
    }

    // Attempting to add tools from toolset2 should fail on the first duplicate ('tool1')
    await expect(async () => {
      for (const tool of tools2) {
        await tool.processLlmRequest({toolContext: context, llmRequest});
      }
    }).rejects.toThrow('Duplicate tool name: tool1');
  });

  it('Multiple toolsets with separate prefixes and conflicting tool names do not cause an error', async () => {
    const toolset1 = new DummyToolset('prefixA');
    const toolset2 = new DummyToolset('prefixB');

    const tools1 = await toolset1.getTools();
    const tools2 = await toolset2.getTools();

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const context = new Context({
      invocationContext: {session: {state: {}}} as unknown as InvocationContext,
    });

    for (const tool of tools1) {
      await tool.processLlmRequest({toolContext: context, llmRequest});
    }

    for (const tool of tools2) {
      await tool.processLlmRequest({toolContext: context, llmRequest});
    }

    const toolKeys = Object.keys(llmRequest.toolsDict);
    expect(toolKeys.length).toBe(4);
    expect(toolKeys).toContain('prefixA_tool1');
    expect(toolKeys).toContain('prefixA_tool2');
    expect(toolKeys).toContain('prefixB_tool1');
    expect(toolKeys).toContain('prefixB_tool2');
  });

  it('leaves llmRequest unchanged in the default processLlmRequest implementation', async () => {
    const toolset = new DummyToolset();
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const context = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'test-invocation',
        agent: new LlmAgent({name: 'testAgent'}),
        session: createSession({
          id: 'test-session',
          appName: 'test-app',
          userId: 'test-user',
        }),
        pluginManager: new PluginManager([]),
        sessionService: new InMemorySessionService(),
      }),
    });

    await toolset.processLlmRequest(context, llmRequest);

    expect(llmRequest).toEqual({
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    });
  });

  it('allows subclasses to override processLlmRequest and mutate llmRequest', async () => {
    class CustomToolset extends DummyToolset {
      override async processLlmRequest(
        _toolContext: Context,
        llmRequest: LlmRequest,
      ): Promise<void> {
        llmRequest.contents.push({
          role: 'user',
          parts: [{text: 'Custom processing applied'}],
        });
      }
    }

    const toolset = new CustomToolset();
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const context = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'test-invocation',
        agent: new LlmAgent({name: 'testAgent'}),
        session: createSession({
          id: 'test-session',
          appName: 'test-app',
          userId: 'test-user',
        }),
        pluginManager: new PluginManager([]),
        sessionService: new InMemorySessionService(),
      }),
    });

    await toolset.processLlmRequest(context, llmRequest);

    expect(llmRequest.contents).toEqual([
      {
        role: 'user',
        parts: [{text: 'Custom processing applied'}],
      },
    ]);
  });
});

class MinimalToolsetWithoutClose extends BaseToolset {
  constructor(
    options: BaseToolsetOptions = {},
    private readonly tools: BaseTool[] = [],
  ) {
    super(options);
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.tools.filter((tool) => this.isToolSelected(tool, context));
  }
}

class ToolsetForPrefixTests extends BaseToolset {
  constructor(
    private readonly tools: BaseTool[] = [],
    options?: BaseToolsetOptions,
  ) {
    super(options);
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.tools.filter((tool) => this.isToolSelected(tool, context));
  }
}

describe('BaseToolset.close default and getToolsWithPrefix', () => {
  it('allows subclasses to omit close() and resolves without error', async () => {
    const toolset = new MinimalToolsetWithoutClose({}, [
      new DummyTool('tool1'),
    ]);

    await expect(toolset.close()).resolves.toBeUndefined();
    const tools = await toolset.getTools();
    expect(tools.map((tool) => tool.name)).toEqual(['tool1']);
  });

  it('supports BaseToolsetOptions and positional toolNamePrefix construction', async () => {
    class PositionalToolset extends BaseToolset {
      constructor(
        toolFilter?: ToolPredicate | string[],
        prefix?: string,
        toolNamePrefix?: string,
      ) {
        super(toolFilter, prefix, toolNamePrefix);
      }

      override async getTools(): Promise<BaseTool[]> {
        return [new DummyTool('tool1')];
      }
    }

    const fromOptions = new ToolsetForPrefixTests([new DummyTool('tool1')], {
      toolNamePrefix: 'explicit',
    });
    expect(fromOptions.toolNamePrefix).toBe('explicit');

    const fromPositional = new PositionalToolset(
      undefined,
      undefined,
      'posPrefix',
    );
    expect(fromPositional.toolNamePrefix).toBe('posPrefix');
    const prefixed = await fromPositional.getToolsWithPrefix();
    expect(prefixed[0]?.name).toBe('posPrefix_tool1');
  });

  it('returns original tools when toolNamePrefix is omitted, undefined, or empty', async () => {
    const tool1 = new DummyTool('tool1');
    const tool2 = new DummyTool('tool2');

    const defaultToolset = new ToolsetForPrefixTests([tool1, tool2]);
    expect(defaultToolset.toolNamePrefix).toBeUndefined();
    expect(await defaultToolset.getToolsWithPrefix()).toEqual([tool1, tool2]);

    const undefinedPrefixToolset = new ToolsetForPrefixTests([tool1, tool2], {
      toolNamePrefix: undefined,
    });
    expect(undefinedPrefixToolset.toolNamePrefix).toBeUndefined();
    expect(await undefinedPrefixToolset.getToolsWithPrefix()).toEqual([
      tool1,
      tool2,
    ]);

    const emptyPrefixToolset = new ToolsetForPrefixTests([tool1], {
      toolNamePrefix: '',
    });
    expect(emptyPrefixToolset.toolNamePrefix).toBe('');
    const emptyPrefixed = await emptyPrefixToolset.getToolsWithPrefix();
    expect(emptyPrefixed).toEqual([tool1]);
    expect(emptyPrefixed[0]?.name).toBe('tool1');
  });

  it('creates non-mutating prefixed copies while preserving tool properties and getTools output', async () => {
    const originalTool = new FunctionTool({
      name: 'original',
      description: 'Original description',
      isLongRunning: true,
      customMetadata: {tag: 'meta'},
      parameters: z.object({query: z.string()}),
      execute: async ({query}) => `ran:${query}`,
    });
    const toolset = new ToolsetForPrefixTests([originalTool], {
      toolNamePrefix: 'test',
    });

    const originalTools = await toolset.getTools();
    expect(originalTools[0]?.name).toBe('original');

    const prefixedTools = await toolset.getToolsWithPrefix();
    const prefixedTool = prefixedTools[0];
    expect(prefixedTool).toBeDefined();
    expect(prefixedTool?.name).toBe('test_original');
    expect(prefixedTool?.description).toBe('Original description');
    expect(prefixedTool?.isLongRunning).toBe(true);
    expect(prefixedTool?.customMetadata).toEqual({tag: 'meta'});
    expect(prefixedTool?.constructor).toBe(FunctionTool);
    expect(prefixedTool?.constructor.name).toBe('FunctionTool');
    expect(prefixedTool).not.toBe(originalTool);

    expect(originalTool.name).toBe('original');
    expect(originalTool._getDeclaration().name).toBe('original');
  });

  it('handles empty toolsets with toolNamePrefix cleanly', async () => {
    const toolset = new ToolsetForPrefixTests([], {toolNamePrefix: 'test'});
    expect(await toolset.getToolsWithPrefix()).toEqual([]);
  });

  it('prefixes FunctionTool declarations independently across multiple tools without double-prefixing', async () => {
    const toolOne = new FunctionTool({
      name: 'toolOne',
      description: 'Function one.',
      parameters: z.object({param: z.string()}),
      execute: ({param}) => `one: ${param}`,
    });
    const toolTwo = new FunctionTool({
      name: 'toolTwo',
      description: 'Function two.',
      parameters: z.object({param: z.number()}),
      execute: ({param}) => `two: ${param}`,
    });
    const toolset = new ToolsetForPrefixTests([toolOne, toolTwo], {
      toolNamePrefix: 'test',
    });

    const firstCall = await toolset.getToolsWithPrefix();
    const secondCall = await toolset.getToolsWithPrefix();

    expect(firstCall[0]?.name).toBe('test_toolOne');
    expect(firstCall[1]?.name).toBe('test_toolTwo');
    expect(secondCall[0]?.name).toBe('test_toolOne');
    expect(firstCall[0]).not.toBe(secondCall[0]);
    expect(toolOne.name).toBe('toolOne');

    const decl1 = firstCall[0]?._getDeclaration();
    const decl2 = firstCall[1]?._getDeclaration();
    expect(decl1?.name).toBe('test_toolOne');
    expect(decl1?.description).toContain('Function one.');
    expect(decl2?.name).toBe('test_toolTwo');
    expect(decl2?.description).toContain('Function two.');
    expect(toolOne._getDeclaration().name).toBe('toolOne');
    expect(toolTwo._getDeclaration().name).toBe('toolTwo');
  });

  it('registers prefixed tool proxy and declaration in LlmRequest via processLlmRequest', async () => {
    const fnTool = new FunctionTool({
      name: 'testFunction',
      description: 'A test function.',
      parameters: z.object({param: z.string()}),
      execute: ({param}) => `result: ${param}`,
    });
    const toolset = new ToolsetForPrefixTests([fnTool], {
      toolNamePrefix: 'test',
    });
    const [prefixedTool] = await toolset.getToolsWithPrefix();

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'testApp',
      userId: 'testUser',
    });
    const agent = new LlmAgent({name: 'testAgent'});
    const invocationContext = new InvocationContext({
      invocationId: 'inv-prefix',
      agent,
      session,
      sessionService,
      pluginManager: new PluginManager([]),
    });
    const toolContext = new Context({invocationContext});
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await prefixedTool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.toolsDict['test_testFunction']).toBe(prefixedTool);
    const firstTool = llmRequest.config?.tools?.[0];
    expect(firstTool).toBeDefined();
    expect(
      firstTool && 'functionDeclarations' in firstTool
        ? firstTool.functionDeclarations?.[0]?.name
        : undefined,
    ).toBe('test_testFunction');
    expect(fnTool.name).toBe('testFunction');
    expect(fnTool._getDeclaration().name).toBe('testFunction');
  });

  it('integrates toolNamePrefix toolsets and legacy prefix toolsets in LlmAgent without double-prefixing', async () => {
    const capturedRequests: LlmRequest[] = [];
    class CapturingMockLlm extends BaseLlm {
      private turn = 0;

      constructor() {
        super({model: 'gemini-flash-latest'});
      }

      override async *generateContentAsync(
        llmRequest: LlmRequest,
      ): AsyncGenerator<LlmResponse, void, void> {
        capturedRequests.push(llmRequest);
        this.turn += 1;
        if (this.turn === 1) {
          yield {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call-prefixed-1',
                    name: 'alpha_lookup',
                    args: {item: 'widget'},
                  },
                },
              ],
            },
          };
          return;
        }
        yield {
          content: {
            role: 'model',
            parts: [{text: 'Completed with prefixed tool'}],
          },
        };
      }

      override async connect(): Promise<BaseLlmConnection> {
        throw new Error('Live connection not used');
      }
    }

    const alphaToolset = new ToolsetForPrefixTests(
      [
        new FunctionTool({
          name: 'lookup',
          description: 'Looks up an item.',
          parameters: z.object({item: z.string()}),
          execute: ({item}) => ({found: item}),
        }),
      ],
      {toolNamePrefix: 'alpha'},
    );
    const legacyToolset = new DummyToolset('legacy');

    const agent = new LlmAgent({
      name: 'prefixAgent',
      model: new CapturingMockLlm(),
      tools: [alphaToolset, legacyToolset],
    });
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'testApp',
      userId: 'testUser',
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv-agent-prefix',
      agent,
      session,
      sessionService,
      pluginManager: new PluginManager([]),
    });

    const events = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }

    expect(Object.keys(capturedRequests[0]?.toolsDict ?? {})).toEqual([
      'alpha_lookup',
      'legacy_tool1',
      'legacy_tool2',
    ]);
    const toolResponse = events
      .flatMap((event) => event.content?.parts ?? [])
      .find((part) => part.functionResponse?.name === 'alpha_lookup')
      ?.functionResponse?.response;
    expect(toolResponse).toEqual({found: 'widget'});
  });

  it('preserves streaming FunctionTool.execute and prototype _callLive in getToolsWithPrefix', async () => {
    class CustomStreamingTool extends BaseTool {
      constructor(name: string) {
        super({name, description: 'Custom streaming tool'});
      }

      override async runAsync(): Promise<unknown> {
        return 'non-streaming';
      }

      async *_callLive(
        req: CallLiveToolRequest,
      ): AsyncGenerator<unknown, void, void> {
        yield `${this.name}:${String(req.args['topic'] ?? '')}`;
      }
    }

    const streamingFnTool = new FunctionTool({
      name: 'monitorPrice',
      description: 'Streams prices.',
      parameters: z.object({symbol: z.string()}),
      execute: async function* ({symbol}) {
        yield `${symbol}:101`;
      },
    });
    const customStreamingTool = new CustomStreamingTool('customStream');
    const toolset = new ToolsetForPrefixTests(
      [streamingFnTool, customStreamingTool],
      {toolNamePrefix: 'alpha'},
    );

    const prefixedTools = await toolset.getToolsWithPrefix();
    const toolsDict = Object.fromEntries(
      prefixedTools.map((tool) => [tool.name, tool]),
    );
    const liveQueue = new LiveRequestQueue();
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'liveApp',
      userId: 'liveUser',
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv-live-prefix',
      agent: new LlmAgent({name: 'liveAgent'}),
      session,
      sessionService,
      pluginManager: new PluginManager([]),
      liveRequestQueue: liveQueue,
      activeStreamingTools: {
        alpha_monitorPrice: new ActiveStreamingTool(),
        alpha_customStream: new ActiveStreamingTool(),
      },
    });

    const callEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: 'liveAgent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-stream-fn',
              name: 'alpha_monitorPrice',
              args: {symbol: 'GOOG'},
            },
          },
          {
            functionCall: {
              id: 'fc-stream-custom',
              name: 'alpha_customStream',
              args: {topic: 'news'},
            },
          },
        ],
      },
    });

    const responseEvent = await handleFunctionCallsLive({
      invocationContext,
      functionCallEvent: callEvent,
      toolsDict,
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(responseEvent?.content?.parts).toEqual([
      {
        functionResponse: {
          id: 'fc-stream-fn',
          name: 'alpha_monitorPrice',
          response: {
            status:
              'The function is running asynchronously and the results are pending.',
          },
        },
      },
      {
        functionResponse: {
          id: 'fc-stream-custom',
          name: 'alpha_customStream',
          response: {
            status:
              'The function is running asynchronously and the results are pending.',
          },
        },
      },
    ]);

    const fnTask =
      invocationContext.activeStreamingTools?.['alpha_monitorPrice']?.task;
    const customTask =
      invocationContext.activeStreamingTools?.['alpha_customStream']?.task;
    expect(fnTask).toBeDefined();
    expect(customTask).toBeDefined();
    await Promise.all([fnTask?.promise, customTask?.promise]);

    const queuedMessages = [
      (await liveQueue.get()).content?.parts?.[0]?.text,
      (await liveQueue.get()).content?.parts?.[0]?.text,
    ];
    expect(queuedMessages).toEqual(
      expect.arrayContaining([
        'Function alpha_monitorPrice returned: GOOG:101',
        'Function alpha_customStream returned: alpha_customStream:news',
      ]),
    );
  });
});
