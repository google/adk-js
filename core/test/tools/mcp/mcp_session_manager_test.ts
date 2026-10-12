/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getClientLabels,
  MCPConnectionParams,
  MCPSessionManager,
  runWithClientLabel,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {describe, expect, it, vi} from 'vitest';
// The logger singleton is internal (not part of the public API), so it is
// imported via a relative path to spy on the exact instance the manager uses.
import {logger} from '../../../src/utils/logger.js';

vi.hoisted(() => {
  vi.resetModules();
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
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

function trackingHeaders(): Record<string, string> {
  const value = getClientLabels().join(' ');
  return {'x-goog-api-client': value, 'user-agent': value};
}

describe('MCPSessionManager', () => {
  it('creates an stdio client', async () => {
    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {
        command: 'test-command',
        args: ['arg1', 'arg2'],
      },
    });

    const client = await manager.createSession();

    expect(Client).toHaveBeenCalledWith({
      name: 'MCPClient',
      version: '1.0.0',
    });
    expect(StdioClientTransport).toHaveBeenCalledWith({
      command: 'test-command',
      args: ['arg1', 'arg2'],
    });
    expect(client.connect).toHaveBeenCalled();
  });

  it('creates an http client with transport options headers', async () => {
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: 'http://test-url',
      transportOptions: {
        requestInit: {
          headers: {
            'x-test-header': 'test-value',
          },
        },
      },
    });

    const client = await manager.createSession();

    expect(Client).toHaveBeenCalledWith({
      name: 'MCPClient',
      version: '1.0.0',
    });
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      new URL('http://test-url'),
      {
        requestInit: {
          headers: {'x-test-header': 'test-value', ...trackingHeaders()},
        },
      },
    );
    expect(client.connect).toHaveBeenCalled();
  });

  it('creates an http client with deprecated header param', async () => {
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: 'http://test-url',
      header: {
        'x-test-header': 'test-value',
      },
    });

    await manager.createSession();

    expect(StreamableHTTPClientTransport).toHaveBeenLastCalledWith(
      new URL('http://test-url'),
      {
        requestInit: {
          headers: {'x-test-header': 'test-value', ...trackingHeaders()},
        },
      },
    );
  });

  it('prioritizes transportOptions headers over header', async () => {
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: 'http://test-url',
      transportOptions: {
        requestInit: {
          headers: {
            'x-priority': 'headers',
          },
        },
      },
      header: {
        'x-priority': 'header',
      },
    });

    await manager.createSession();

    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      {
        requestInit: {
          headers: {'x-priority': 'headers', ...trackingHeaders()},
        },
      },
    );
  });

  it('prioritizes transportOptions over header', async () => {
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: 'http://test-url',
      transportOptions: {
        requestInit: {},
      },
      header: {
        'x-priority': 'header',
      },
    });

    await manager.createSession();

    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      {
        requestInit: {headers: trackingHeaders()},
      },
    );
    const options = vi
      .mocked(StreamableHTTPClientTransport)
      .mock.calls.at(-1)?.[1];
    expect(options?.requestInit?.headers).not.toHaveProperty('x-priority');
  });

  describe('tracking headers', () => {
    function lastTransportOptions() {
      return vi.mocked(StreamableHTTPClientTransport).mock.calls.at(-1)?.[1];
    }

    it('sends the tracking headers when no headers are given', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      await manager.createSession();

      expect(StreamableHTTPClientTransport).toHaveBeenLastCalledWith(
        new URL('http://test-url'),
        {requestInit: {headers: trackingHeaders()}},
      );
    });

    it('merges a caller User-Agent from transportOptions', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {
          requestInit: {
            headers: {'User-Agent': 'my-app/1.0', 'x-test-header': 'value'},
          },
        },
      });

      await manager.createSession();

      const adk = getClientLabels().join(' ');
      expect(lastTransportOptions()?.requestInit?.headers).toEqual({
        'x-test-header': 'value',
        'x-goog-api-client': adk,
        'user-agent': `${adk} my-app/1.0`,
      });
    });

    it('merges a caller User-Agent from the deprecated header', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        header: {'User-Agent': 'my-app/1.0'},
      });

      await manager.createSession();

      const adk = getClientLabels().join(' ');
      expect(lastTransportOptions()).toEqual({
        requestInit: {
          headers: {
            'x-goog-api-client': adk,
            'user-agent': `${adk} my-app/1.0`,
          },
        },
      });
    });

    it('keeps other transportOptions fields when requestInit is absent', async () => {
      const customFetch = vi.fn();
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {
          fetch: customFetch,
          sessionId: 'session-1',
        },
      });

      await manager.createSession();

      expect(lastTransportOptions()).toEqual({
        fetch: customFetch,
        sessionId: 'session-1',
        requestInit: {headers: trackingHeaders()},
      });
    });

    it('keeps other requestInit fields', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {
          requestInit: {
            credentials: 'include',
            headers: {'x-test-header': 'value'},
          },
        },
      });

      await manager.createSession();

      expect(lastTransportOptions()).toEqual({
        requestInit: {
          credentials: 'include',
          headers: {'x-test-header': 'value', ...trackingHeaders()},
        },
      });
    });

    it('does not mutate the caller transportOptions', async () => {
      const withHeaders = {
        requestInit: {
          credentials: 'include' as const,
          headers: {'User-Agent': 'my-app/1.0'},
        },
      };
      const withoutRequestInit = {sessionId: 'session-1'};
      const withHeadersClone = structuredClone(withHeaders);
      const withoutRequestInitClone = structuredClone(withoutRequestInit);

      await new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: withHeaders,
      }).createSession();
      await new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: withoutRequestInit,
        header: {'x-test-header': 'value'},
      }).createSession();

      expect(withHeaders).toEqual(withHeadersClone);
      expect(withoutRequestInit).toEqual(withoutRequestInitClone);
      expect(withoutRequestInit).not.toHaveProperty('requestInit');
    });

    it('includes a runWithClientLabel label', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      await runWithClientLabel('my-label', () => manager.createSession());

      const headers = lastTransportOptions()?.requestInit?.headers;
      expect(headers).toHaveProperty(
        'user-agent',
        expect.stringContaining('my-label'),
      );
      expect(headers).toHaveProperty(
        'x-goog-api-client',
        expect.stringContaining('my-label'),
      );
    });

    it('passes only serverParams to the stdio transport', async () => {
      const serverParams = {command: 'test-command', args: ['arg1']};
      const manager = new MCPSessionManager({
        type: 'StdioConnectionParams',
        serverParams,
      });

      await manager.createSession();

      expect(StdioClientTransport).toHaveBeenLastCalledWith(serverParams);
      expect(vi.mocked(StdioClientTransport).mock.lastCall).toEqual([
        {command: 'test-command', args: ['arg1']},
      ]);
    });
  });

  it('tracks active sessions and cleans them up', async () => {
    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {
        command: 'test-command',
        args: ['arg1', 'arg2'],
      },
    });

    expect(manager.getActiveSessions()).toEqual([]);

    const client1 = await manager.createSession();
    const client2 = await manager.createSession();

    expect(manager.getActiveSessions()).toEqual([client1, client2]);

    await manager.closeSession(client1);
    expect(manager.getActiveSessions()).toEqual([client2]);

    await manager.closeSession(client2);
    expect(manager.getActiveSessions()).toEqual([]);
  });

  it('does not connect for an unknown connection type', async () => {
    const manager = new MCPSessionManager({
      type: 'UnknownConnectionType',
    } as unknown as MCPConnectionParams);

    const client = await manager.createSession();

    expect(client).toBeDefined();
    expect(client.connect).not.toHaveBeenCalled();
  });

  describe('connection error handling', () => {
    it('wraps a connect failure with a formatted message', async () => {
      vi.mocked(Client).mockImplementationOnce(
        () =>
          ({
            connect: vi
              .fn()
              .mockRejectedValue(
                Object.assign(
                  new Error(
                    'Streamable HTTP error: Error POSTing to endpoint: Forbidden',
                  ),
                  {code: 403},
                ),
              ),
            close: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      );

      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      const error = await manager.createSession().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        'Failed to create MCP session',
      );
      expect((error as Error).message).toContain('403');
      expect((error as Error).message).toContain('Forbidden');
    });

    it('preserves the original error as the cause', async () => {
      const original = Object.assign(new Error('boom'), {code: 401});
      vi.mocked(Client).mockImplementationOnce(
        () =>
          ({
            connect: vi.fn().mockRejectedValue(original),
            close: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      );

      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      const error = await manager.createSession().catch((e: unknown) => e);
      expect((error as Error).cause).toBe(original);
    });

    it('wraps an AggregateError connect failure with joined leaves', async () => {
      vi.mocked(Client).mockImplementationOnce(
        () =>
          ({
            connect: vi
              .fn()
              .mockRejectedValue(
                new AggregateError([new Error('err A'), new Error('err B')]),
              ),
            close: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      );

      const manager = new MCPSessionManager({
        type: 'StdioConnectionParams',
        serverParams: {command: 'test-command'},
      });

      const error = await manager.createSession().catch((e: unknown) => e);
      const message = (error as Error).message;
      expect(message).toContain('err A');
      expect(message).toContain('err B');
      expect(message).toContain(' | ');
    });

    it('logs a formatted message for a background transport error', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });
      await manager.createSession();

      const transport = vi
        .mocked(StreamableHTTPClientTransport)
        .mock.instances.at(-1);
      expect(transport?.onerror).toBeTypeOf('function');
      transport?.onerror?.(new Error('background stream died'));

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('MCP transport error'),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('background stream died'),
      );

      errorSpy.mockRestore();
    });
  });
});
