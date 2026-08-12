/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, LlmRequest, VertexRagRetrievalTool} from '@google/adk';
import {GenerateContentConfig, Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';

const RAG_CORPUS =
  'projects/my-project/locations/us-central1/ragCorpora/my-corpus';

/** An `LlmRequest` whose `config` is guaranteed present, so tests can index it. */
type LlmRequestWithConfig = LlmRequest & {config: GenerateContentConfig};

function makeLlmRequest(model = 'gemini-2.0-flash'): LlmRequestWithConfig {
  return {
    model,
    config: {},
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

// The tool only reads `llmRequest`; the context is never touched, so an empty
// stand-in is enough.
function makeToolContext(): Context {
  return {} as Context;
}

/**
 * `config.tools` is a `ToolUnion[]` (`Tool | CallableTool`); the tool under test
 * only ever pushes plain declarative `Tool`s, so narrow to that member.
 */
function toolAt(llmRequest: LlmRequestWithConfig, index: number): Tool {
  return llmRequest.config.tools![index] as Tool;
}

describe('VertexRagRetrievalTool', () => {
  describe('processLlmRequest', () => {
    it('adds retrieval.vertexRagStore to llmRequest.config.tools', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(llmRequest.config.tools).toHaveLength(1);
      expect(llmRequest.config.tools![0]).toEqual({
        retrieval: {
          vertexRagStore: {
            ragResources: [{ragCorpus: RAG_CORPUS}],
          },
        },
      });
    });

    it('passes through similarityTopK when provided', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
        similarityTopK: 10,
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      const vertexRagStore = toolAt(llmRequest, 0).retrieval!.vertexRagStore!;
      expect(vertexRagStore.similarityTopK).toBe(10);
    });

    it('passes through ragRetrievalConfig when provided', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
        ragRetrievalConfig: {filter: {vectorDistanceThreshold: 0.5}},
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      const vertexRagStore = toolAt(llmRequest, 0).retrieval!.vertexRagStore!;
      expect(
        vertexRagStore.ragRetrievalConfig?.filter?.vectorDistanceThreshold,
      ).toBe(0.5);
    });

    it('does not set optional fields when not provided', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      const vertexRagStore = toolAt(llmRequest, 0).retrieval!.vertexRagStore!;
      expect(vertexRagStore.similarityTopK).toBeUndefined();
      expect(vertexRagStore.ragRetrievalConfig).toBeUndefined();
    });

    it('initializes llmRequest.config and tools if not present', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const llmRequest: LlmRequest = {
        model: 'gemini-2.0-flash',
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(llmRequest.config?.tools).toHaveLength(1);
    });

    it('appends to existing tools without removing them', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const llmRequest = makeLlmRequest();
      llmRequest.config.tools = [{googleSearch: {}}];

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(llmRequest.config.tools).toHaveLength(2);
      expect(toolAt(llmRequest, 1).retrieval).toBeDefined();
    });
  });

  describe('runAsync', () => {
    it('resolves immediately (server-side tool)', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const result = await tool.runAsync();
      expect(result).toBeUndefined();
    });
  });
});
