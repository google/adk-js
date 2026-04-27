/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseContextCompactor,
  ContextCompactorRequestProcessor,
  InvocationContext,
  LlmRequest,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {ContextCompactionTrigger} from '../../../src/plugins/base_plugin.js';

describe('ContextCompactorRequestProcessor', () => {
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
});
