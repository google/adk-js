/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retrieval tools
 * ../../../docs/guides/tools/retrieval/llama_index_retrieval/index.md
 *
 * A grounded question-answering agent built on `LlamaIndexRetrieval`. The tool
 * turns one natural-language `query` into one string of retrieved text, and the
 * framework runs it client-side, so the model never sees the corpus — only the
 * chunk the retriever picked.
 *
 * `LlamaIndexRetrieval` takes any object with a `retrieve(query)` method, which
 * is why this sample can ship a corpus in the file instead of an index: the
 * `llamaindex` package is an optional peer dependency, and nothing in
 * `LlamaIndexRetrieval` imports it. `FilesRetrieval` is the subclass that does
 * need it, and it is wired up below behind an environment variable so that the
 * sample still runs when it is absent.
 *
 * Note that the tool answers with the text of the single highest-scoring node,
 * matching adk-python. A retriever that returns its results unsorted therefore
 * decides the answer by accident, so `KeywordRetriever` sorts.
 *
 * REQUIRES an API key (the agent calls a live model). Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/tools/retrieval/agent.ts
 * Try "how long do I have to file an expense report?".
 *
 * The `FilesRetrieval` half indexes `documents/`, which ships with the sample,
 * so there is nothing to set up. It needs two optional peer dependencies and
 * an embedding model; without them it is skipped with a note and the rest of
 * the sample still runs:
 *   npm install llamaindex @llamaindex/readers
 * Point ADK_SAMPLE_DOCS_DIR elsewhere to index your own files instead.
 */

import {
  FilesRetrieval,
  LlamaIndexNodeWithScore,
  LlamaIndexRetrieval,
  LlamaIndexRetriever,
  LlmAgent,
  ToolUnion,
} from '@google/adk';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

/** Stands in for an indexed corpus, so the sample needs no vector store. */
const HANDBOOK: readonly string[] = [
  'Expenses: file an expense report within 30 days of the purchase. Reports ' +
    'filed later need a written approval from your manager.',
  'Travel: book flights through the corporate portal. Economy is the default ' +
    'cabin; premium cabins need approval before booking.',
  'Equipment: laptops are replaced every three years. Request a replacement ' +
    'through the IT portal, not through an expense report.',
];

/**
 * The smallest thing that satisfies `LlamaIndexRetriever`: term overlap in
 * place of embeddings. A real retriever comes from
 * `VectorStoreIndex.fromDocuments(...).asRetriever()`, and the tool cannot tell
 * the difference, because it only calls `retrieve`.
 */
class KeywordRetriever implements LlamaIndexRetriever {
  constructor(private readonly chunks: readonly string[]) {}

  async retrieve(query: string): Promise<LlamaIndexNodeWithScore[]> {
    const terms = query.toLowerCase().match(/[a-z]{4,}/g) ?? [];
    return this.chunks
      .map((text) => {
        const haystack = text.toLowerCase();
        return {
          node: {text},
          score: terms.filter((term) => haystack.includes(term)).length,
        };
      })
      .sort((a, b) => b.score - a.score);
  }
}

const handbookRetrieval = new LlamaIndexRetrieval({
  // The name and description are what the model routes on: they become the
  // function declaration, whose only argument is the `query` string that
  // BaseRetrievalTool declares for every retrieval tool.
  name: 'employee_handbook',
  description:
    'Looks up company policy on expenses, travel, and equipment in the ' +
    'employee handbook.',
  retriever: new KeywordRetriever(HANDBOOK),
});

const tools: ToolUnion[] = [handbookRetrieval];

// `FilesRetrieval.create` reads a directory and builds the index, both of which
// are asynchronous in LlamaIndexTS — hence the static factory rather than the
// constructor adk-python uses.
//
// The directory ships with the sample, so there is nothing to set up. Point
// ADK_SAMPLE_DOCS_DIR somewhere else to index your own files instead.
const docsDir =
  process.env.ADK_SAMPLE_DOCS_DIR ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'documents');

// Optional, and the sample runs either way. `llamaindex` and
// `@llamaindex/readers` are peer dependencies of `FilesRetrieval` rather than
// of `@google/adk`, so this half activates when they are installed and is
// skipped with a note when they are not. Failing the whole sample over an
// optional package would make the interesting half unreachable.
try {
  tools.push(
    await FilesRetrieval.create({
      name: 'local_docs',
      description:
        'Searches the onboarding, remote work, and security documents.',
      inputDir: docsDir,
    }),
  );
} catch (e) {
  console.log(
    `[sample] local_docs is off: ${(e as Error).message}\n` +
      '[sample] install it with: npm install llamaindex @llamaindex/readers',
  );
}

export const rootAgent = new LlmAgent({
  name: 'handbook_assistant',
  model: 'gemini-flash-latest',
  description: 'Answers policy questions from retrieved documents.',
  instruction:
    'Answer questions about company policy. Call a retrieval tool before ' +
    'answering, and base the answer only on the text it returns. Say that you ' +
    'do not know when the retrieved text does not cover the question.',
  tools,
});
