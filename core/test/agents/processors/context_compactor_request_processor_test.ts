/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseContextCompactor,
  BaseLlm,
  BaseLlmConnection,
  ContextCompactorRequestProcessor,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LlmSummarizer,
  TokenBasedContextCompactor,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ContextCompactionTrigger} from '../../../src/plugins/base_plugin.js';
import {logger} from '../../../src/utils/logger.js';

describe('ContextCompactorRequestProcessor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should run compactors in order and stop after first compaction', async () => {
    const mockPluginManager = {
      runBeforeContextCompaction: vi.fn().mockResolvedValue(undefined),
      runAfterContextCompaction: vi.fn().mockResolvedValue(undefined),
    };
    const mockCtx = {
      session: {
        events: [],
      },
      pluginManager: mockPluginManager,
    } as unknown as InvocationContext;
    const mockReq = {} as LlmRequest;

    const compactor1: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(false),
      compact: vi.fn(),
    };

    const compactor2: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(true),
      compact: vi.fn(),
    };

    const compactor3: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(true),
      compact: vi.fn(),
    };

    const processor = new ContextCompactorRequestProcessor([
      compactor1,
      compactor2,
      compactor3,
    ]);

    const generator = processor.runAsync(mockCtx, mockReq);
    for await (const _ of generator) {
      // iterate
    }

    expect(compactor1.shouldCompact).toHaveBeenCalledWith(mockCtx);
    expect(compactor1.compact).not.toHaveBeenCalled();

    expect(compactor2.shouldCompact).toHaveBeenCalledWith(mockCtx);
    expect(compactor2.compact).toHaveBeenCalledWith(mockCtx);

    expect(compactor3.shouldCompact).not.toHaveBeenCalled();
    expect(compactor3.compact).not.toHaveBeenCalled();

    expect(mockPluginManager.runBeforeContextCompaction).toHaveBeenCalledWith({
      invocationContext: mockCtx,
      trigger: ContextCompactionTrigger.Auto,
    });

    expect(mockPluginManager.runAfterContextCompaction).toHaveBeenCalledWith({
      invocationContext: mockCtx,
      trigger: ContextCompactionTrigger.Auto,
    });
  });

  it('logs a failed compaction and keeps the uncompacted history', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const mockPluginManager = {
      runBeforeContextCompaction: vi.fn().mockResolvedValue(undefined),
      runAfterContextCompaction: vi.fn().mockResolvedValue(undefined),
    };
    const mockCtx = {
      session: {events: []},
      pluginManager: mockPluginManager,
    } as unknown as InvocationContext;
    const error = new Error('429 RESOURCE_EXHAUSTED');
    const compactor: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(true),
      compact: vi.fn().mockRejectedValue(error),
    };

    const yielded = [];
    for await (const event of new ContextCompactorRequestProcessor([
      compactor,
    ]).runAsync(mockCtx, {} as LlmRequest)) {
      yielded.push(event);
    }

    expect(yielded).toEqual([]);
    expect(mockPluginManager.runAfterContextCompaction).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Context compaction failed; continuing with the uncompacted history.',
      error,
    );
  });

  it('still ends the run when it is aborted during compaction', async () => {
    const controller = new AbortController();
    const reason = new Error('aborted');
    const mockCtx = {
      session: {events: []},
      pluginManager: {
        runBeforeContextCompaction: vi.fn().mockResolvedValue(undefined),
        runAfterContextCompaction: vi.fn().mockResolvedValue(undefined),
      },
      abortSignal: controller.signal,
    } as unknown as InvocationContext;
    const compactor: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(true),
      compact: vi.fn(async () => {
        controller.abort(reason);
        throw reason;
      }),
    };

    const run = async () => {
      for await (const _ of new ContextCompactorRequestProcessor([
        compactor,
      ]).runAsync(mockCtx, {} as LlmRequest)) {
        // iterate
      }
    };

    await expect(run()).rejects.toBe(reason);
  });

  it('answers the turn when the summarizer model call fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    class StubLlm extends BaseLlm {
      constructor(private readonly fail: boolean) {
        super({model: fail ? 'summarizer' : 'agent'});
      }
      async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
        if (this.fail) {
          throw new Error('429 RESOURCE_EXHAUSTED');
        }
        yield {
          content: {role: 'model', parts: [{text: 'an answer'}]},
          usageMetadata: {promptTokenCount: 5000},
        };
      }
      async connect(): Promise<BaseLlmConnection> {
        throw new Error('not used');
      }
    }
    const runner = new InMemoryRunner({
      agent: new LlmAgent({
        name: 'assistant',
        model: new StubLlm(false),
        contextCompactors: [
          new TokenBasedContextCompactor({
            tokenThreshold: 1000,
            eventRetentionSize: 1,
            summarizer: new LlmSummarizer({llm: new StubLlm(true)}),
          }),
        ],
      }),
      appName: 'test_app',
    });
    const session = await runner.sessionService.createSession({
      appName: 'test_app',
      userId: 'user',
    });

    const replies: Array<string | undefined> = [];
    // The second turn is over the token threshold, so it compacts first.
    for (const text of ['first question', 'second question']) {
      for await (const event of runner.runAsync({
        userId: 'user',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text}]},
      })) {
        replies.push(event.content?.parts?.[0]?.text);
      }
    }

    expect(replies).toEqual(['an answer', 'an answer']);
    expect(warn).toHaveBeenCalledWith(
      'Context compaction failed; continuing with the uncompacted history.',
      expect.objectContaining({message: '429 RESOURCE_EXHAUSTED'}),
    );
  });
});
