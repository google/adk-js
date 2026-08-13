/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';
import {afterEach, describe, expect, it} from 'vitest';
import {Context} from '../../src/agents/context.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {
  VertexAiSearchTool,
  VertexAiSearchToolParams,
} from '../../src/tools/vertex_ai_search_tool.js';

interface TestTool {
  retrieval?: {
    vertexAiSearch?: {
      datastore?: string;
      dataStoreSpecs?: Array<{dataStore?: string}>;
      engine?: string;
      filter?: string;
      maxResults?: number;
    };
  };
}

/** The param combinations the constructor rejects at runtime. */
interface LooseVertexAiSearchToolParams {
  dataStoreId?: string;
  searchEngineId?: string;
  dataStoreSpecs?: Array<{dataStore?: string}>;
}

/**
 * `VertexAiSearchToolParams` is a discriminated union that makes the invalid
 * combinations below unrepresentable, but the constructor still validates them
 * at runtime, so these tests deliberately pass params the type would reject.
 */
function invalidParams(
  params: LooseVertexAiSearchToolParams,
): VertexAiSearchToolParams {
  return params as unknown as VertexAiSearchToolParams;
}

function makeLlmRequest(
  model: string,
  config?: GenerateContentConfig,
): LlmRequest {
  return {model, contents: [], toolsDict: {}, liveConnectConfig: {}, config};
}

describe('VertexAiSearchTool', () => {
  it('should throw error if neither dataStoreId nor searchEngineId is specified', () => {
    expect(() => new VertexAiSearchTool(invalidParams({}))).toThrowError(
      'Either dataStoreId or searchEngineId must be specified.',
    );
  });

  it('should throw error if both dataStoreId and searchEngineId are specified', () => {
    expect(
      () =>
        new VertexAiSearchTool(
          invalidParams({
            dataStoreId: 'ds',
            searchEngineId: 'se',
          }),
        ),
    ).toThrowError('Either dataStoreId or searchEngineId must be specified.');
  });

  it('should throw error if dataStoreSpecs is specified without searchEngineId', () => {
    expect(
      () =>
        new VertexAiSearchTool(
          invalidParams({
            dataStoreId: 'ds',
            dataStoreSpecs: [{dataStore: 'ds1'}],
          }),
        ),
    ).toThrowError(
      'searchEngineId must be specified if dataStoreSpecs is specified.',
    );
  });

  it('should initialize correctly with dataStoreId', () => {
    const tool = new VertexAiSearchTool({dataStoreId: 'ds'});
    expect(tool.dataStoreId).toBe('ds');
    expect(tool.searchEngineId).toBeUndefined();
  });

  it('should initialize correctly with searchEngineId', () => {
    const tool = new VertexAiSearchTool({searchEngineId: 'se'});
    expect(tool.searchEngineId).toBe('se');
    expect(tool.dataStoreId).toBeUndefined();
  });

  it('should add vertexAiSearch config to llmRequest for Gemini model', async () => {
    const tool = new VertexAiSearchTool({
      dataStoreId: 'ds',
      filter: 'f',
      maxResults: 10,
    });
    const llmRequest = makeLlmRequest('gemini-2.0-flash');
    const toolContext = {} as Context;

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.tools).toHaveLength(1);
    expect(
      (llmRequest.config?.tools?.[0] as unknown as TestTool).retrieval
        ?.vertexAiSearch,
    ).toEqual({
      datastore: 'ds',
      dataStoreSpecs: undefined,
      engine: undefined,
      filter: 'f',
      maxResults: 10,
    });
  });

  it('should throw error for Gemini 1.x if other tools are present and bypass is false', async () => {
    const tool = new VertexAiSearchTool({dataStoreId: 'ds'});
    const llmRequest = makeLlmRequest('gemini-1.5-pro', {
      tools: [{functionDeclarations: []}],
    });
    const toolContext = {} as Context;

    await expect(
      tool.processLlmRequest({toolContext, llmRequest}),
    ).rejects.toThrowError(
      'Vertex AI search tool cannot be used with other tools in Gemini 1.x.',
    );
  });

  it('should not throw error for Gemini 1.x if other tools are present and bypass is true', async () => {
    const tool = new VertexAiSearchTool({
      dataStoreId: 'ds',
      bypassMultiToolsLimit: true,
    });
    const llmRequest = makeLlmRequest('gemini-1.5-pro', {
      tools: [{functionDeclarations: []}],
    });
    const toolContext = {} as Context;

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.tools).toHaveLength(2);
  });

  it('should throw error for non-Gemini model', async () => {
    const tool = new VertexAiSearchTool({dataStoreId: 'ds'});
    const llmRequest = makeLlmRequest('claude-3');
    const toolContext = {} as Context;

    await expect(
      tool.processLlmRequest({toolContext, llmRequest}),
    ).rejects.toThrowError(
      'Vertex AI search tool is not supported for model claude-3',
    );
  });

  describe('with env override', () => {
    const originalEnv = process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK;
      } else {
        process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK = originalEnv;
      }
    });

    it('should bypass model check if ADK_DISABLE_GEMINI_MODEL_ID_CHECK is true', async () => {
      process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK = 'true';
      const tool = new VertexAiSearchTool({dataStoreId: 'ds'});
      const llmRequest = makeLlmRequest('claude-3');
      const toolContext = {} as Context;

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.config?.tools).toHaveLength(1);
    });
  });
});
