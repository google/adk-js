/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {ReadonlyContext} from '../../../src/agents/readonly_context.js';
import {LlmRequest} from '../../../src/models/llm_request.js';
import {ToolContext} from '../../../src/tools/tool_context.js';
import {MCPToolset} from '../../../src/tools/mcp/mcp_toolset.js';
import {MCPTool} from '../../../src/tools/mcp/mcp_tool.js';

vi.hoisted(() => {
  vi.resetModules();
});

const mockListTools = vi.fn();
const mockGetInstructions = vi.fn().mockReturnValue(undefined);

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: mockListTools,
      getInstructions: mockGetInstructions,
      close: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn(),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  return {
    StreamableHTTPClientTransport: vi.fn(),
  };
});

const FAKE_TOOLS = {
  tools: [
    {name: 'tool_a', description: 'Tool A', inputSchema: {type: 'object'}},
    {name: 'tool_b', description: 'Tool B', inputSchema: {type: 'object'}},
    {
      name: 'file_read',
      description: 'Read files',
      inputSchema: {type: 'object'},
    },
  ],
};

function createToolset(
  toolFilter: string[] | ((tool: any, ctx: any) => boolean) = [],
) {
  return new MCPToolset(
    {type: 'StdioConnectionParams', serverParams: {command: 'test', args: []}},
    toolFilter,
  );
}

const fakeContext = {} as ReadonlyContext;

describe('MCPToolset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue(FAKE_TOOLS);
    mockGetInstructions.mockReturnValue(undefined);
  });

  // ---------------------------------------------------------------------------
  // Tool caching
  // ---------------------------------------------------------------------------

  it('caches tools after the first getTools() call', async () => {
    const toolset = createToolset();

    const first = await toolset.getTools();
    const second = await toolset.getTools();

    expect(mockListTools).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
  });

  /**
   * Improvement: Before N getTools = N listTools RPCs.
   * After N getTools = 1 listTools RPC (cached).
   */
  it('improvement: N getTools() calls trigger 1 listTools RPC', async () => {
    const N = 10;
    const toolset = createToolset();

    for (let i = 0; i < N; i++) {
      const tools = await toolset.getTools();
      expect(tools).toHaveLength(3);
    }

    expect(mockListTools).toHaveBeenCalledTimes(1);
  });

  it('returns a copy when no context is provided (mutation-safe)', async () => {
    const toolset = createToolset();

    const first = await toolset.getTools();
    const second = await toolset.getTools();

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it('re-fetches tools after close()', async () => {
    const toolset = createToolset();

    await toolset.getTools();
    await toolset.close();
    await toolset.getTools();

    expect(mockListTools).toHaveBeenCalledTimes(2);
  });

  it('wraps each MCP tool in an MCPTool instance', async () => {
    const toolset = createToolset();
    const tools = await toolset.getTools();

    for (const tool of tools) {
      expect(tool).toBeInstanceOf(MCPTool);
    }
  });

  // ---------------------------------------------------------------------------
  // Tool filtering
  // ---------------------------------------------------------------------------

  it('filters tools by name array', async () => {
    const toolset = createToolset(['tool_a']);
    const tools = await toolset.getTools(fakeContext);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('tool_a');
  });

  it('filters tools by predicate', async () => {
    const toolset = createToolset(
      (tool: any) => tool.name.startsWith('file_'),
    );
    const tools = await toolset.getTools(fakeContext);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('file_read');
  });

  it('returns all tools when filter is empty array', async () => {
    const toolset = createToolset([]);
    const tools = await toolset.getTools(fakeContext);

    expect(tools).toHaveLength(3);
  });

  it('returns all tools when no context is provided (skips filtering)', async () => {
    const toolset = createToolset(['tool_a']);
    const tools = await toolset.getTools();

    expect(tools).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // MCP server instructions
  // ---------------------------------------------------------------------------

  it('appends MCP server instructions to llmRequest wrapped in XML tags', async () => {
    mockGetInstructions.mockReturnValue('Use search tool for queries');

    const toolset = createToolset();
    await toolset.getTools();

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const toolContext = {} as ToolContext;

    await toolset.processLlmRequest(toolContext, llmRequest);

    const si = llmRequest.config?.systemInstruction as string;
    expect(si).toContain('<mcp_instructions>');
    expect(si).toContain('Use search tool for queries');
    expect(si).toContain('</mcp_instructions>');
  });

  it('does not modify llmRequest when no instructions exist', async () => {
    mockGetInstructions.mockReturnValue(undefined);

    const toolset = createToolset();
    await toolset.getTools();

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const toolContext = {} as ToolContext;

    await toolset.processLlmRequest(toolContext, llmRequest);

    expect(llmRequest.config).toBeUndefined();
  });

  it('appends tagged instructions to existing systemInstruction', async () => {
    mockGetInstructions.mockReturnValue('MCP: prefer search tool');

    const toolset = createToolset();
    await toolset.getTools();

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: 'You are a helpful assistant.'},
    };
    const toolContext = {} as ToolContext;

    await toolset.processLlmRequest(toolContext, llmRequest);

    const si = llmRequest.config?.systemInstruction as string;
    expect(si).toContain('You are a helpful assistant.');
    expect(si).toContain(
      '<mcp_instructions>\nMCP: prefer search tool\n</mcp_instructions>',
    );
  });

  // ---------------------------------------------------------------------------
  // Tool filtering – additional cases
  // ---------------------------------------------------------------------------

  it('filters tools by multiple names', async () => {
    const toolset = createToolset(['tool_a', 'file_read']);
    const tools = await toolset.getTools(fakeContext);

    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name);
    expect(names).toContain('tool_a');
    expect(names).toContain('file_read');
  });

  it('returns empty array when filter matches nothing', async () => {
    const toolset = createToolset(['non_existent']);
    const tools = await toolset.getTools(fakeContext);

    expect(tools).toHaveLength(0);
  });

  it('predicate receives the context argument', async () => {
    const predicate = vi.fn().mockReturnValue(true);
    const toolset = createToolset(predicate);
    const ctx = {someField: 'val'} as unknown as ReadonlyContext;

    await toolset.getTools(ctx);

    expect(predicate).toHaveBeenCalledTimes(3);
    for (const call of predicate.mock.calls) {
      expect(call[1]).toBe(ctx);
    }
  });

  it('returns filtered copy (mutation-safe) with context', async () => {
    const toolset = createToolset(['tool_b']);
    const first = await toolset.getTools(fakeContext);
    const second = await toolset.getTools(fakeContext);

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  // ---------------------------------------------------------------------------
  // Close – idempotency
  // ---------------------------------------------------------------------------

  it('close() is safe to call multiple times', async () => {
    const toolset = createToolset();
    await toolset.getTools();

    await expect(toolset.close()).resolves.toBeUndefined();
    await expect(toolset.close()).resolves.toBeUndefined();
  });

  it('getTools() works after close() and re-fetch', async () => {
    const toolset = createToolset();

    const first = await toolset.getTools();
    expect(first).toHaveLength(3);

    await toolset.close();

    const second = await toolset.getTools();
    expect(second).toHaveLength(3);
    expect(mockListTools).toHaveBeenCalledTimes(2);
  });
});
