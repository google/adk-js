/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig, VertexRagStore} from '@google/genai';

import {ToolProcessLlmRequest} from './base_tool.js';
import {BuiltInTool} from './built_in_tool.js';

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
 * import {LlmAgent, VertexRagRetrievalTool} from '@google/adk';
 *
 * const ragTool = new VertexRagRetrievalTool({
 *   ragResources: [
 *     {ragCorpus: 'projects/my-project/locations/us-central1/ragCorpora/my-corpus'},
 *   ],
 *   similarityTopK: 5,
 * });
 *
 * const agent = new LlmAgent({
 *   name: 'rag_agent',
 *   model: 'gemini-2.5-flash',
 *   tools: [ragTool],
 * });
 * ```
 */
export class VertexRagRetrievalTool extends BuiltInTool {
  private readonly vertexRagStore: VertexRagStore;

  constructor(config: VertexRagStore) {
    super({
      name: 'vertex_rag_retrieval',
      description: 'Vertex AI RAG Retrieval Tool',
    });
    this.vertexRagStore = config;
  }

  protected override async applyBuiltInConfig({
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    llmRequest.config = llmRequest.config || ({} as GenerateContentConfig);
    llmRequest.config.tools = llmRequest.config.tools || [];

    llmRequest.config.tools.push({
      retrieval: {vertexRagStore: this.vertexRagStore},
    });
  }
}
