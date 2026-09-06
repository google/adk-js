/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseRetrievalTool, LlmRequest} from '@google/adk';
import {Tool, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

class StubRetrieval extends BaseRetrievalTool {
  constructor(name = 'stub_retrieval', description = 'A stub.') {
    super({name, description});
  }

  override async runAsync(): Promise<unknown> {
    return 'stub';
  }
}

function makeLlmRequest(): LlmRequest {
  return {
    model: 'gemini-2.0-flash',
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

describe('BaseRetrievalTool', () => {
  it('declares a single string `query` parameter', () => {
    expect(new StubRetrieval()._getDeclaration()).toEqual({
      name: 'stub_retrieval',
      description: 'A stub.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {type: Type.STRING, description: 'The query to retrieve.'},
        },
      },
    });
  });

  it('carries the subclass name and description into the declaration', () => {
    const declaration = new StubRetrieval(
      'docs',
      'Company documentation.',
    )._getDeclaration();

    expect(declaration.name).toBe('docs');
    expect(declaration.description).toBe('Company documentation.');
  });

  // adk-python v0.1.0 leaves `query` optional; the declaration carries no
  // `required` list. Locked in so the port does not quietly gain one.
  it('does not mark `query` required, matching adk-python v0.1.0', () => {
    expect(new StubRetrieval()._getDeclaration().parameters).not.toHaveProperty(
      'required',
    );
  });

  it('is a client-side tool, so it goes into toolsDict and config.tools', async () => {
    const tool = new StubRetrieval();
    const llmRequest = makeLlmRequest();

    await tool.processLlmRequest({llmRequest, toolContext: undefined as never});

    expect(llmRequest.toolsDict['stub_retrieval']).toBe(tool);
    const tools = (llmRequest.config?.tools ?? []) as Tool[];
    expect(tools[0].functionDeclarations?.[0].name).toBe('stub_retrieval');
  });

  it('shares one tool entry with other declared tools', async () => {
    const llmRequest = makeLlmRequest();

    await new StubRetrieval('first', 'First.').processLlmRequest({
      llmRequest,
      toolContext: undefined as never,
    });
    await new StubRetrieval('second', 'Second.').processLlmRequest({
      llmRequest,
      toolContext: undefined as never,
    });

    const tools = (llmRequest.config?.tools ?? []) as Tool[];
    expect(tools).toHaveLength(1);
    expect(tools[0].functionDeclarations?.map((d) => d.name)).toEqual([
      'first',
      'second',
    ]);
  });
});
