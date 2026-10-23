/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {SseConnectionParams, SseServerParams} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {describe, expect, it, vi} from 'vitest';
import {ReadonlyContext} from '../../../src/agents/readonly_context.js';
import {isBaseToolset} from '../../../src/tools/base_toolset.js';
import {MCPConnectionParams} from '../../../src/tools/mcp/mcp_session_manager.js';
import {MCPToolset} from '../../../src/tools/mcp/mcp_toolset.js';

vi.hoisted(() => {
  vi.resetModules();
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(function () {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockResolvedValue({
          tools: [
            {name: 'test-tool', description: 'A test tool', inputSchema: {}},
            {name: 'other-tool', description: 'Another tool', inputSchema: {}},
          ],
        }),
        listResources: vi.fn().mockResolvedValue({
          resources: [
            {uri: 'file:///res1', name: 'res1'},
            {uri: 'file:///res2', name: 'res2'},
          ],
        }),
        readResource: vi.fn().mockResolvedValue({
          contents: [
            {uri: 'file:///res1', mimeType: 'text/plain', text: 'hello'},
          ],
        }),
      };
    }),
  };
});

/** A client method stub that resolves to nothing (connect/close). */
const noop = () => vi.fn().mockResolvedValue(undefined);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return {promise, resolve};
}

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn(),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => {
  return {
    SSEClientTransport: vi.fn(),
  };
});

const stdioParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'test'},
} as unknown as MCPConnectionParams;

describe('MCPToolset', () => {
  it.each(['getTools', 'listResources', 'getResourceInfo'] as const)(
    '%s propagates a later-page error and closes the session',
    async (method) => {
      const error = new Error('next page failed');
      const list = vi
        .fn()
        .mockResolvedValueOnce({
          tools: [],
          resources: [],
          nextCursor: 'opaque cursor',
        })
        .mockRejectedValueOnce(error);
      const close = noop();
      vi.mocked(Client).mockImplementationOnce(function () {
        return {
          connect: noop(),
          close,
          listTools: list,
          listResources: list,
        } as unknown as Client;
      });
      const toolset = new MCPToolset(stdioParams);

      await expect(
        method === 'getResourceInfo'
          ? toolset.getResourceInfo('last')
          : toolset[method](),
      ).rejects.toBe(error);

      expect(list).toHaveBeenNthCalledWith(1, undefined);
      expect(list).toHaveBeenNthCalledWith(2, {cursor: 'opaque cursor'});
      expect(close).toHaveBeenCalledOnce();
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(0);
    },
  );

  it('stops resource lookup once the named resource is found', async () => {
    const resource = {uri: 'file:///first', name: 'first'};
    const listResources = vi.fn().mockResolvedValue({
      resources: [resource],
      nextCursor: 'more',
    });
    const close = noop();
    vi.mocked(Client).mockImplementationOnce(function () {
      return {connect: noop(), close, listResources} as unknown as Client;
    });
    const toolset = new MCPToolset(stdioParams);

    expect(await toolset.getResourceInfo('first')).toEqual(resource);
    expect(listResources).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('discovers tools without prefix', async () => {
    const toolset = new MCPToolset(stdioParams);
    const tools = await toolset.getTools();

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('test-tool');
    expect(tools[1].name).toBe('other-tool');
  });

  it('discovers tools with prefix applied', async () => {
    const toolset = new MCPToolset(stdioParams, [], 'myprefix');
    const tools = await toolset.getTools();

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('myprefix_test-tool');
    expect(tools[1].name).toBe('myprefix_other-tool');
  });

  describe('toolFilter', () => {
    it('empty array (default) returns all tools', async () => {
      const toolset = new MCPToolset(stdioParams, []);
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
    });

    it('string array filter returns only matching tools', async () => {
      const toolset = new MCPToolset(stdioParams, ['test-tool']);
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('test-tool');
    });

    it('string array filter with prefix matches prefixed names', async () => {
      const toolset = new MCPToolset(
        stdioParams,
        ['myprefix_test-tool'],
        'myprefix',
      );
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('myprefix_test-tool');
    });

    it('string array filter returns empty when no tools match', async () => {
      const toolset = new MCPToolset(stdioParams, ['nonexistent-tool']);
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(0);
    });

    it('predicate filter applies when context is provided', async () => {
      const toolset = new MCPToolset(
        stdioParams,
        (tool) => tool.name === 'other-tool',
      );
      const tools = await toolset.getTools({} as ReadonlyContext);

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('other-tool');
    });

    it('predicate filter returns all tools when no context is provided', async () => {
      const toolset = new MCPToolset(
        stdioParams,
        (tool) => tool.name === 'other-tool',
      );
      // No context passed — filter cannot be applied, returns all tools
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
    });
  });

  describe('cleanup', () => {
    it('closes the session and leaves activeSessions empty after getTools success', async () => {
      const toolset = new MCPToolset(stdioParams);
      const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(2);
      expect(spy).toHaveBeenCalledOnce();
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(0);
    });

    it('closes the session and leaves activeSessions empty even if listTools throws an error', async () => {
      const toolset = new MCPToolset(stdioParams);

      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      const mockClientInstance = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockRejectedValue(new Error('List tools failed')),
      };
      vi.mocked(Client).mockImplementationOnce(function () {
        return mockClientInstance as unknown as Client;
      });

      const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

      await expect(toolset.getTools()).rejects.toThrow('List tools failed');
      expect(spy).toHaveBeenCalledOnce();
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(0);
    });
  });

  describe('resources', () => {
    it('listResources returns the mapped resource names', async () => {
      const toolset = new MCPToolset(stdioParams);

      const names = await toolset.listResources();

      expect(names).toEqual(['res1', 'res2']);
    });

    it('getResourceInfo returns the matching resource', async () => {
      const toolset = new MCPToolset(stdioParams);

      const info = await toolset.getResourceInfo('res1');

      expect(info.name).toBe('res1');
      expect(info.uri).toBe('file:///res1');
    });

    it('getResourceInfo rejects when the name is unknown', async () => {
      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.getResourceInfo('nope')).rejects.toThrow(
        "Resource with name 'nope' not found.",
      );
    });

    it('readResource resolves the URI and returns the contents', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      const readResource = vi.fn().mockResolvedValue({
        contents: [{uri: 'file:///res1', text: 'hello'}],
      });
      vi.mocked(Client)
        .mockImplementationOnce(function () {
          return {
            connect: noop(),
            close: noop(),
            listResources: vi.fn().mockResolvedValue({
              resources: [{uri: 'file:///res1', name: 'res1'}],
            }),
          } as unknown as Client;
        })
        .mockImplementationOnce(function () {
          return {
            connect: noop(),
            close: noop(),
            readResource,
          } as unknown as Client;
        });

      const toolset = new MCPToolset(stdioParams);
      const contents = await toolset.readResource('res1');

      expect(readResource).toHaveBeenCalledWith({uri: 'file:///res1'});
      expect(contents).toEqual([{uri: 'file:///res1', text: 'hello'}]);
    });

    it('readResource rejects when the name is unknown', async () => {
      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.readResource('nope')).rejects.toThrow(
        "Resource with name 'nope' not found.",
      );
    });

    it('readResource rejects when the resolved resource has no URI', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockImplementationOnce(function () {
        return {
          connect: noop(),
          close: noop(),
          listResources: vi.fn().mockResolvedValue({
            resources: [{uri: '', name: 'res1'}],
          }),
        } as unknown as Client;
      });

      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.readResource('res1')).rejects.toThrow(
        "Resource 'res1' has no URI.",
      );
    });

    describe('cleanup', () => {
      it('closes the session after listResources succeeds', async () => {
        const toolset = new MCPToolset(stdioParams);
        const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

        await toolset.listResources();

        expect(spy).toHaveBeenCalledOnce();
        expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(
          0,
        );
      });

      it('closes the session even if the client listResources rejects', async () => {
        const {Client} =
          await import('@modelcontextprotocol/sdk/client/index.js');
        vi.mocked(Client).mockImplementationOnce(function () {
          return {
            connect: noop(),
            close: noop(),
            listResources: vi.fn().mockRejectedValue(new Error('list boom')),
          } as unknown as Client;
        });

        const toolset = new MCPToolset(stdioParams);
        const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

        await expect(toolset.listResources()).rejects.toThrow('list boom');
        expect(spy).toHaveBeenCalledOnce();
        expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(
          0,
        );
      });

      it('closes both sessions after readResource succeeds', async () => {
        const toolset = new MCPToolset(stdioParams);
        const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

        await toolset.readResource('res1');

        expect(spy).toHaveBeenCalledTimes(2);
        expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(
          0,
        );
      });

      it('closes both sessions even if the client readResource rejects', async () => {
        const {Client} =
          await import('@modelcontextprotocol/sdk/client/index.js');
        vi.mocked(Client)
          .mockImplementationOnce(function () {
            return {
              connect: noop(),
              close: noop(),
              listResources: vi.fn().mockResolvedValue({
                resources: [{uri: 'file:///res1', name: 'res1'}],
              }),
            } as unknown as Client;
          })
          .mockImplementationOnce(function () {
            return {
              connect: noop(),
              close: noop(),
              readResource: vi.fn().mockRejectedValue(new Error('read boom')),
            } as unknown as Client;
          });

        const toolset = new MCPToolset(stdioParams);
        const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

        await expect(toolset.readResource('res1')).rejects.toThrow('read boom');
        expect(spy).toHaveBeenCalledTimes(2);
        expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(
          0,
        );
      });
    });
  });

  describe('SseConnectionParams', () => {
    it('discovers tools over SSE transport with SseConnectionParams', async () => {
      const sseParams: SseConnectionParams = {
        type: 'SseConnectionParams',
        url: 'http://localhost:8090/sse',
        headers: {'Authorization': 'Bearer sse-token'},
      };
      const toolset = new MCPToolset(sseParams);

      const tools = await toolset.getTools();

      expect(SSEClientTransport).toHaveBeenCalledWith(
        new URL('http://localhost:8090/sse'),
        expect.objectContaining({
          requestInit: expect.objectContaining({
            headers: expect.objectContaining({
              'Authorization': 'Bearer sse-token',
            }),
          }),
        }),
      );
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('test-tool');
      expect(tools[1].name).toBe('other-tool');
    });

    it('accepts the SseServerParams alias with prefix and filter', async () => {
      const sseParams: SseServerParams = {
        type: 'SseConnectionParams',
        url: 'http://localhost:8090/sse',
        timeout: 5,
        sseReadTimeout: 300,
      };
      const toolset = new MCPToolset(sseParams, ['sse_test-tool'], 'sse');

      const tools = await toolset.getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('sse_test-tool');
    });
  });

  describe('close', () => {
    it('identifies MCPToolset as a BaseToolset via isBaseToolset', () => {
      const toolset = new MCPToolset(stdioParams);

      expect(isBaseToolset(toolset)).toBe(true);
    });

    it('resolves as a no-op when no sessions are active', async () => {
      const toolset = new MCPToolset(stdioParams);

      await expect(toolset.close()).resolves.toBeUndefined();
    });

    it('closes all active sessions', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      const ready1 = createDeferred<void>();
      const ready2 = createDeferred<void>();
      const finishListTools = createDeferred<{tools: never[]}>();
      const close1 = vi.fn().mockResolvedValue(undefined);
      const close2 = vi.fn().mockResolvedValue(undefined);

      vi.mocked(Client)
        .mockImplementationOnce(function () {
          return {
            connect: noop(),
            close: close1,
            listTools: vi.fn().mockImplementation(() => {
              ready1.resolve();
              return finishListTools.promise;
            }),
          } as unknown as Client;
        })
        .mockImplementationOnce(function () {
          return {
            connect: noop(),
            close: close2,
            listTools: vi.fn().mockImplementation(() => {
              ready2.resolve();
              return finishListTools.promise;
            }),
          } as unknown as Client;
        });

      const toolset = new MCPToolset(stdioParams);
      const pendingTools1 = toolset.getTools();
      await ready1.promise;
      const pendingTools2 = toolset.getTools();
      await ready2.promise;

      await toolset.close();

      expect(close1).toHaveBeenCalledOnce();
      expect(close2).toHaveBeenCalledOnce();

      finishListTools.resolve({tools: []});
      await Promise.all([pendingTools1, pendingTools2]);

      expect(close1).toHaveBeenCalledOnce();
      expect(close2).toHaveBeenCalledOnce();
    });

    it('resolves and closes remaining sessions when one session close rejects', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      const ready1 = createDeferred<void>();
      const ready2 = createDeferred<void>();
      const finishListTools = createDeferred<{tools: never[]}>();
      const close1 = vi.fn().mockRejectedValue(new Error('close failed'));
      const close2 = vi.fn().mockResolvedValue(undefined);

      vi.mocked(Client)
        .mockImplementationOnce(function () {
          return {
            connect: noop(),
            close: close1,
            listTools: vi.fn().mockImplementation(() => {
              ready1.resolve();
              return finishListTools.promise;
            }),
          } as unknown as Client;
        })
        .mockImplementationOnce(function () {
          return {
            connect: noop(),
            close: close2,
            listTools: vi.fn().mockImplementation(() => {
              ready2.resolve();
              return finishListTools.promise;
            }),
          } as unknown as Client;
        });

      const toolset = new MCPToolset(stdioParams);
      const pendingTools1 = toolset.getTools();
      await ready1.promise;
      const pendingTools2 = toolset.getTools();
      await ready2.promise;

      await expect(toolset.close()).resolves.toBeUndefined();

      expect(close1).toHaveBeenCalledOnce();
      expect(close2).toHaveBeenCalledOnce();

      finishListTools.resolve({tools: []});
      await Promise.all([pendingTools1, pendingTools2]);
    });
  });
});
