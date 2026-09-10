/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  LlamaIndexNodeWithScore,
  LlamaIndexRetrieval,
  LlamaIndexRetriever,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A stand-in for a LlamaIndexTS retriever, recording what it was asked. */
class FakeRetriever implements LlamaIndexRetriever {
  readonly queries: string[] = [];

  constructor(private readonly texts: string[]) {}

  async retrieve(query: string): Promise<LlamaIndexNodeWithScore[]> {
    this.queries.push(query);
    return this.texts.map((text, index) => ({
      node: {text},
      score: 1 - index / 10,
    }));
  }
}

function makeTool(retriever: LlamaIndexRetriever): LlamaIndexRetrieval {
  return new LlamaIndexRetrieval({
    name: 'docs',
    description: 'Company documentation.',
    retriever,
  });
}

const TOOL_CONTEXT = {} as Context;

describe('LlamaIndexRetrieval', () => {
  it('returns the text of the top-scoring node', async () => {
    const tool = makeTool(new FakeRetriever(['best', 'second', 'third']));

    const result = await tool.runAsync({
      args: {query: 'what is the policy'},
      toolContext: TOOL_CONTEXT,
    });

    expect(result).toBe('best');
  });

  it('passes the query argument straight to the retriever', async () => {
    const retriever = new FakeRetriever(['best']);

    await makeTool(retriever).runAsync({
      args: {query: 'what is the policy'},
      toolContext: TOOL_CONTEXT,
    });

    expect(retriever.queries).toEqual(['what is the policy']);
  });

  it('exposes the retriever it was built with', () => {
    const retriever = new FakeRetriever(['best']);

    expect(makeTool(retriever).retriever).toBe(retriever);
  });

  it('inherits the `query` declaration from BaseRetrievalTool', () => {
    const declaration = makeTool(new FakeRetriever(['best']))._getDeclaration();

    expect(declaration.name).toBe('docs');
    expect(declaration.parameters?.properties).toHaveProperty('query');
  });

  // adk-python indexes `[0]` unguarded, so an empty retrieval raises there
  // too; only the error type differs.
  it('reports an empty retrieval rather than returning undefined', async () => {
    const tool = makeTool(new FakeRetriever([]));

    await expect(
      tool.runAsync({
        args: {query: 'nothing matches'},
        toolContext: TOOL_CONTEXT,
      }),
    ).rejects.toThrow('docs retrieved no results');
  });

  it('treats a missing query argument as the empty query', async () => {
    const retriever = new FakeRetriever(['best']);

    await makeTool(retriever).runAsync({args: {}, toolContext: TOOL_CONTEXT});

    expect(retriever.queries).toEqual(['']);
  });
});
