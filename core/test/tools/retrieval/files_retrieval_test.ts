/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  FilesRetrieval,
  LlamaIndexNodeWithScore,
  LlamaIndexRetrieval,
  LlamaIndexRetriever,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class FakeRetriever implements LlamaIndexRetriever {
  async retrieve(query: string): Promise<LlamaIndexNodeWithScore[]> {
    return [{node: {text: `answer to ${query}`}}];
  }
}

function makeTool(): FilesRetrieval {
  return new FilesRetrieval({
    name: 'docs',
    description: 'Company documentation.',
    inputDir: './docs',
    retriever: new FakeRetriever(),
  });
}

describe('FilesRetrieval', () => {
  it('is a LlamaIndexRetrieval that remembers its input directory', () => {
    const tool = makeTool();

    expect(tool).toBeInstanceOf(LlamaIndexRetrieval);
    expect(tool.inputDir).toBe('./docs');
    expect(tool.name).toBe('docs');
    expect(tool.description).toBe('Company documentation.');
  });

  it('retrieves through the retriever it was given', async () => {
    const result = await makeTool().runAsync({
      args: {query: 'the policy'},
      toolContext: {} as Context,
    });

    expect(result).toBe('answer to the policy');
  });

  // `llamaindex` and `@llamaindex/readers` are optional and not installed in
  // this repo, so `create` reaches its missing-dependency branch here. The
  // message has to name what to install, since the underlying resolver error
  // says only that a bare specifier could not be found.
  it('explains which optional package to install when one is missing', async () => {
    await expect(
      FilesRetrieval.create({
        name: 'docs',
        description: 'Company documentation.',
        inputDir: './docs',
      }),
    ).rejects.toThrow(/@llamaindex\/readers.*not installed/s);
  });
});
