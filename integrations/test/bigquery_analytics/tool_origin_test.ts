/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  BaseTool,
  FunctionTool,
  LlmAgent,
  type ReadonlyContext,
  RemoteA2AAgent,
  ToolboxToolset,
  WebMCPTool,
} from '@google/adk';
import {type FunctionDeclaration, type Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  extractToolDeclarations,
  getToolOrigin,
} from '../../src/bigquery_analytics/tool_origin.js';

class DeclaredTool extends BaseTool {
  constructor(private readonly declaration: FunctionDeclaration) {
    super({name: declaration.name ?? 'tool', description: 'A tool.'});
  }

  override _getDeclaration(): FunctionDeclaration {
    return this.declaration;
  }

  override runAsync(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

function remoteAgent(name: string): RemoteA2AAgent {
  // A prototype-only instance: tool origin checks the class, and reads nothing
  // but `name`.
  const agent = Object.create(RemoteA2AAgent.prototype) as RemoteA2AAgent;
  Object.defineProperty(agent, 'name', {value: name});
  return agent;
}

describe('getToolOrigin', () => {
  it('classifies tools loaded by a ToolboxToolset as TOOLBOX', async () => {
    const clientTool = new FunctionTool({
      name: 'search_hotels',
      description: 'Searches hotels.',
      execute: () => 'ok',
    });
    const toolset = new ToolboxToolset({
      serverUrl: 'http://127.0.0.1:5000',
      toolsetName: 'hotels',
      toolNames: ['book_hotel'],
      client: {
        loadToolset: async () => [clientTool],
        loadTool: async (name: string) => ({
          name,
          description: 'Books a hotel.',
          execute: () => 'booked',
        }),
      },
    });

    const tools = await toolset.getTools({} as ReadonlyContext);

    expect(tools.map((tool) => getToolOrigin({tool}))).toEqual([
      'TOOLBOX',
      'TOOLBOX',
    ]);
    expect(tools[0]).toBe(clientTool);
    expect(
      getToolOrigin({
        tool: new FunctionTool({
          name: 'unrelated',
          description: 'Not loaded by a ToolboxToolset.',
          execute: () => 'ok',
        }),
      }),
    ).toBe('LOCAL');
  });

  it('classifies a WebMCPTool as MCP', () => {
    const tool = new WebMCPTool({
      tool: {
        name: 'page_search',
        description: 'Search the page.',
        inputSchema: {type: 'object'},
        execute: () => Promise.resolve(''),
      },
    } as unknown as ConstructorParameters<typeof WebMCPTool>[0]);
    expect(getToolOrigin({tool})).toBe('MCP');
  });

  it('reads an inherited AgentTool agent', () => {
    const a2a = new AgentTool({
      agent: new LlmAgent({name: 'remote', model: 'gemini-2.5-flash'}),
    });
    Object.defineProperty(a2a, 'agent', {value: remoteAgent('remote')});
    const derived = Object.create(a2a) as AgentTool;
    expect(getToolOrigin({tool: derived})).toBe('A2A');
  });
});

describe('extractToolDeclarations', () => {
  it('ends a self-referencing schema in a sentinel', () => {
    const node: Schema = {type: Type.OBJECT, properties: {}};
    node.properties = {child: node};
    node.items = node;
    const [entry] = extractToolDeclarations({
      tree: new DeclaredTool({name: 'tree', parameters: node}),
    });
    expect(entry?.parameters).toEqual({
      type: 'OBJECT',
      properties: {child: '[CIRCULAR_REFERENCE]'},
      items: '[CIRCULAR_REFERENCE]',
    });
  });

  it('bounds an over-deep schema', () => {
    let deep: Schema = {type: Type.STRING};
    for (let index = 0; index < 10_000; index += 1) {
      deep = {type: Type.ARRAY, items: deep};
    }
    const [entry] = extractToolDeclarations({
      deep: new DeclaredTool({name: 'deep', parameters: deep}),
    });
    expect(JSON.stringify(entry?.parameters)).toContain('[MAX_DEPTH_EXCEEDED]');
  });

  it('snake-cases PascalCase and acronym schema keys by word', () => {
    const [entry] = extractToolDeclarations({
      t: new DeclaredTool({
        name: 't',
        parameters: {
          type: Type.OBJECT,
          XMLName: 'x',
          anyOf: [{type: Type.STRING, maxLength: '3'}],
        } as Schema,
      }),
    });
    expect(entry?.parameters).toEqual({
      type: 'OBJECT',
      xml_name: 'x',
      any_of: [{type: 'STRING', max_length: '3'}],
    });
  });
});
