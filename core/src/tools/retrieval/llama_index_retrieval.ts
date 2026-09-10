/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RunAsyncToolRequest} from '../base_tool.js';
import {BaseRetrievalTool} from './base_retrieval_tool.js';

/**
 * The part of LlamaIndexTS's `BaseNode` this tool reads.
 *
 * A vector retriever returns `TextNode`s, which carry the chunk text on
 * `text`. The interface is structural so that `llamaindex` stays an optional
 * dependency — nothing here imports it, matching how adk-python keeps the
 * import under `TYPE_CHECKING`.
 */
export interface LlamaIndexNode {
  /** The chunk text. */
  text?: string;
}

/** LlamaIndexTS's `NodeWithScore`. */
export interface LlamaIndexNodeWithScore {
  node: LlamaIndexNode;
  score?: number;
}

/**
 * The part of LlamaIndexTS's `BaseRetriever` this tool calls.
 *
 * `retrieve` accepts a `QueryType`, which includes a plain string, so passing
 * the model's `query` argument straight through matches adk-python.
 */
export interface LlamaIndexRetriever {
  retrieve(query: string): Promise<LlamaIndexNodeWithScore[]>;
}

/** Parameters for the `LlamaIndexRetrieval` constructor. */
export interface LlamaIndexRetrievalParams {
  name: string;
  description: string;
  retriever: LlamaIndexRetriever;
}

/**
 * A retrieval tool backed by a LlamaIndex retriever.
 *
 * Answers with the text of the single highest-scoring node, as adk-python
 * does.
 *
 * Ported from adk-python
 * `src/google/adk/tools/retrieval/llama_index_retrieval.py` at ref `v0.1.0`.
 *
 * @example
 * ```ts
 * const tool = new LlamaIndexRetrieval({
 *   name: 'docs',
 *   description: 'Company documentation.',
 *   retriever: index.asRetriever(),
 * });
 * ```
 */
export class LlamaIndexRetrieval extends BaseRetrievalTool {
  readonly retriever: LlamaIndexRetriever;

  constructor(params: LlamaIndexRetrievalParams) {
    super({name: params.name, description: params.description});
    this.retriever = params.retriever;
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const nodes = await this.retriever.retrieve(String(args['query'] ?? ''));

    // adk-python indexes `[0]` unguarded and raises `IndexError` on an empty
    // result. The same case is an error here; only the message differs, since
    // an unguarded index would surface as a bare `TypeError`.
    const top = nodes[0];
    if (!top) {
      throw new Error(`${this.name} retrieved no results for the query.`);
    }
    return top.node.text;
  }
}
