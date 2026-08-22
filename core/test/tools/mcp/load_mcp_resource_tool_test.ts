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
  RunAsyncToolRequest,
} from '@google/adk';
import {Content, Type} from '@google/genai';
import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';

/**
 * Builds a {@link LoadMcpResourceTool} backed by a minimal mock toolset. Only
 * `listResources`/`readResource` are exercised by the tool, so those are the
 * only methods stubbed.
 */
function setup() {
  const listResources = vi.fn().mockResolvedValue([] as string[]);
  const readResource = vi.fn().mockResolvedValue([]);
  const toolset = {listResources, readResource} as unknown as MCPToolset;
  const tool = new LoadMcpResourceTool(toolset);
  return {tool, listResources, readResource};
}

/** A throwaway tool context; the tool never reads from it. */
const toolContext = {} as unknown as Context;

/** Builds a bare LlmRequest suitable for `processLlmRequest`. */
function makeLlmRequest(contents: Content[] = []): LlmRequest {
  return {contents, toolsDict: {}} as unknown as LlmRequest;
}

/** Builds a content whose first part is a `load_mcp_resource` function response. */
function functionResponseContent(response: Record<string, unknown>): Content {
  return {
    role: 'user',
    parts: [{functionResponse: {name: 'load_mcp_resource', response}}],
  };
}

describe('LoadMcpResourceTool', () => {
  let listResources: Mock;
  let readResource: Mock;
  let tool: LoadMcpResourceTool;

  beforeEach(() => {
    ({tool, listResources, readResource} = setup());
  });

  it('initializes with the load_mcp_resource name', () => {
    expect(tool.name).toBe('load_mcp_resource');
  });

  describe('_getDeclaration', () => {
    it('declares a resource_names array-of-strings parameter', () => {
      const declaration = tool._getDeclaration();

      expect(declaration.name).toBe('load_mcp_resource');
      const resourceNames =
        declaration.parameters?.properties?.['resource_names'];
      expect(resourceNames?.type).toBe(Type.ARRAY);
      expect(resourceNames?.items?.type).toBe(Type.STRING);
    });
  });

  describe('runAsync', () => {
    it('echoes the requested resource names with a status', async () => {
      const result = (await tool.runAsync({
        args: {resource_names: ['res1', 'res2']},
        toolContext,
      })) as {resource_names: string[]; status: string};

      expect(result.resource_names).toEqual(['res1', 'res2']);
      expect(result.status).toContain('temporarily inserted');
    });

    it('defaults resource_names to an empty array when absent', async () => {
      const result = (await tool.runAsync({
        args: {},
        toolContext,
      } as RunAsyncToolRequest)) as {resource_names: string[]};

      expect(result.resource_names).toEqual([]);
    });
  });

  describe('processLlmRequest', () => {
    it('injects the resource list into the system instruction', async () => {
      listResources.mockResolvedValue(['res1', 'res2']);
      const llmRequest = makeLlmRequest([]);

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.config?.systemInstruction).toContain('res1');
      expect(llmRequest.config?.systemInstruction).toContain('res2');
    });

    it('does not inject instructions when there are no resources', async () => {
      listResources.mockResolvedValue([]);
      const llmRequest = makeLlmRequest([]);

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.config?.systemInstruction).toBeUndefined();
    });

    it('swallows list errors and still processes function responses', async () => {
      listResources.mockRejectedValue(new Error('list failed'));
      readResource.mockResolvedValue([
        {uri: 'file:///res1', mimeType: 'text/plain', text: 'hello content'},
      ]);
      const llmRequest = makeLlmRequest([
        functionResponseContent({resource_names: ['res1']}),
      ]);

      await expect(
        tool.processLlmRequest({toolContext, llmRequest}),
      ).resolves.toBeUndefined();

      expect(llmRequest.contents).toHaveLength(2);
    });

    it('appends text resource content', async () => {
      readResource.mockResolvedValue([
        {uri: 'file:///res1', mimeType: 'text/plain', text: 'hello content'},
      ]);
      const llmRequest = makeLlmRequest([
        functionResponseContent({resource_names: ['res1']}),
      ]);

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(readResource).toHaveBeenCalledWith('res1');
      expect(llmRequest.contents).toHaveLength(2);
      const appended = llmRequest.contents[1];
      expect(appended.role).toBe('user');
      expect(appended.parts?.[0].text).toBe('Resource res1 is:');
      expect(appended.parts?.[1].text).toBe('hello content');
    });

    it('appends binary resource content without decoding the base64 blob', async () => {
      const blob = Buffer.from('binary data').toString('base64');
      readResource.mockResolvedValue([
        {uri: 'file:///res1', mimeType: 'image/png', blob},
      ]);
      const llmRequest = makeLlmRequest([
        functionResponseContent({resource_names: ['res1']}),
      ]);

      await tool.processLlmRequest({toolContext, llmRequest});

      const part = llmRequest.contents[1].parts?.[1];
      expect(part?.inlineData?.data).toBe(blob);
      expect(part?.inlineData?.mimeType).toBe('image/png');
    });

    it('defaults the mime type for binary content that lacks one', async () => {
      const blob = Buffer.from('binary data').toString('base64');
      readResource.mockResolvedValue([{uri: 'file:///res1', blob}]);
      const llmRequest = makeLlmRequest([
        functionResponseContent({resource_names: ['res1']}),
      ]);

      await tool.processLlmRequest({toolContext, llmRequest});

      const part = llmRequest.contents[1].parts?.[1];
      expect(part?.inlineData?.mimeType).toBe('application/octet-stream');
    });

    it('renders a placeholder for unknown content types', async () => {
      readResource.mockResolvedValue([{uri: 'file:///res1'}]);
      const llmRequest = makeLlmRequest([
        functionResponseContent({resource_names: ['res1']}),
      ]);

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.contents[1].parts?.[1].text).toContain(
        'Unknown content type',
      );
    });

    it('swallows read errors and appends nothing for that resource', async () => {
      readResource.mockRejectedValue(new Error('read failed'));
      const llmRequest = makeLlmRequest([
        functionResponseContent({resource_names: ['res1']}),
      ]);

      await expect(
        tool.processLlmRequest({toolContext, llmRequest}),
      ).resolves.toBeUndefined();

      expect(llmRequest.contents).toHaveLength(1);
    });

    it('does nothing when the last content is not a matching function response', async () => {
      const llmRequest = makeLlmRequest([
        {
          role: 'user',
          parts: [{functionResponse: {name: 'other_tool', response: {}}}],
        },
      ]);

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.contents).toHaveLength(1);
      expect(readResource).not.toHaveBeenCalled();
    });

    it('does nothing when the last content has no parts', async () => {
      const llmRequest = makeLlmRequest([{role: 'user'}]);

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.contents).toHaveLength(1);
      expect(readResource).not.toHaveBeenCalled();
    });

    it('does nothing when the last content has an empty parts array', async () => {
      const llmRequest = makeLlmRequest([{role: 'user', parts: []}]);

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.contents).toHaveLength(1);
      expect(readResource).not.toHaveBeenCalled();
    });

    it('does nothing when the first part is not a function response', async () => {
      const llmRequest = makeLlmRequest([
        {role: 'user', parts: [{text: 'just text'}]},
      ]);

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.contents).toHaveLength(1);
      expect(readResource).not.toHaveBeenCalled();
    });

    it('reads nothing when the function response omits resource_names', async () => {
      const llmRequest = makeLlmRequest([
        {
          role: 'user',
          parts: [{functionResponse: {name: 'load_mcp_resource'}}],
        },
      ]);

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.contents).toHaveLength(1);
      expect(readResource).not.toHaveBeenCalled();
    });

    it('appends content after a preceding conversation turn', async () => {
      readResource.mockResolvedValue([
        {uri: 'file:///res1', mimeType: 'text/plain', text: 'hello content'},
      ]);
      const llmRequest = makeLlmRequest([
        {role: 'user', parts: [{text: 'earlier message'}]},
        functionResponseContent({resource_names: ['res1']}),
      ]);

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.contents).toHaveLength(3);
      expect(llmRequest.contents[2].parts?.[1].text).toBe('hello content');
    });

    it('loads MCP resources when called in parallel alongside other tools', async () => {
      readResource.mockResolvedValue([
        {uri: 'file:///res1', mimeType: 'text/plain', text: 'parallel content'},
      ]);
      const llmRequest = makeLlmRequest([
        {role: 'user', parts: [{text: 'run tools'}]},
        {
          role: 'model',
          parts: [
            {functionCall: {name: 'other_tool', args: {}}},
            {
              functionCall: {
                name: 'load_mcp_resource',
                args: {resource_names: ['res1']},
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {functionResponse: {name: 'other_tool', response: {status: 'ok'}}},
            {
              functionResponse: {
                name: 'load_mcp_resource',
                response: {resource_names: ['res1']},
              },
            },
          ],
        },
      ]);

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.contents).toHaveLength(4);
      expect(llmRequest.contents[3].parts?.[1].text).toBe('parallel content');
    });

    it('loads MCP resources when called sequentially before other tools in the same turn', async () => {
      readResource.mockResolvedValue([
        {
          uri: 'file:///res1',
          mimeType: 'text/plain',
          text: 'sequential content',
        },
      ]);
      const llmRequest = makeLlmRequest([
        {role: 'user', parts: [{text: 'run tools'}]},
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'load_mcp_resource',
                args: {resource_names: ['res1']},
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_mcp_resource',
                response: {resource_names: ['res1']},
              },
            },
          ],
        },
        {
          role: 'model',
          parts: [{functionCall: {name: 'other_tool', args: {}}}],
        },
        {
          role: 'user',
          parts: [
            {functionResponse: {name: 'other_tool', response: {status: 'ok'}}},
          ],
        },
      ]);

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.contents).toHaveLength(6);
      expect(llmRequest.contents[5].parts?.[1].text).toBe('sequential content');
    });
  });
});
