/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  appendInstructions,
  BaseTool,
  Context,
  FunctionTool,
  GOOGLE_SEARCH,
  InMemorySessionService,
  InvocationContext,
  LlmRequest,
  PluginManager,
  SequentialAgent,
} from '@google/adk';
import {Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {appendTools, setOutputSchema} from '../../src/models/llm_request.js';
import {logger} from '../../src/utils/logger.js';

function newRequest(): LlmRequest {
  return {contents: [], liveConnectConfig: {}, toolsDict: {}};
}

async function createToolContext(): Promise<Context> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'testApp',
    userId: 'testUser',
  });
  const agent = new SequentialAgent({name: 'testAgent'});
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent,
    session,
    sessionService,
    pluginManager: new PluginManager(),
  });
  return new Context({invocationContext});
}

class DeclarationlessTool extends BaseTool {
  constructor() {
    super({name: 'no_declaration', description: 'Has no declaration.'});
  }

  async runAsync(): Promise<unknown> {
    return undefined;
  }
}

describe('appendInstructions', () => {
  it('joins the instructions with a blank line', () => {
    const request = newRequest();
    appendInstructions(request, ['first', 'second']);
    expect(request.config?.systemInstruction).toBe('first\n\nsecond');
  });

  it('appends to an existing system instruction after a blank line', () => {
    const request = newRequest();
    request.config = {systemInstruction: 'existing'};
    appendInstructions(request, ['added']);
    expect(request.config.systemInstruction).toBe('existing\n\nadded');
  });

  it('creates the config when it is missing', () => {
    const request = newRequest();
    expect(request.config).toBeUndefined();
    appendInstructions(request, ['only']);
    expect(request.config).toEqual({systemInstruction: 'only'});
  });
});

describe('appendTools', () => {
  const weatherTool = new FunctionTool({
    name: 'get_weather',
    description: 'Returns the weather for a city.',
    parameters: {
      type: Type.OBJECT,
      properties: {city: {type: Type.STRING}},
    },
    execute: async () => ({forecast: 'sunny'}),
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing for an empty tool list', () => {
    const request = newRequest();
    appendTools(request, []);
    expect(request.config).toBeUndefined();
    expect(request.toolsDict).toEqual({});
  });

  it('adds one functionDeclarations tool and registers the tools by name', () => {
    const request = newRequest();
    appendTools(request, [weatherTool, new DeclarationlessTool()]);

    expect(request.config?.tools).toHaveLength(1);
    const declarations = request.config?.tools?.[0];
    expect(declarations).toEqual({
      functionDeclarations: [weatherTool._getDeclaration()],
    });
    expect(Object.keys(request.toolsDict)).toEqual(['get_weather']);
    expect(request.toolsDict['get_weather']).toBe(weatherTool);
  });

  it('leaves the config unchanged when no tool has a declaration', () => {
    const request = newRequest();
    appendTools(request, [new DeclarationlessTool()]);
    expect(request.config).toBeUndefined();
    expect(request.toolsDict).toEqual({});
  });

  it('appends declarations into an existing functionDeclarations tool entry', () => {
    const existingDeclaration = {
      name: 'existingTool',
      description: 'An existing tool.',
    };
    const searchTool = new FunctionTool({
      name: 'searchDocs',
      description: 'Searches documentation.',
      parameters: {
        type: Type.OBJECT,
        properties: {query: {type: Type.STRING}},
      },
      execute: async (input) => input,
    });
    const request = newRequest();
    request.config = {
      tools: [{functionDeclarations: [existingDeclaration]}],
    };

    appendTools(request, [searchTool]);

    expect(request.config.tools).toHaveLength(1);
    expect(request.config.tools?.[0]).toEqual({
      functionDeclarations: [existingDeclaration, searchTool._getDeclaration()],
    });
    expect(request.toolsDict['searchDocs']).toBe(searchTool);
  });

  it('appends declarations into an existing functionDeclarations entry after a built-in tool', () => {
    const existingDeclaration = {
      name: 'existingTool',
      description: 'An existing tool.',
    };
    const searchTool = new FunctionTool({
      name: 'searchDocs',
      description: 'Searches documentation.',
      parameters: {
        type: Type.OBJECT,
        properties: {query: {type: Type.STRING}},
      },
      execute: async (input) => input,
    });
    const request = newRequest();
    request.config = {
      tools: [
        {googleSearch: {}},
        {functionDeclarations: [existingDeclaration]},
      ],
    };

    appendTools(request, [searchTool]);

    expect(request.config.tools).toHaveLength(2);
    expect(request.config.tools?.[0]).toEqual({googleSearch: {}});
    expect(request.config.tools?.[1]).toEqual({
      functionDeclarations: [existingDeclaration, searchTool._getDeclaration()],
    });
  });

  it('adds a new functionDeclarations entry after a built-in tool when none exists', () => {
    const searchTool = new FunctionTool({
      name: 'searchDocs',
      description: 'Searches documentation.',
      execute: async () => 'ok',
    });
    const request = newRequest();
    request.config = {tools: [{googleSearch: {}}]};

    appendTools(request, [searchTool]);

    expect(request.config.tools).toHaveLength(2);
    expect(request.config.tools?.[0]).toEqual({googleSearch: {}});
    expect(request.config.tools?.[1]).toEqual({
      functionDeclarations: [searchTool._getDeclaration()],
    });
  });

  it('skips tool entries whose functionDeclarations property is undefined and reuses empty arrays', () => {
    const searchTool = new FunctionTool({
      name: 'searchDocs',
      description: 'Searches documentation.',
      execute: async () => 'ok',
    });
    const requestWithUndefined = newRequest();
    requestWithUndefined.config = {
      tools: [{functionDeclarations: undefined}],
    };

    appendTools(requestWithUndefined, [searchTool]);

    expect(requestWithUndefined.config.tools).toHaveLength(2);
    expect(requestWithUndefined.config.tools?.[1]).toEqual({
      functionDeclarations: [searchTool._getDeclaration()],
    });

    const requestWithEmptyArray = newRequest();
    requestWithEmptyArray.config = {
      tools: [{functionDeclarations: []}],
    };

    appendTools(requestWithEmptyArray, [searchTool]);

    expect(requestWithEmptyArray.config.tools).toHaveLength(1);
    expect(requestWithEmptyArray.config.tools?.[0]).toEqual({
      functionDeclarations: [searchTool._getDeclaration()],
    });
  });

  it('consolidates declarations from multiple tools into a single tool entry', () => {
    const toolOne = new FunctionTool({
      name: 'toolOne',
      description: 'First tool.',
      execute: async () => 'one',
    });
    const toolTwo = new FunctionTool({
      name: 'toolTwo',
      description: 'Second tool.',
      execute: async () => 'two',
    });
    const toolThree = new FunctionTool({
      name: 'toolThree',
      description: 'Third tool.',
      execute: async () => 'three',
    });
    const request = newRequest();

    appendTools(request, [toolOne, toolTwo, toolThree]);

    expect(request.config?.tools).toHaveLength(1);
    expect(request.config?.tools?.[0]).toEqual({
      functionDeclarations: [
        toolOne._getDeclaration(),
        toolTwo._getDeclaration(),
        toolThree._getDeclaration(),
      ],
    });
    expect(request.toolsDict).toEqual({
      toolOne,
      toolTwo,
      toolThree,
    });
  });

  it('consolidates declarations across multiple sequential appendTools calls', () => {
    const toolOne = new FunctionTool({
      name: 'toolOne',
      description: 'First tool.',
      execute: async () => 'one',
    });
    const toolTwo = new FunctionTool({
      name: 'toolTwo',
      description: 'Second tool.',
      execute: async () => 'two',
    });
    const toolThree = new FunctionTool({
      name: 'toolThree',
      description: 'Third tool.',
      execute: async () => 'three',
    });
    const request = newRequest();

    appendTools(request, [toolOne]);
    expect(request.config?.tools).toHaveLength(1);

    appendTools(request, [toolTwo, toolThree]);

    expect(request.config?.tools).toHaveLength(1);
    expect(request.config?.tools?.[0]).toEqual({
      functionDeclarations: [
        toolOne._getDeclaration(),
        toolTwo._getDeclaration(),
        toolThree._getDeclaration(),
      ],
    });
    expect(request.toolsDict).toEqual({
      toolOne,
      toolTwo,
      toolThree,
    });
  });

  it('warns and updates toolsDict when shadowing an existing callable tool name', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const firstSearch = new FunctionTool({
      name: 'searchDocs',
      description: 'First search.',
      execute: async () => 'first',
    });
    const secondSearch = new FunctionTool({
      name: 'searchDocs',
      description: 'Second search.',
      execute: async () => 'second',
    });
    const request = newRequest();

    appendTools(request, [firstSearch, secondSearch]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate tool name "searchDocs"'),
    );
    expect(Object.keys(request.toolsDict)).toEqual(['searchDocs']);
    expect(request.toolsDict['searchDocs']).toBe(secondSearch);
    expect(request.config?.tools).toHaveLength(1);
    expect(request.config?.tools?.[0]).toEqual({
      functionDeclarations: [
        firstSearch._getDeclaration(),
        secondSearch._getDeclaration(),
      ],
    });
  });

  it('displaces an in-model tool in toolsDict without logging a duplicate warning', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const request = newRequest();
    request.model = 'gemini-2.5-flash';
    await GOOGLE_SEARCH.processLlmRequest({
      llmRequest: request,
      toolContext: await createToolContext(),
    });
    warnSpy.mockClear();

    const localSearch = new FunctionTool({
      name: GOOGLE_SEARCH.name,
      description: 'Local search.',
      execute: async () => 'local',
    });

    appendTools(request, [localSearch]);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(request.toolsDict[GOOGLE_SEARCH.name]).toBe(localSearch);
  });

  it('matches the structure produced by sequential BaseTool.processLlmRequest calls', async () => {
    const toolContext = await createToolContext();
    const makeTools = () => [
      new FunctionTool({
        name: 'toolOne',
        description: 'First tool.',
        execute: async () => 'one',
      }),
      new FunctionTool({
        name: 'toolTwo',
        description: 'Second tool.',
        execute: async () => 'two',
      }),
      new FunctionTool({
        name: 'toolThree',
        description: 'Third tool.',
        execute: async () => 'three',
      }),
    ];

    const appendRequest = newRequest();
    const appendToolSet = makeTools();
    appendTools(appendRequest, appendToolSet);

    const processRequest = newRequest();
    const processToolSet = makeTools();
    for (const tool of processToolSet) {
      await tool.processLlmRequest({toolContext, llmRequest: processRequest});
    }

    expect(appendRequest.config?.tools).toHaveLength(1);
    expect(processRequest.config?.tools).toHaveLength(1);
    expect(appendRequest.config?.tools).toEqual(processRequest.config?.tools);
    expect(Object.keys(appendRequest.toolsDict)).toEqual(
      Object.keys(processRequest.toolsDict),
    );
  });
});

describe('setOutputSchema', () => {
  it('sets the response schema and the JSON MIME type', () => {
    const request = newRequest();
    const schema = {
      type: Type.OBJECT,
      properties: {answer: {type: Type.STRING}},
    };
    setOutputSchema(request, schema);
    expect(request.config?.responseSchema).toBe(schema);
    expect(request.config?.responseMimeType).toBe('application/json');
  });
});
