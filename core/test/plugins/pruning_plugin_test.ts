/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BasePruner, BaseTool, Context, PruningPlugin} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

describe('PruningPlugin', () => {
  const mockPruner: BasePruner = {
    prune: vi.fn().mockImplementation(() => 'pruned_result'),
  };

  const mockTool = (name: string): BaseTool => {
    return {name} as BaseTool;
  };

  const mockContext = {} as Context;

  it('should return undefined if tool does not match rules', async () => {
    const plugin = new PruningPlugin({
      rules: [{toolName: 'matching_tool', pruner: mockPruner}],
    });

    const result = await plugin.afterToolCallback({
      tool: mockTool('other_tool'),
      toolArgs: {},
      toolContext: mockContext,
      result: {data: 'some data'},
    });

    expect(result).toBeUndefined();
    expect(mockPruner.prune).not.toHaveBeenCalled();
  });

  it('should return undefined if result is under threshold', async () => {
    const plugin = new PruningPlugin({
      rules: [{toolName: 'matching_tool', pruner: mockPruner}],
      sizeThreshold: 100,
    });

    const result = await plugin.afterToolCallback({
      tool: mockTool('matching_tool'),
      toolArgs: {},
      toolContext: mockContext,
      result: {data: 'short'},
    });

    expect(result).toBeUndefined();
    expect(mockPruner.prune).not.toHaveBeenCalled();
  });

  it('should return pruned result if over threshold', async () => {
    const plugin = new PruningPlugin({
      rules: [{toolName: 'matching_tool', pruner: mockPruner}],
      sizeThreshold: 10,
    });

    const result = await plugin.afterToolCallback({
      tool: mockTool('matching_tool'),
      toolArgs: {},
      toolContext: mockContext,
      result: {data: 'very_long_data_exceeding_threshold'},
    });

    expect(result).toBe('pruned_result');
    expect(mockPruner.prune).toHaveBeenCalledWith({
      data: 'very_long_data_exceeding_threshold',
    });
  });

  it('should return pruned result if no threshold specified', async () => {
    const plugin = new PruningPlugin({
      rules: [{toolName: 'matching_tool', pruner: mockPruner}],
    });

    const result = await plugin.afterToolCallback({
      tool: mockTool('matching_tool'),
      toolArgs: {},
      toolContext: mockContext,
      result: {data: 'any'},
    });

    expect(result).toBe('pruned_result');
  });

  it('should handle string results', async () => {
    const plugin = new PruningPlugin({
      rules: [{toolName: 'matching_tool', pruner: mockPruner}],
      sizeThreshold: 5,
    });

    const result = await plugin.afterToolCallback({
      tool: mockTool('matching_tool'),
      toolArgs: {},
      toolContext: mockContext,
      result: 'too_long' as unknown as Record<string, unknown>,
    });

    expect(result).toBe('pruned_result');
    expect(mockPruner.prune).toHaveBeenCalledWith('too_long');
  });
});
