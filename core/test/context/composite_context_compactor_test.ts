/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseContextCompactor,
  CompositeContextCompactor,
  InvocationContext,
  PluginManager,
  Session,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

function createDummyContext(): InvocationContext {
  const session = {
    id: 'session-1',
    appName: 'app',
    userId: 'user',
    state: {},
    events: [],
    lastUpdateTime: Date.now(),
  } as Session;

  const agent = {} as BaseAgent;
  return new InvocationContext({
    invocationId: 'inv-1',
    session,
    agent,
    pluginManager: {} as PluginManager,
  });
}

describe('CompositeContextCompactor', () => {
  it('should return false from shouldCompact if all children return false', async () => {
    const child1: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(false),
      compact: vi.fn(),
    };
    const child2: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(false),
      compact: vi.fn(),
    };

    const composite = new CompositeContextCompactor([child1, child2]);
    const ctx = createDummyContext();

    expect(await composite.shouldCompact(ctx)).toBe(false);
    expect(child1.shouldCompact).toHaveBeenCalledWith(ctx);
    expect(child2.shouldCompact).toHaveBeenCalledWith(ctx);
  });

  it('should return true from shouldCompact if at least one child returns true', async () => {
    const child1: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(false),
      compact: vi.fn(),
    };
    const child2: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(true),
      compact: vi.fn(),
    };

    const composite = new CompositeContextCompactor([child1, child2]);
    const ctx = createDummyContext();

    expect(await composite.shouldCompact(ctx)).toBe(true);
  });

  it('should run compactors in sequence if they still need compaction', async () => {
    const ctx = createDummyContext();

    const child1: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(true),
      compact: vi.fn().mockImplementation(() => {
        // Simulate changing context (e.g. removing some events)
        ctx.session.events = [];
      }),
    };
    // child2 shouldCompact will be evaluated AFTER child1 compact.
    // In this test, we make child2 still return true.
    const child2: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(true),
      compact: vi.fn(),
    };

    const composite = new CompositeContextCompactor([child1, child2]);

    await composite.compact(ctx);

    expect(child1.shouldCompact).toHaveBeenCalledWith(ctx);
    expect(child1.compact).toHaveBeenCalledWith(ctx);

    expect(child2.shouldCompact).toHaveBeenCalledWith(ctx);
    expect(child2.compact).toHaveBeenCalledWith(ctx);
  });

  it('should NOT run subsequent compactor if previous compactor resolved the need', async () => {
    const ctx = createDummyContext();

    const child1: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(true),
      compact: vi.fn(),
    };
    // child2 shouldCompact returns false when evaluated during compact phase.
    const child2: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(false),
      compact: vi.fn(),
    };

    const composite = new CompositeContextCompactor([child1, child2]);

    await composite.compact(ctx);

    expect(child1.shouldCompact).toHaveBeenCalledWith(ctx);
    expect(child1.compact).toHaveBeenCalledWith(ctx);

    expect(child2.shouldCompact).toHaveBeenCalledWith(ctx);
    expect(child2.compact).not.toHaveBeenCalled();
  });
});
