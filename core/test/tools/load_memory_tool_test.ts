/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  Context,
  LlmRequest,
  LOAD_MEMORY,
  LoadMemoryTool,
  MemoryEntry,
  SearchMemoryResponse,
} from '@google/adk';

class StubToolContext {
  private memories: MemoryEntry[];

  constructor(memories: MemoryEntry[]) {
    this.memories = memories;
  }

  // Minimal stub properties needed to bypass initialized checks
  invocationContext = {
    // Just needs to exist
    memoryService: {},
  };

  async searchMemory(_query: string): Promise<SearchMemoryResponse> {
    return {memories: this.memories};
  }
}

describe('LoadMemoryTool', () => {
  it('computes the correct declaration', () => {
    const tool = new LoadMemoryTool();
    const declaration = tool._getDeclaration();

    expect(declaration?.name).toEqual('load_memory');
    expect(declaration?.description).toContain(
      'Loads the memory for the current user.',
    );
    expect(declaration?.parameters).toEqual({
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'The query to load the memory for.',
        },
      },
      required: ['query'],
    });
  });

  it('sets correct response on runAsync', async () => {
    const tool = new LoadMemoryTool();
    const mockContext = new StubToolContext([
      {
        content: {role: 'user', parts: [{text: 'hi'}]},
        author: 'someone',
      },
    ]) as unknown as Context;

    const result = await tool.runAsync({
      args: {query: 'hello'},
      toolContext: mockContext,
    });

    expect(result).toEqual({
      memories: [
        {
          content: 'hi',
          author: 'someone',
          timestamp: undefined,
        },
      ],
    });
  });

  it('has a global instance LOAD_MEMORY', () => {
    expect(LOAD_MEMORY).toBeInstanceOf(LoadMemoryTool);
  });

  it('throws error if memoryService is not initialized', async () => {
    const tool = new LoadMemoryTool();
    const mockContext = new StubToolContext([]) as unknown as Context;
    (mockContext.invocationContext as {memoryService?: unknown}).memoryService =
      undefined;

    await expect(
      tool.runAsync({
        args: {query: 'hello'},
        toolContext: mockContext,
      }),
    ).rejects.toThrow('Memory service is not initialized.');
  });

  it('does not append instruction if memoryService is missing in context', async () => {
    const toolContext = new StubToolContext([]) as unknown as Context;
    (toolContext.invocationContext as {memoryService?: unknown}).memoryService =
      undefined;

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const tool = new LoadMemoryTool();
    await tool.processLlmRequest({toolContext, llmRequest});
    // System instructions should NOT be appended.
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('appends system instructions if memoryService is present in context', async () => {
    const toolContext = new StubToolContext([]) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const tool = new LoadMemoryTool();
    await tool.processLlmRequest({toolContext, llmRequest});
    // Instructions should be appended
    expect(llmRequest.config?.systemInstruction).toContain('You have memory.');
  });
});
