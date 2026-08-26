/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as adk from '@google/adk';
import {
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  BuiltInTool,
  ENTERPRISE_WEB_SEARCH,
  Event,
  FunctionTool,
  GOOGLE_MAPS_GROUNDING,
  GOOGLE_SEARCH,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  URL_CONTEXT,
  VertexAiSearchTool,
  VertexRagRetrievalTool,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {logger} from '../../src/utils/logger.js';

/**
 * Calling an in-model tool as a function is warned about by design; keep the
 * expected diagnostics out of the suite output.
 */
function silenceExpectedWarnings() {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
}

function requestFor(model: string): LlmRequest {
  return {model, contents: [], toolsDict: {}, liveConnectConfig: {}};
}

/** Every built-in tool, with a model each one accepts. */
const BUILT_IN_TOOLS: Array<{tool: BuiltInTool; name: string}> = [
  {tool: GOOGLE_SEARCH, name: 'google_search'},
  {tool: URL_CONTEXT, name: 'url_context'},
  {tool: GOOGLE_MAPS_GROUNDING, name: 'google_maps'},
  {tool: ENTERPRISE_WEB_SEARCH, name: 'enterprise_web_search'},
  {
    tool: new VertexAiSearchTool({dataStoreId: 'ds-1'}),
    name: 'vertex_ai_search',
  },
  {
    tool: new VertexRagRetrievalTool({ragResources: [{ragCorpus: 'corpus-1'}]}),
    name: 'vertex_rag_retrieval',
  },
];

describe('BuiltInTool', () => {
  silenceExpectedWarnings();

  // These tools have no function declaration, so `BaseTool.processLlmRequest`
  // returns before registering them. That left the model primed with a name
  // the framework could not route, which is what #789 reported.
  describe.each(BUILT_IN_TOOLS)('$name', ({tool, name}) => {
    it('registers itself so a call naming it can resolve', async () => {
      const llmRequest = requestFor('gemini-2.5-flash');

      await tool.processLlmRequest({
        llmRequest,
        toolContext: undefined as never,
      });

      expect(llmRequest.toolsDict[name]).toBe(tool);
    });

    it('still adds its own configuration to the request', async () => {
      const llmRequest = requestFor('gemini-2.5-flash');

      await tool.processLlmRequest({
        llmRequest,
        toolContext: undefined as never,
      });

      expect(llmRequest.config?.tools?.length).toBeGreaterThan(0);
    });

    it('answers a call by telling the model it is not callable', async () => {
      const {error} = (await tool.runAsync()) as {error: string};

      expect(error).toContain(`${name} runs inside the model`);
      expect(error).toContain('grounding metadata');
    });
  });

  it('is a BaseTool, so tool plumbing still accepts it', () => {
    expect(GOOGLE_SEARCH).toBeInstanceOf(BaseTool);
    expect(GOOGLE_SEARCH).toBeInstanceOf(BuiltInTool);
  });

  // A built-in tool holds its name only so a call naming it can be routed. A
  // genuinely callable tool of the same name is what the model's call means,
  // and it won in both orders before the registration existed — so it still
  // has to, whichever is processed first.
  describe('a callable tool of the same name', () => {
    function googleSearchFunctionTool() {
      return new FunctionTool({
        name: 'google_search',
        description: 'A local tool that happens to share the name.',
        parameters: z.object({}),
        execute: async () => ({result: 'local'}),
      });
    }

    it('wins when the built-in is processed first', async () => {
      const llmRequest = requestFor('gemini-2.5-flash');
      const local = googleSearchFunctionTool();

      await GOOGLE_SEARCH.processLlmRequest({
        llmRequest,
        toolContext: undefined as never,
      });
      // Would have thrown `Duplicate tool name` before the in-model entry was
      // made displaceable.
      await local.processLlmRequest({
        llmRequest,
        toolContext: undefined as never,
      });

      expect(llmRequest.toolsDict['google_search']).toBe(local);
    });

    it('wins when it is processed first', async () => {
      const llmRequest = requestFor('gemini-2.5-flash');
      const local = googleSearchFunctionTool();

      await local.processLlmRequest({
        llmRequest,
        toolContext: undefined as never,
      });
      await GOOGLE_SEARCH.processLlmRequest({
        llmRequest,
        toolContext: undefined as never,
      });

      // Silently shadowing this would answer the model with the not-callable
      // guidance instead of running the user's tool.
      expect(llmRequest.toolsDict['google_search']).toBe(local);
    });

    it('still collides with another callable tool of the same name', async () => {
      const llmRequest = requestFor('gemini-2.5-flash');

      await googleSearchFunctionTool().processLlmRequest({
        llmRequest,
        toolContext: undefined as never,
      });

      await expect(
        googleSearchFunctionTool().processLlmRequest({
          llmRequest,
          toolContext: undefined as never,
        }),
      ).rejects.toThrow('Duplicate tool name: google_search');
    });
  });

  // `toolsDict` is a plain object, so a lookup by name walks
  // `Object.prototype`. Both registration paths ask `Object.hasOwn` instead,
  // matching how `functions.ts` resolves a call.
  describe('a tool named after an Object.prototype member', () => {
    class ToStringBuiltIn extends BuiltInTool {
      constructor() {
        super({name: 'toString', description: 'Shares an inherited name.'});
      }

      protected override async applyBuiltInConfig(): Promise<void> {}
    }

    it('registers rather than reading the inherited value as taken', async () => {
      const llmRequest = requestFor('gemini-2.5-flash');
      const tool = new ToStringBuiltIn();

      await tool.processLlmRequest({
        llmRequest,
        toolContext: undefined as never,
      });

      expect(Object.hasOwn(llmRequest.toolsDict, 'toString')).toBe(true);
      expect(llmRequest.toolsDict['toString']).toBe(tool);
    });

    it('does not report a duplicate for a callable tool', async () => {
      const llmRequest = requestFor('gemini-2.5-flash');
      const local = new FunctionTool({
        name: 'toString',
        description: 'Shares an inherited name.',
        parameters: z.object({}),
        execute: async () => ({result: 'local'}),
      });

      await local.processLlmRequest({
        llmRequest,
        toolContext: undefined as never,
      });

      expect(llmRequest.toolsDict['toString']).toBe(local);
    });
  });

  it('does not register a name when the tool rejects the model', async () => {
    const llmRequest = requestFor('not-a-gemini-model');

    // A tool that refuses the model advertises nothing, so it must not leave
    // behind a name claiming to be callable.
    await expect(
      GOOGLE_SEARCH.processLlmRequest({
        llmRequest,
        toolContext: undefined as never,
      }),
    ).rejects.toThrow();
    expect(llmRequest.toolsDict).toEqual({});
  });
});

/**
 * `BUILT_IN_TOOLS` above is hand-maintained, so it can only test the tools
 * that exist today. This checks the invariant itself: a tool that can never
 * produce a function declaration cannot enter `toolsDict` through
 * `BaseTool.processLlmRequest`, so a call naming it cannot resolve — the #789
 * failure. Such a tool must be a `BuiltInTool`, which registers itself, or be
 * listed below with the reason it is safe. A seventh built-in written the way
 * the first six were then fails here instead of shipping.
 */
describe('the declaration-less tool surface', () => {
  // Prompt mutators: they inject into the prompt and the model never sees a
  // name for them, so no function call can come back naming one.
  const NOT_MODEL_ADDRESSABLE = new Set(['ExampleTool', 'PreloadMemoryTool']);

  type ToolClass = (abstract new (...args: never[]) => BaseTool) & {
    name: string;
  };

  /**
   * Whether the class overrides `_getDeclaration`. `BaseTool`'s own
   * implementation returns undefined, so a subclass that never overrides it
   * has no declaration whatever its arguments are.
   */
  function declaresAFunction(ctor: ToolClass): boolean {
    for (
      let proto: object | null = ctor.prototype;
      proto && proto !== BaseTool.prototype;
      proto = Object.getPrototypeOf(proto)
    ) {
      if (Object.hasOwn(proto, '_getDeclaration')) {
        return true;
      }
    }
    return false;
  }

  function isBuiltIn(ctor: ToolClass): boolean {
    return ctor.prototype instanceof BuiltInTool;
  }

  /** Every exported tool class, including the ones behind a singleton. */
  function exportedToolClasses(): Map<string, ToolClass> {
    const classes = new Map<string, ToolClass>();
    for (const value of Object.values(adk as Record<string, unknown>)) {
      const ctor =
        typeof value === 'function' && value.prototype instanceof BaseTool
          ? (value as ToolClass)
          : value instanceof BaseTool
            ? (value.constructor as ToolClass)
            : undefined;
      // `BuiltInTool` itself is abstract, so it holds neither side of the
      // invariant.
      if (ctor && (ctor as unknown) !== BuiltInTool) {
        classes.set(ctor.name, ctor);
      }
    }
    return classes;
  }

  it('is BuiltInTool subclasses plus the documented exemptions', () => {
    const unaddressable = [...exportedToolClasses()]
      .filter(([, ctor]) => !declaresAFunction(ctor) && !isBuiltIn(ctor))
      .map(([name]) => name);

    expect(new Set(unaddressable)).toEqual(NOT_MODEL_ADDRESSABLE);
  });

  it('finds the built-in tools it is meant to be checking', () => {
    // Guards the sweep itself: if the barrel stopped exporting tools, or
    // `_getDeclaration` were renamed, the assertion above would pass empty.
    const builtIns = [...exportedToolClasses().values()].filter(isBuiltIn);

    expect(builtIns.length).toBe(BUILT_IN_TOOLS.length);
  });
});

// The reported #789 case: the user registers google_search, Gemini returns it
// as an explicit function call rather than running it, and the framework had
// no way to route the call.
describe('a built-in tool called as a function', () => {
  silenceExpectedWarnings();

  class GroundingCallerLlm extends BaseLlm {
    calls = 0;

    constructor() {
      super({model: 'gemini-2.5-flash'});
    }

    async *generateContentAsync(
      request: LlmRequest,
    ): AsyncGenerator<LlmResponse, void, void> {
      this.calls++;
      const answered = (request.contents ?? []).some((content) =>
        (content.parts ?? []).some((part) => part.functionResponse),
      );
      yield answered
        ? {content: {role: 'model', parts: [{text: 'Grounded answer.'}]}}
        : {
            content: {
              role: 'model',
              parts: [
                {functionCall: {id: 'call-1', name: 'google_search', args: {}}},
              ],
            },
          };
    }

    async connect(): Promise<BaseLlmConnection> {
      throw new Error('not used in this test');
    }
  }

  it('resolves to the registered tool instead of failing to resolve', async () => {
    const mockLlm = new GroundingCallerLlm();
    const agent = new LlmAgent({
      name: 'grounding_agent',
      model: mockLlm,
      tools: [
        GOOGLE_SEARCH,
        new FunctionTool({
          name: 'search_web',
          description: 'A regular tool.',
          parameters: z.object({}),
          execute: async () => ({results: []}),
        }),
      ],
    });

    const runner = new InMemoryRunner({agent, appName: 'grounding_app'});
    const session = await runner.sessionService.createSession({
      appName: 'grounding_app',
      userId: 'u1',
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'u1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'go'}]},
    })) {
      events.push(event);
    }

    expect(events.filter((e) => e.errorMessage)).toHaveLength(0);
    expect(mockLlm.calls).toBe(2);

    const responses = events
      .flatMap((e) => e.content?.parts ?? [])
      .filter((p) => p.functionResponse)
      .map((p) => p.functionResponse!);
    expect(responses).toHaveLength(1);
    expect(responses[0].name).toBe('google_search');
    // The tool resolved and answered for itself. Before this change the name
    // was absent from toolsDict, so the call fell through to the
    // unresolvable-tool handler instead.
    expect((responses[0].response as {error: string}).error).toContain(
      'google_search runs inside the model',
    );
    expect((responses[0].response as {error: string}).error).not.toContain(
      'is not found in the toolsDict',
    );
  });
});
