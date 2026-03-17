/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  BaseToolset,
  Context,
  InvocationContext,
  LlmRequest,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class DummyTool extends BaseTool {
  constructor(name: string) {
    super({name, description: 'Dummy tool'});
  }
  _getDeclaration() {
    return {name: this.name, description: this.description};
  }

  async runAsync(): Promise<unknown> {
    return 'dummy';
  }
}

class DummyToolset extends BaseToolset {
  constructor(prefix?: string) {
    super([], prefix);
  }

  async getTools(): Promise<BaseTool[]> {
    const rawTools = [new DummyTool('tool1'), new DummyTool('tool2')];
    return rawTools.map((tool) => {
      return new DummyTool(
        this.prefix ? `${this.prefix}_${tool.name}` : tool.name,
      );
    });
  }

  async close(): Promise<void> {}
}

describe('BaseToolset integration with LLM Request', () => {
  it('No prefix means the tool names match original names', async () => {
    const toolset = new DummyToolset();
    const tools = await toolset.getTools();
    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe('tool1');
    expect(tools[1].name).toBe('tool2');
  });

  it('Toolsets with a configured prefix correctly prefix names', async () => {
    const toolset = new DummyToolset('myprefix');
    const tools = await toolset.getTools();
    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe('myprefix_tool1');
    expect(tools[1].name).toBe('myprefix_tool2');
  });

  it('Multiple toolsets with no prefix and conflicting tool names cause an error', async () => {
    const toolset1 = new DummyToolset();
    const toolset2 = new DummyToolset(); // will emit tool1 and tool2 again

    const tools1 = await toolset1.getTools();
    const tools2 = await toolset2.getTools();

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    // Set up dummy context
    const context = new Context({
      invocationContext: {session: {state: {}}} as unknown as InvocationContext,
    });

    for (const tool of tools1) {
      await tool.processLlmRequest({toolContext: context, llmRequest});
    }

    // Attempting to add tools from toolset2 should fail on the first duplicate ('tool1')
    await expect(async () => {
      for (const tool of tools2) {
        await tool.processLlmRequest({toolContext: context, llmRequest});
      }
    }).rejects.toThrow('Duplicate tool name: tool1');
  });

  it('Multiple toolsets with separate prefixes and conflicting tool names do not cause an error', async () => {
    const toolset1 = new DummyToolset('prefixA');
    const toolset2 = new DummyToolset('prefixB');

    const tools1 = await toolset1.getTools();
    const tools2 = await toolset2.getTools();

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const context = new Context({
      invocationContext: {session: {state: {}}} as unknown as InvocationContext,
    });

    for (const tool of tools1) {
      await tool.processLlmRequest({toolContext: context, llmRequest});
    }

    for (const tool of tools2) {
      await tool.processLlmRequest({toolContext: context, llmRequest});
    }

    const toolKeys = Object.keys(llmRequest.toolsDict);
    expect(toolKeys.length).toBe(4);
    expect(toolKeys).toContain('prefixA_tool1');
    expect(toolKeys).toContain('prefixA_tool2');
    expect(toolKeys).toContain('prefixB_tool1');
    expect(toolKeys).toContain('prefixB_tool2');
  });
});
