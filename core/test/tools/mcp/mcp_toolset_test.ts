/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  InvocationContext,
  SseConnectionParams,
  SseServerParams,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {describe, expect, it, vi} from 'vitest';
import {Context} from '../../../src/agents/context.js';
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
        callTool: vi.fn().mockResolvedValue({content: []}),
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

    it('predicate filter applies when no context is provided', async () => {
      const toolset = new MCPToolset(
        stdioParams,
        (tool) => tool.name === 'other-tool',
      );
      const tools = await toolset.getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('other-tool');
    });
  });

  describe('session reuse and cleanup', () => {
    it('reuses a single session across getTools, resources, and tool calls until close()', async () => {
      vi.mocked(Client).mockClear();
      const toolset = new MCPToolset(stdioParams);
      const closeSpy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

      const tools = await toolset.getTools();
      const resourceNames = await toolset.listResources();
      const resourceInfo = await toolset.getResourceInfo('res1');
      const resourceContents = await toolset.readResource('res1');
      const toolContext = new Context({
        invocationContext: {
          abortSignal: new AbortController().signal,
          session: {state: {}},
        } as unknown as InvocationContext,
      });
      await tools[0].runAsync({args: {}, toolContext});
      await tools[1].runAsync({args: {}, toolContext});

      expect(tools).toHaveLength(2);
      expect(resourceNames).toEqual(['res1', 'res2']);
      expect(resourceInfo.uri).toBe('file:///res1');
      expect(resourceContents).toHaveLength(1);
      expect(Client).toHaveBeenCalledTimes(1);
      expect(closeSpy).not.toHaveBeenCalled();
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(1);

      await toolset.close();

      expect(closeSpy).toHaveBeenCalledOnce();
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(0);
    });

    it('keeps the shared session active when listTools throws a regular error and closes on close()', async () => {
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
      expect(spy).not.toHaveBeenCalled();
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(1);

      await toolset.close();
      expect(spy).toHaveBeenCalledOnce();
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(0);
    });

    it('evicts the session when listTools throws a disconnected error so the next getTools reconnects', async () => {
      const toolset = new MCPToolset(stdioParams);

      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockImplementationOnce(function () {
        return {
          connect: noop(),
          close: noop(),
          listTools: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Connection closed'), {code: -32000}),
            ),
        } as unknown as Client;
      });

      const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

      await expect(toolset.getTools()).rejects.toThrow('Connection closed');
      expect(spy).toHaveBeenCalledOnce();
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(0);

      const recoveredTools = await toolset.getTools();
      expect(recoveredTools).toHaveLength(2);
      await toolset.close();
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

    it('readResource resolves the URI and returns the contents on the same session', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockClear();
      const listResources = vi.fn().mockResolvedValue({
        resources: [{uri: 'file:///res1', name: 'res1'}],
      });
      const readResource = vi.fn().mockResolvedValue({
        contents: [{uri: 'file:///res1', text: 'hello'}],
      });
      vi.mocked(Client).mockImplementationOnce(function () {
        return {
          connect: noop(),
          close: noop(),
          listResources,
          readResource,
        } as unknown as Client;
      });

      const toolset = new MCPToolset(stdioParams);
      const contents = await toolset.readResource('res1');

      expect(Client).toHaveBeenCalledTimes(1);
      expect(listResources).toHaveBeenCalledOnce();
      expect(readResource).toHaveBeenCalledWith({uri: 'file:///res1'});
      expect(contents).toEqual([{uri: 'file:///res1', text: 'hello'}]);
      await toolset.close();
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
      it('keeps the session open across listResources and readResource until close()', async () => {
        const toolset = new MCPToolset(stdioParams);
        const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

        await toolset.listResources();
        await toolset.readResource('res1');

        expect(spy).not.toHaveBeenCalled();
        expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(
          1,
        );

        await toolset.close();

        expect(spy).toHaveBeenCalledOnce();
        expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(
          0,
        );
      });

      it('keeps the session open when listResources rejects with an application error', async () => {
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
        expect(spy).not.toHaveBeenCalled();
        expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(
          1,
        );

        await toolset.close();
        expect(spy).toHaveBeenCalledOnce();
      });

      it('evicts the session when readResource rejects with a disconnected HTTP 404 error', async () => {
        const {Client} =
          await import('@modelcontextprotocol/sdk/client/index.js');
        vi.mocked(Client).mockImplementationOnce(function () {
          return {
            connect: noop(),
            close: noop(),
            listResources: vi.fn().mockResolvedValue({
              resources: [{uri: 'file:///res1', name: 'res1'}],
            }),
            readResource: vi
              .fn()
              .mockRejectedValue(
                Object.assign(new Error('Session not found'), {code: 404}),
              ),
          } as unknown as Client;
        });

        const toolset = new MCPToolset(stdioParams);
        const spy = vi.spyOn(toolset['mcpSessionManager'], 'closeSession');

        await expect(toolset.readResource('res1')).rejects.toThrow(
          'Session not found',
        );
        expect(spy).toHaveBeenCalledOnce();
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

    it('deduplicates concurrent getTools calls onto one session and closes it cleanly', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockClear();
      const ready = createDeferred<void>();
      const finishListTools = createDeferred<{tools: never[]}>();
      const close1 = vi.fn().mockResolvedValue(undefined);

      vi.mocked(Client).mockImplementationOnce(function () {
        return {
          connect: noop(),
          close: close1,
          listTools: vi.fn().mockImplementation(() => {
            ready.resolve();
            return finishListTools.promise;
          }),
        } as unknown as Client;
      });

      const toolset = new MCPToolset(stdioParams);
      const pendingTools1 = toolset.getTools();
      const pendingTools2 = toolset.getTools();
      await ready.promise;

      expect(Client).toHaveBeenCalledTimes(1);

      await toolset.close();
      expect(close1).toHaveBeenCalledOnce();

      finishListTools.resolve({tools: []});
      await Promise.all([pendingTools1, pendingTools2]);
      expect(close1).toHaveBeenCalledOnce();
    });

    it('closes all active sessions and suppresses individual close rejections', async () => {
      const {Client} =
        await import('@modelcontextprotocol/sdk/client/index.js');
      const close1 = vi.fn().mockRejectedValue(new Error('close failed'));
      const close2 = vi.fn().mockResolvedValue(undefined);

      vi.mocked(Client)
        .mockImplementationOnce(function () {
          return {
            connect: noop(),
            close: close1,
            listTools: vi.fn().mockResolvedValue({tools: []}),
          } as unknown as Client;
        })
        .mockImplementationOnce(function () {
          return {
            connect: noop(),
            close: close2,
          } as unknown as Client;
        });

      const toolset = new MCPToolset(stdioParams);
      await toolset.getTools();
      await toolset['mcpSessionManager'].createSession();
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(2);

      await expect(toolset.close()).resolves.toBeUndefined();

      expect(close1).toHaveBeenCalledOnce();
      expect(close2).toHaveBeenCalledOnce();
      expect(toolset['mcpSessionManager'].getActiveSessions()).toHaveLength(0);

      // Reusing the toolset after close() opens a fresh session cleanly.
      const reopenedTools = await toolset.getTools();
      expect(reopenedTools).toHaveLength(2);
      await toolset.close();
    });
  });
});
