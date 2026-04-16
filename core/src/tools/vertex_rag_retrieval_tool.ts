/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig, VertexRagStore} from '@google/genai';

import {BaseTool, ToolProcessLlmRequest} from './base_tool.js';

/**
 * Configuration for the {@link VertexRagRetrievalTool}.
 */
export interface VertexRagRetrievalToolConfig {
  /**
   * The resource name of the Vertex RAG corpus to retrieve from.
   * Format: `projects/{project}/locations/{location}/ragCorpora/{rag_corpus}`
   */
  ragCorpus: string;

  /**
   * Optional. The number of top results to return from the RAG corpus.
   * Corresponds to `VertexRagStore.similarityTopK`.
   */
  similarityTopK?: number;

  /**
   * Optional. The distance threshold below which results are excluded.
   * Corresponds to `VertexRagStore.ragRetrievalConfig.filter.vectorDistanceThreshold`.
   */
  vectorDistanceThreshold?: number;
}

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
 *
 * const ragTool = new VertexRagRetrievalTool({
 *   ragCorpus: 'projects/my-project/locations/us-central1/ragCorpora/my-corpus',
 *   similarityTopK: 5,
 * });
 *
 * const agent = new LlmAgent({ tools: [ragTool], ... });
 * ```
 */
export class VertexRagRetrievalTool extends BaseTool {
  private readonly ragCorpus: string;
  private readonly similarityTopK?: number;
  private readonly vectorDistanceThreshold?: number;

  constructor(config: VertexRagRetrievalToolConfig) {
    super({
      name: 'vertex_rag_retrieval',
      description: 'Vertex AI RAG Retrieval Tool',
    });
    this.ragCorpus = config.ragCorpus;
    this.similarityTopK = config.similarityTopK;
    this.vectorDistanceThreshold = config.vectorDistanceThreshold;
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

    const vertexRagStore: VertexRagStore = {
      ragResources: [{ragCorpus: this.ragCorpus}],
    };

    if (this.similarityTopK !== undefined) {
      vertexRagStore.similarityTopK = this.similarityTopK;
    }

    if (this.vectorDistanceThreshold !== undefined) {
      vertexRagStore.ragRetrievalConfig = {
        filter: {vectorDistanceThreshold: this.vectorDistanceThreshold},
      };
    }

    llmRequest.config.tools.push({
      retrieval: {vertexRagStore},
    });
  }
}
