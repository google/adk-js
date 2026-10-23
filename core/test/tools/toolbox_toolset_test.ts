/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  FunctionTool,
  isBaseToolset,
  isFunctionTool,
  isToolboxTool,
  isToolboxToolset,
  ReadonlyContext,
  ToolboxLoadOptions,
  ToolboxToolset,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v4';

describe('ToolboxToolset', () => {
  const emptyContext = {} as Context;
  const readonlyContext = {} as ReadonlyContext;

  it('identifies ToolboxToolset instances via isToolboxToolset and isBaseToolset', () => {
    const toolset = new ToolboxToolset({
      serverUrl: 'http://127.0.0.1:5000',
      toolsetName: 'hotels',
    });

    expect(isToolboxToolset(toolset)).toBe(true);
    expect(isBaseToolset(toolset)).toBe(true);
    expect(isToolboxToolset(toolset.serverUrl)).toBe(false);
    expect(isToolboxToolset({})).toBe(false);
    expect(isToolboxToolset(null)).toBe(false);
    expect(isToolboxToolset(undefined)).toBe(false);
  });

  it('throws when both toolsetName and toolNames are omitted or empty', () => {
    expect(
      () =>
        new ToolboxToolset({
          serverUrl: 'http://127.0.0.1:5000',
        }),
    ).toThrow('toolNames and toolsetName cannot both be undefined.');

    expect(
      () =>
        new ToolboxToolset('http://127.0.0.1:5000', {
          toolNames: [],
        }),
    ).toThrow('toolNames and toolsetName cannot both be undefined.');
  });

  it('loads toolset and individual tools asynchronously with authTokenGetters and boundParams', async () => {
    const authTokenGetters = {
      my_auth: () => 'bearer-token-123',
    };
    const boundParams = {
      tenantId: 'tenant-42',
    };

    async function bookHotel(input: unknown): Promise<string> {
      const args = input as Record<string, unknown>;
      return `booked:${String(args['hotelId'])}`;
    }

    const loadToolset = vi.fn(
      async (setName: string, options?: ToolboxLoadOptions) => {
        expect(options).toEqual({authTokenGetters, boundParams});
        return [
          bookHotel,
          {
            name: `${setName}_list`,
            description: 'Lists hotels.',
            parameters: z.object({city: z.string()}),
            execute: async ({city}: {city: string}) => `hotels:${city}`,
          },
        ];
      },
    );

    const loadTool = vi.fn(
      async (toolName: string, options?: ToolboxLoadOptions) => {
        expect(options).toEqual({authTokenGetters, boundParams});
        return {
          name: toolName,
          description: `Loaded ${toolName}`,
          execute: async (args: Record<string, unknown>) =>
            `canceled:${String(args['bookingId'])}`,
        };
      },
    );

    const close = vi.fn(async () => {});

    const toolset = new ToolboxToolset({
      serverUrl: 'http://127.0.0.1:5000',
      toolsetName: 'hotels',
      toolNames: ['cancel_booking'],
      authTokenGetters,
      boundParams,
      client: {
        loadToolset,
        loadTool,
        close,
      },
    });

    const tools = await toolset.getTools(readonlyContext);
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual([
      'bookHotel',
      'hotels_list',
      'cancel_booking',
    ]);
    expect(isFunctionTool(tools[0])).toBe(true);
    expect(isFunctionTool(tools[1])).toBe(true);
    expect(isFunctionTool(tools[2])).toBe(true);

    expect(loadToolset).toHaveBeenCalledWith('hotels', {
      authTokenGetters,
      boundParams,
    });
    expect(loadTool).toHaveBeenCalledWith('cancel_booking', {
      authTokenGetters,
      boundParams,
    });

    expect(
      await tools[0].runAsync({
        args: {hotelId: 'h-1'},
        toolContext: emptyContext,
      }),
    ).toBe('booked:h-1');
    expect(
      await tools[1].runAsync({
        args: {city: 'Zurich'},
        toolContext: emptyContext,
      }),
    ).toBe('hotels:Zurich');
    expect(
      await tools[2].runAsync({
        args: {bookingId: 'b-9'},
        toolContext: emptyContext,
      }),
    ).toBe('canceled:b-9');

    await toolset.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('supports snake_case client methods, prefix, and toolFilter', async () => {
    const existingTool = new FunctionTool({
      name: 'pre_wrapped',
      description: 'Already wrapped tool',
      execute: () => 'wrapped_ok',
    });

    function rawFunctionTool() {
      return 'raw_fn_ok';
    }

    const toolset = new ToolboxToolset('http://127.0.0.1:5000', {
      toolsetName: 'travel',
      toolNames: ['single_op'],
      prefix: 'tbx',
      toolFilter: ['tbx_pre_wrapped', 'tbx_single_op'],
      client: {
        load_toolset: async () => [existingTool, rawFunctionTool],
        load_tool: async (name: string) => ({
          name,
          description: 'Single tool',
          execute: () => 'single_ok',
        }),
      },
    });

    const filteredTools = await toolset.getTools(readonlyContext);
    expect(filteredTools.map((t) => t.name)).toEqual([
      'tbx_pre_wrapped',
      'tbx_single_op',
    ]);

    const predicateToolset = new ToolboxToolset({
      serverUrl: 'http://127.0.0.1:5000',
      toolNames: ['allowed_tool', 'blocked_tool'],
      toolFilter: (tool) => tool.name === 'allowed_tool',
      client: {
        loadTool: async (name: string) => ({
          name,
          description: 'Predicate tested tool',
          execute: () => name,
        }),
      },
    });

    const predicateTools = await predicateToolset.getTools(readonlyContext);
    expect(predicateTools.map((t) => t.name)).toEqual(['allowed_tool']);
  });

  it('throws descriptive errors when client or loader methods are missing', async () => {
    const unconfigured = new ToolboxToolset({
      serverUrl: 'http://127.0.0.1:5000',
      toolsetName: 'hotels',
    });
    await expect(unconfigured.getTools()).rejects.toThrow(
      /ToolboxToolsetClientLike/,
    );
    await expect(unconfigured.close()).resolves.toBeUndefined();

    const missingToolsetLoader = new ToolboxToolset({
      serverUrl: 'http://127.0.0.1:5000',
      toolsetName: 'hotels',
      client: {},
    });
    await expect(missingToolsetLoader.getTools()).rejects.toThrow(
      /loadToolset or load_toolset/,
    );

    const missingToolLoader = new ToolboxToolset({
      serverUrl: 'http://127.0.0.1:5000',
      toolNames: ['book_hotel'],
      client: {},
    });
    await expect(missingToolLoader.getTools()).rejects.toThrow(
      /loadTool or load_tool/,
    );
  });

  it('throws a TypeError when a loaded tool does not match supported shapes', async () => {
    const invalidToolset = new ToolboxToolset({
      serverUrl: 'http://127.0.0.1:5000',
      toolNames: ['invalid_tool'],
      client: {
        loadTool: async (name: string) =>
          ({
            name,
            description: 'Unsupported tool with only invoke methods',
            _run: () => 'unsupported',
          }) as unknown as FunctionTool,
      },
    });

    await expect(invalidToolset.getTools()).rejects.toThrow(TypeError);
    await expect(invalidToolset.getTools()).rejects.toThrow(
      /Unsupported Toolbox tool shape/,
    );
  });

  it('marks every loaded tool for isToolboxTool without changing client tools', async () => {
    const clientTool = new FunctionTool({
      name: 'pre_wrapped',
      description: 'Already wrapped tool',
      execute: () => 'wrapped_ok',
    });
    function rawFunctionTool() {
      return 'raw_fn_ok';
    }
    const client = {
      loadToolset: async () => [clientTool, rawFunctionTool],
      loadTool: async (name: string) => ({
        name,
        description: 'Single tool',
        execute: () => 'single_ok',
      }),
    };

    for (const prefix of [undefined, 'tbx']) {
      const tools = await new ToolboxToolset({
        serverUrl: 'http://127.0.0.1:5000',
        toolsetName: 'travel',
        toolNames: ['single_op'],
        prefix,
        client,
      }).getTools(readonlyContext);

      expect(tools).toHaveLength(3);
      expect(tools.map((tool) => isToolboxTool(tool))).toEqual([
        true,
        true,
        true,
      ]);
      if (prefix) {
        expect(tools[0]).not.toBe(clientTool);
      } else {
        expect(tools[0]).toBe(clientTool);
      }
      expect(
        await tools[0].runAsync({args: {}, toolContext: emptyContext}),
      ).toBe('wrapped_ok');
    }

    expect(clientTool.name).toBe('pre_wrapped');
    expect(isToolboxTool(null)).toBe(false);
    expect(isToolboxTool(undefined)).toBe(false);
    expect(isToolboxTool({})).toBe(false);
  });

  it('returns an unprefixed client BaseTool as is, keeping private and accumulated state', async () => {
    class StatefulTool extends BaseTool {
      #calls = 0;
      constructor() {
        super({name: 'stateful', description: 'Counts its calls.'});
      }
      override async runAsync(): Promise<unknown> {
        this.#calls += 1;
        return this.#calls;
      }
    }
    const clientTool = new StatefulTool();
    const toolset = new ToolboxToolset({
      serverUrl: 'http://127.0.0.1:5000',
      toolNames: ['stateful'],
      client: {
        loadToolset: async () => [],
        loadTool: async () => clientTool,
      },
    });

    const run = async () => {
      const [tool] = await toolset.getTools(readonlyContext);
      expect(tool).toBe(clientTool);
      expect(isToolboxTool(tool)).toBe(true);
      return tool.runAsync({args: {}, toolContext: emptyContext});
    };

    expect(await run()).toBe(1);
    expect(await run()).toBe(2);
  });

  it('test_toolbox_toolset_delegates_typed_lifecycle', async () => {
    const dummyTool = new FunctionTool({
      name: 'search',
      description: 'Search tool',
      execute: () => 'ok',
    });
    const loadTool = vi.fn(async () => dummyTool);
    const close = vi.fn(async () => {});

    const toolset = new ToolboxToolset({
      serverUrl: 'https://toolbox.example',
      toolNames: ['search'],
      client: {
        loadTool,
        close,
      },
    });

    const tools = await toolset.getTools(readonlyContext);
    await toolset.close();

    expect(tools).toEqual([dummyTool]);
    expect(loadTool).toHaveBeenCalledWith('search', {
      authTokenGetters: {},
      boundParams: {},
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
