/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  appendInstructions,
  BaseTool,
  FunctionTool,
  LlmRequest,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {appendTools, setOutputSchema} from '../../src/models/llm_request.js';

function newRequest(): LlmRequest {
  return {contents: [], liveConnectConfig: {}, toolsDict: {}};
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
