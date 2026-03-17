/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  Context,
  LlmRequest,
  MemoryEntry,
  PRELOAD_MEMORY,
  PreloadMemoryTool,
  SearchMemoryResponse,
} from '@google/adk';

// We mock the logger.warn since we test a failing case
import {vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

class StubToolContext {
  private memories: MemoryEntry[];

  constructor(memories: MemoryEntry[]) {
    this.memories = memories;
  }

  // Stub property needed to supply userContent
  userContent = {
    role: 'user',
    parts: [{text: 'hello'}],
  };

  invocationContext = {
    // Just needs to exist
    memoryService: {},
  };

  async searchMemory(_query: string): Promise<SearchMemoryResponse> {
    return {memories: this.memories};
  }
}

describe('PreloadMemoryTool', () => {
  it('has a global instance PRELOAD_MEMORY', () => {
    expect(PRELOAD_MEMORY).toBeInstanceOf(PreloadMemoryTool);
  });

  it('throws error   in runAsync as it is not meant to be called by model', async () => {
    const tool = new PreloadMemoryTool();
    const mockContext = new StubToolContext([]) as unknown as Context;

    await expect(
      tool.runAsync({
        args: {},
        toolContext: mockContext,
      }),
    ).rejects.toThrow('PreloadMemoryTool should not be called by model');
  });

  it('does not append instruction if userContent is empty', async () => {
    const toolContext = new StubToolContext([]) as unknown as Context;
    // empty content, get around read-only with a trip to types unknown
    (toolContext as unknown as {userContent: unknown}).userContent = undefined;

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    };
    const tool = new PreloadMemoryTool();
    await tool.processLlmRequest({toolContext, llmRequest});
    // System instructions should NOT be appended.
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('does not append instruction if memory service is missing', async () => {
    const toolContext = new StubToolContext([]) as unknown as Context;
    (toolContext.invocationContext as {memoryService?: unknown}).memoryService =
      undefined;

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    };
    const tool = new PreloadMemoryTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('appends system instructions with formatted memory if memories found', async () => {
    const toolContext = new StubToolContext([
      {
        content: {role: 'user', parts: [{text: 'My dog is Fido.'}]},
        author: 'user',
        timestamp: '2023-01-01T12:00:00Z',
      },
      {
        content: {role: 'model', parts: [{text: 'I will remember that.'}]},
        author: 'model',
      },
    ]) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    };
    const tool = new PreloadMemoryTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const instructions = llmRequest.config?.systemInstruction;
    expect(instructions).toBeDefined();

    // Verify it contains the formatted lines
    expect(instructions).toContain('Time: 2023-01-01T12:00:00Z');
    expect(instructions).toContain('user: My dog is Fido.');
    expect(instructions).toContain('model: I will remember that.');
    expect(instructions).toContain('<PAST_CONVERSATIONS>');
  });

  it('handles searchMemory throwing an error gracefully', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const toolContext = new StubToolContext([]) as unknown as Context;
    // Override searchMemory to throw
    toolContext.searchMemory = async () => {
      throw new Error('Search failed');
    };

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    };
    const tool = new PreloadMemoryTool();

    await expect(
      tool.processLlmRequest({toolContext, llmRequest}),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to preload memory for query: hello',
    );
    expect(llmRequest.config?.systemInstruction).toBeUndefined();

    warnSpy.mockRestore();
  });
});
