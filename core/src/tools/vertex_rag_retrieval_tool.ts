/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig, VertexRagStore} from '@google/genai';

import {BaseTool, ToolProcessLlmRequest} from './base_tool.js';

/**
 * A tool that retrieves relevant content from a Vertex AI RAG corpus to ground
 * model responses.
 *
 * This tool operates server-side; it modifies the LLM request config to enable
 * RAG retrieval via the `retrieval.vertexRagStore` field and does not perform
 * local code execution.
 *
 * **Note:** The Vertex AI RAG Engine only supports one corpus per
 * `ragResources` array. Create one `VertexRagRetrievalTool` instance per
 * corpus.
 *
 * @example
 * ```ts
 * import { VertexRagRetrievalTool } from '@google/adk';
 * import { VertexRagStore } from '@google/genai';
 *
 * const ragTool = new VertexRagRetrievalTool({
 *   ragResources: [{ragCorpus: 'projects/my-project/locations/us-central1/ragCorpora/my-corpus'}],
 *   similarityTopK: 5,
 * });
 *
 * const agent = new LlmAgent({ tools: [ragTool], ... });
 * ```
 */
export class VertexRagRetrievalTool extends BaseTool {
  private readonly vertexRagStore: VertexRagStore;

  constructor(config: VertexRagStore) {
    super({
      name: 'vertex_rag_retrieval',
      description: 'Vertex AI RAG Retrieval Tool',
    });
    this.vertexRagStore = config;
  }

  /**
   * This tool is executed server-side by the Vertex AI RAG Engine.
   * Local execution is not required.
   */
  runAsync(): Promise<unknown> {
    return Promise.resolve();
  }

  override async processLlmRequest({
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    llmRequest.config = llmRequest.config || ({} as GenerateContentConfig);
    llmRequest.config.tools = llmRequest.config.tools || [];

    llmRequest.config.tools.push({
      retrieval: {vertexRagStore: this.vertexRagStore},
    });
  }
}
