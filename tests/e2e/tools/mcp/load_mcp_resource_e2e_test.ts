/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  LlmRequest,
  LoadMcpResourceTool,
  MCPToolset,
} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` talks to a real MCP server
 * (spawned as a stdio child process, see `mcp_resource_server.mjs`) that exposes
 * a text and a binary resource. This proves the resource path works against an
 * actual MCP server, not just against test doubles.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_resource_server.mjs', import.meta.url),
);

/** A throwaway tool context; the tool never reads from it. */
const toolContext = {} as unknown as Context;

function createToolset(): MCPToolset {
  return new MCPToolset({
    type: 'StdioConnectionParams',
    serverParams: {command: process.execPath, args: [SERVER_PATH]},
  });
}

function functionResponseRequest(resourceNames: string[]): LlmRequest {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'load_mcp_resource',
              response: {resource_names: resourceNames},
            },
          },
        ],
      },
    ],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

describe('LoadMcpResourceTool (e2e, real MCP server over stdio)', () => {
  let toolset: MCPToolset;

  afterEach(async () => {
    await toolset?.close();
  });

  it('lists, resolves, and reads real MCP resources', async () => {
    toolset = createToolset();

    const names = await toolset.listResources();
    expect(names).toEqual(expect.arrayContaining(['readme', 'logo']));

    const info = await toolset.getResourceInfo('readme');
    expect(info.uri).toBe('file:///readme.txt');

    const textContents = await toolset.readResource('readme');
    expect(textContents[0]).toMatchObject({text: 'hello from mcp resource'});

    const binaryContents = await toolset.readResource('logo');
    expect(binaryContents[0]).toMatchObject({
      blob: Buffer.from('binary-logo-bytes').toString('base64'),
      mimeType: 'image/png',
    });
  });

  it('rejects when reading an unknown resource', async () => {
    toolset = createToolset();

    await expect(toolset.readResource('does-not-exist')).rejects.toThrow(
      'not found',
    );
  });

  it('injects real resource contents into the LlmRequest via the tool', async () => {
    toolset = createToolset();
    const tool = new LoadMcpResourceTool(toolset);
    const llmRequest = functionResponseRequest(['readme', 'logo']);

    await tool.processLlmRequest({toolContext, llmRequest});

    // The server advertises the resources, so the guidance is injected.
    expect(llmRequest.config?.systemInstruction).toContain('readme');

    // The original function-response turn plus one appended turn per resource.
    expect(llmRequest.contents).toHaveLength(3);

    const textTurn = llmRequest.contents[1];
    expect(textTurn.role).toBe('user');
    expect(textTurn.parts?.[0].text).toBe('Resource readme is:');
    expect(textTurn.parts?.[1].text).toBe('hello from mcp resource');

    const binaryTurn = llmRequest.contents[2];
    expect(binaryTurn.parts?.[0].text).toBe('Resource logo is:');
    expect(binaryTurn.parts?.[1].inlineData?.mimeType).toBe('image/png');
    expect(binaryTurn.parts?.[1].inlineData?.data).toBe(
      Buffer.from('binary-logo-bytes').toString('base64'),
    );
  });
});
