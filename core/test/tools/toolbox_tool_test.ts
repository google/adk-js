/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  isLangchainTool,
  isToolboxTool,
  ToolboxTool,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v4';

describe('ToolboxTool', () => {
  const emptyContext = {} as Context;

  it('identifies ToolboxTool instances via isToolboxTool', () => {
    const toolbox = new ToolboxTool('http://127.0.0.1:8080');
    expect(isToolboxTool(toolbox)).toBe(true);
    expect(isToolboxTool(toolbox.url)).toBe(false);
    expect(isToolboxTool({})).toBe(false);
    expect(isToolboxTool(null)).toBe(false);
    expect(isToolboxTool(undefined)).toBe(false);
  });

  it('loads single tools and toolsets as LangchainTool instances using camelCase client methods', async () => {
    const loadTool = vi.fn((toolName: string) => ({
      name: toolName,
      description: `Loaded ${toolName}`,
      schema: z.object({hotelId: z.string()}),
      _run: async ({hotelId}: Record<string, unknown>) =>
        `booked:${toolName}:${hotelId}`,
    }));
    const loadToolset = vi.fn((toolsetName: string) => [
      {
        name: `${toolsetName}_search`,
        description: 'Search tool',
        _run: async () => 'search_ok',
      },
      {
        name: `${toolsetName}_cancel`,
        description: 'Cancel tool',
        _run: async () => 'cancel_ok',
      },
    ]);

    const toolbox = new ToolboxTool({
      url: 'http://127.0.0.1:8080',
      client: {loadTool, loadToolset},
    });

    const singleTool = toolbox.getTool('book_hotel');
    expect(isLangchainTool(singleTool)).toBe(true);
    expect(singleTool.name).toBe('book_hotel');
    expect(loadTool).toHaveBeenCalledWith('book_hotel');

    const result = await singleTool.runAsync({
      args: {hotelId: 'h-42'},
      toolContext: emptyContext,
    });
    expect(result).toBe('booked:book_hotel:h-42');

    const toolset = toolbox.getToolset('hotels');
    expect(toolset).toHaveLength(2);
    expect(toolset.every((t) => isLangchainTool(t))).toBe(true);
    expect(toolset.map((t) => t.name)).toEqual([
      'hotels_search',
      'hotels_cancel',
    ]);
    expect(loadToolset).toHaveBeenCalledWith('hotels');
  });

  it('supports snake_case load_tool and load_toolset client methods and throws on missing client methods', () => {
    const toolboxSnake = new ToolboxTool({
      url: 'http://127.0.0.1:8080',
      client: {
        load_tool: (name: string) => ({
          name,
          description: 'snake tool',
          _run: () => 'ok',
        }),
        load_toolset: (setName: string) => [
          {
            name: `${setName}_item`,
            description: 'snake toolset item',
            _run: () => 'ok',
          },
        ],
      },
    });

    expect(toolboxSnake.getTool('snake_single').name).toBe('snake_single');
    expect(toolboxSnake.getToolset('snake_set')[0].name).toBe('snake_set_item');

    const unconfiguredToolbox = new ToolboxTool('http://127.0.0.1:8080');
    expect(() => unconfiguredToolbox.getTool('any_tool')).toThrow(
      /ToolboxClientLike/,
    );
    expect(() => unconfiguredToolbox.getToolset('any_set')).toThrow(
      /ToolboxClientLike/,
    );

    const emptyClientToolbox = new ToolboxTool({client: {}});
    expect(() => emptyClientToolbox.getTool('any_tool')).toThrow(
      /loadTool or load_tool/,
    );
    expect(() => emptyClientToolbox.getToolset('any_set')).toThrow(
      /loadToolset or load_toolset/,
    );
  });
});
