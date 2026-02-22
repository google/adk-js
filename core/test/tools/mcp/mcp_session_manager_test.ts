/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {MCPSessionManager} from '../../../src/tools/mcp/mcp_session_manager.js';

vi.hoisted(() => {
  vi.resetModules();
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      getInstructions: vi.fn().mockReturnValue(undefined),
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

describe('MCPSessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
          headers: {'x-test-header': 'test-value'},
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

    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      new URL('http://test-url'),
      {
        requestInit: {
          headers: {'x-test-header': 'test-value'},
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
          headers: {'x-priority': 'headers'},
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
        requestInit: {},
      },
    );
  });

  it('returns cached client on subsequent createSession calls', async () => {
    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test', args: []},
    });

    const first = await manager.createSession();
    const second = await manager.createSession();

    expect(first).toBe(second);
    expect(Client).toHaveBeenCalledTimes(1);
  });

  /**
   * Improvement: N sequential steps (like agent loop) reuse one client.
   * Before: N Clients. After: 1 Client.
   */
  it('improvement: N sequential createSession calls reuse one Client', async () => {
    const N_STEPS = 10;
    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test', args: []},
    });

    const clients: Client[] = [];
    for (let i = 0; i < N_STEPS; i++) {
      clients.push(await manager.createSession());
    }

    for (let i = 1; i < N_STEPS; i++) {
      expect(clients[i]).toBe(clients[0]);
    }
    expect(Client).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh client after close()', async () => {
    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test', args: []},
    });

    const first = await manager.createSession();
    await manager.close();
    const second = await manager.createSession();

    expect(first).not.toBe(second);
    expect(Client).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalled();
  });

  it('caches server instructions from getInstructions()', async () => {
    vi.mocked(Client).mockImplementationOnce(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          getInstructions: vi.fn().mockReturnValue('Use search for queries'),
          close: vi.fn().mockResolvedValue(undefined),
        }) as unknown as Client,
    );

    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test', args: []},
    });

    expect(manager.getInstructions()).toBeUndefined();

    await manager.createSession();

    expect(manager.getInstructions()).toBe('Use search for queries');
  });

  it('clears instructions after close()', async () => {
    vi.mocked(Client).mockImplementationOnce(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          getInstructions: vi.fn().mockReturnValue('Some instructions'),
          close: vi.fn().mockResolvedValue(undefined),
        }) as unknown as Client,
    );

    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test', args: []},
    });

    await manager.createSession();
    expect(manager.getInstructions()).toBe('Some instructions');

    await manager.close();
    expect(manager.getInstructions()).toBeUndefined();
  });

  it('close() is a noop when no session exists', async () => {
    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test', args: []},
    });

    await expect(manager.close()).resolves.toBeUndefined();
  });

  it('close() swallows errors from the underlying client', async () => {
    vi.mocked(Client).mockImplementationOnce(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          getInstructions: vi.fn().mockReturnValue(undefined),
          close: vi.fn().mockRejectedValue(new Error('transport broken')),
        }) as unknown as Client,
    );

    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test', args: []},
    });

    await manager.createSession();
    await expect(manager.close()).resolves.toBeUndefined();
  });

  it('getInstructions() returns undefined before any session is created', () => {
    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test', args: []},
    });

    expect(manager.getInstructions()).toBeUndefined();
  });

  it('caches new instructions after close() and reconnect', async () => {
    vi.mocked(Client)
      .mockImplementationOnce(
        () =>
          ({
            connect: vi.fn().mockResolvedValue(undefined),
            getInstructions: vi.fn().mockReturnValue('Instructions v1'),
            close: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      )
      .mockImplementationOnce(
        () =>
          ({
            connect: vi.fn().mockResolvedValue(undefined),
            getInstructions: vi.fn().mockReturnValue('Instructions v2'),
            close: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      );

    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test', args: []},
    });

    await manager.createSession();
    expect(manager.getInstructions()).toBe('Instructions v1');

    await manager.close();
    await manager.createSession();
    expect(manager.getInstructions()).toBe('Instructions v2');
  });

  // ---------------------------------------------------------------------------
  // Concurrency guard
  // ---------------------------------------------------------------------------

  it('coalesces concurrent createSession() calls into one Client', async () => {
    let connectResolve: () => void;
    const connectPromise = new Promise<void>((r) => {
      connectResolve = r;
    });

    vi.mocked(Client).mockImplementationOnce(
      () =>
        ({
          connect: vi.fn().mockReturnValue(connectPromise),
          getInstructions: vi.fn().mockReturnValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        }) as unknown as Client,
    );

    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test', args: []},
    });

    const p1 = manager.createSession();
    const p2 = manager.createSession();
    const p3 = manager.createSession();

    connectResolve!();

    const [c1, c2, c3] = await Promise.all([p1, p2, p3]);

    expect(c1).toBe(c2);
    expect(c2).toBe(c3);
    expect(Client).toHaveBeenCalledTimes(1);
  });

  it('retries after concurrent connection failure', async () => {
    vi.mocked(Client)
      .mockImplementationOnce(
        () =>
          ({
            connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
            getInstructions: vi.fn().mockReturnValue(undefined),
            close: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      )
      .mockImplementationOnce(
        () =>
          ({
            connect: vi.fn().mockResolvedValue(undefined),
            getInstructions: vi.fn().mockReturnValue(undefined),
            close: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      );

    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test', args: []},
    });

    await expect(manager.createSession()).rejects.toThrow('ECONNREFUSED');

    const client = await manager.createSession();
    expect(client).toBeDefined();
    expect(Client).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Transport disconnect (onclose)
  // ---------------------------------------------------------------------------

  it('clears cached state when transport disconnects (onclose)', async () => {
    let oncloseCallback: (() => void) | undefined;
    vi.mocked(Client).mockImplementationOnce(() => {
      const instance = {
        connect: vi.fn().mockResolvedValue(undefined),
        getInstructions: vi.fn().mockReturnValue('Server tips'),
        close: vi.fn().mockResolvedValue(undefined),
        onclose: undefined as (() => void) | undefined,
      };
      Object.defineProperty(instance, 'onclose', {
        set(fn: () => void) {
          oncloseCallback = fn;
        },
        get() {
          return oncloseCallback;
        },
      });
      return instance as unknown as Client;
    });

    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test', args: []},
    });

    await manager.createSession();
    expect(manager.getInstructions()).toBe('Server tips');

    oncloseCallback!();

    expect(manager.getInstructions()).toBeUndefined();
  });

  it('creates fresh client after transport disconnect', async () => {
    let oncloseCallback: (() => void) | undefined;
    vi.mocked(Client)
      .mockImplementationOnce(() => {
        const instance = {
          connect: vi.fn().mockResolvedValue(undefined),
          getInstructions: vi.fn().mockReturnValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          onclose: undefined as (() => void) | undefined,
        };
        Object.defineProperty(instance, 'onclose', {
          set(fn: () => void) {
            oncloseCallback = fn;
          },
          get() {
            return oncloseCallback;
          },
        });
        return instance as unknown as Client;
      })
      .mockImplementationOnce(
        () =>
          ({
            connect: vi.fn().mockResolvedValue(undefined),
            getInstructions: vi.fn().mockReturnValue(undefined),
            close: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      );

    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test', args: []},
    });

    const first = await manager.createSession();
    oncloseCallback!();

    const second = await manager.createSession();

    expect(first).not.toBe(second);
    expect(Client).toHaveBeenCalledTimes(2);
  });

  it('onclose does not clear state if a newer client replaced it', async () => {
    let firstOnclose: (() => void) | undefined;
    vi.mocked(Client)
      .mockImplementationOnce(() => {
        const instance = {
          connect: vi.fn().mockResolvedValue(undefined),
          getInstructions: vi.fn().mockReturnValue('v1'),
          close: vi.fn().mockResolvedValue(undefined),
          onclose: undefined as (() => void) | undefined,
        };
        Object.defineProperty(instance, 'onclose', {
          set(fn: () => void) {
            firstOnclose = fn;
          },
          get() {
            return firstOnclose;
          },
        });
        return instance as unknown as Client;
      })
      .mockImplementationOnce(
        () =>
          ({
            connect: vi.fn().mockResolvedValue(undefined),
            getInstructions: vi.fn().mockReturnValue('v2'),
            close: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      );

    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test', args: []},
    });

    await manager.createSession();
    await manager.close();
    await manager.createSession();

    firstOnclose!();

    expect(manager.getInstructions()).toBe('v2');
  });
});
