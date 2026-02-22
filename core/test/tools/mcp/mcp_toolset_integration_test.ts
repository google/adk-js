/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {isBaseTool} from '../../../src/tools/base_tool.js';
import {MCPTool} from '../../../src/tools/mcp/mcp_tool.js';
import {MCPToolset} from '../../../src/tools/mcp/mcp_toolset.js';
import {LlmRequest} from '../../../src/models/llm_request.js';
import {ToolContext} from '../../../src/tools/tool_context.js';

vi.hoisted(() => {
  vi.resetModules();
});

const mockListTools = vi.fn().mockResolvedValue({
  tools: [
    {name: 'tool_a', description: 'A', inputSchema: {type: 'object'}},
  ],
});

const mockGetInstructions = vi.fn().mockReturnValue('Use tool_a for lookups');

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: mockListTools,
    getInstructions: mockGetInstructions,
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

describe('MCPToolset – LlmAgent integration contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue({
      tools: [
        {name: 'tool_a', description: 'A', inputSchema: {type: 'object'}},
      ],
    });
    mockGetInstructions.mockReturnValue('Use tool_a for lookups');
  });

  function createToolset() {
    return new MCPToolset(
      {type: 'StdioConnectionParams', serverParams: {command: 'test', args: []}},
    );
  }

  it('isBaseTool returns false for MCPToolset (toolset dispatching)', () => {
    const toolset = createToolset();
    expect(isBaseTool(toolset)).toBe(false);
  });

  it('isBaseTool returns true for MCPTool (individual tool)', async () => {
    const toolset = createToolset();
    const tools = await toolset.getTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(isBaseTool(tool)).toBe(true);
      expect(tool).toBeInstanceOf(MCPTool);
    }
  });

  it('full pipeline: discover → filter → inject instructions → ready', async () => {
    const toolset = new MCPToolset(
      {type: 'StdioConnectionParams', serverParams: {command: 'test', args: []}},
      ['tool_a'],
    );

    const tools = await toolset.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('tool_a');

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: 'You are helpful.'},
    };

    await toolset.processLlmRequest({} as ToolContext, llmRequest);

    const si = llmRequest.config?.systemInstruction as string;
    expect(si).toContain('You are helpful.');
    expect(si).toContain('<mcp_instructions>');
    expect(si).toContain('Use tool_a for lookups');
    expect(si).toContain('</mcp_instructions>');

    const secondCall = await toolset.getTools();
    expect(secondCall).toHaveLength(1);
    expect(mockListTools).toHaveBeenCalledTimes(1);
  });

  it('multiple toolsets each append their own instructions', async () => {
    mockGetInstructions.mockReturnValue('Use tool_a for lookups');
    const toolset1 = createToolset();
    await toolset1.getTools();

    mockGetInstructions.mockReturnValue('Also check tool_b');
    const toolset2 = createToolset();
    await toolset2.getTools();

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await toolset1.processLlmRequest({} as ToolContext, llmRequest);
    const si1 = llmRequest.config?.systemInstruction as string;
    expect(si1).toBe(
      '<mcp_instructions>\nUse tool_a for lookups\n</mcp_instructions>',
    );

    await toolset2.processLlmRequest({} as ToolContext, llmRequest);

    const si2 = llmRequest.config?.systemInstruction as string;
    expect(si2).toContain('<mcp_instructions>\nUse tool_a for lookups\n</mcp_instructions>');
    expect(si2).toContain('<mcp_instructions>\nAlso check tool_b\n</mcp_instructions>');
  });

  it('toolset lifecycle: create → use → close → recreate', async () => {
    const toolset = createToolset();

    const tools1 = await toolset.getTools();
    expect(tools1).toHaveLength(1);

    await toolset.close();

    const tools2 = await toolset.getTools();
    expect(tools2).toHaveLength(1);
    expect(mockListTools).toHaveBeenCalledTimes(2);
  });

  /**
   * Simulates N agent steps (like runOneStepAsync). Asserts the improvements:
   * - Before: N connections + N listTools RPCs
   * - After: 1 connection + 1 listTools RPC (cached)
   */
  it('improvement: N simulated steps use cached session and tools (no repeated RPCs)', async () => {
    const N_STEPS = 10;
    const toolset = createToolset();

    for (let i = 0; i < N_STEPS; i++) {
      const tools = await toolset.getTools();
      expect(tools).toHaveLength(1);

      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };
      await toolset.processLlmRequest({} as ToolContext, llmRequest);

      const decl = tools[0]._getDeclaration();
      expect(decl.parametersJsonSchema).toBeDefined();
      expect(decl.parameters).toBeUndefined();
    }

    expect(mockListTools).toHaveBeenCalledTimes(1);
    expect(Client).toHaveBeenCalledTimes(1);
  });
});
