/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  InvocationContext,
  LoopAgent,
  PluginManager,
  RemoteAgent,
  RemoteAgentFetch,
  createEvent,
  createSession,
  isRemoteAgent,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

describe('RemoteAgent', () => {
  it('posts invocation_id and null-stripped snake_case session and overrides returned event author', async () => {
    const remoteEvents = [
      {
        id: 'evt-remote-1',
        invocation_id: 'inv-remote',
        timestamp: 1_700_000_001.5,
        author: 'upstream_worker',
        content: {
          role: 'model',
          parts: [{text: 'Remote answer 1'}],
        },
      },
      {
        id: 'evt-remote-2',
        invocation_id: 'inv-remote',
        author: 'another_upstream_worker',
        content: {
          role: 'model',
          parts: [{text: 'Remote answer 2'}],
        },
      },
    ];

    const mockFetch = vi.fn<RemoteAgentFetch>().mockResolvedValue(
      new Response(JSON.stringify(remoteEvents), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      }),
    );

    const agent = new RemoteAgent({
      name: 'delegated_remote_agent',
      description: 'Calls a remote endpoint',
      url: 'https://example.test/agent/run',
      fetchImpl: mockFetch,
    });

    const userEvent = createEvent({
      id: 'evt-user-1',
      invocationId: 'inv-remote',
      author: 'user',
      branch: undefined,
      timestamp: 1_700_000_000_250,
      actions: {
        stateDelta: {
          deltaNull: null,
          deltaVal: 'present',
        },
      },
      content: {
        role: 'user',
        parts: [
          {text: 'Hello remote'},
          {
            functionCall: {
              name: 'lookup_tool',
              args: {query: 'test', filter: null},
            },
          },
          {
            functionResponse: {
              name: 'lookup_tool',
              response: {result: null},
            },
          },
        ],
      },
    });

    const session = createSession({
      id: 'session-123',
      appName: 'app-test',
      userId: 'user-456',
      state: {
        activeKey: 'value',
        emptyNull: null,
        emptyUndefined: undefined,
        nested: {
          keep: 42,
          dropNull: null,
          dropUndefined: undefined,
        },
      },
      events: [userEvent],
      lastUpdateTime: 1_700_000_000_500,
    });

    const context = new InvocationContext({
      invocationId: 'inv-remote',
      agent,
      session,
      pluginManager: new PluginManager(),
    });

    const yielded: Event[] = [];
    for await (const event of agent.runAsync(context)) {
      yielded.push(event);
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, requestInit] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe('https://example.test/agent/run');
    expect(requestInit?.method).toBe('POST');
    expect(requestInit?.headers).toEqual({'Content-Type': 'application/json'});

    const rawBody =
      typeof requestInit?.body === 'string' ? requestInit.body : '{}';
    const parsedBody: {
      invocation_id?: string;
      session?: {
        id?: string;
        app_name?: string;
        user_id?: string;
        last_update_time?: number;
        state?: Record<string, unknown>;
        events?: Array<Record<string, unknown>>;
      };
    } = JSON.parse(rawBody);
    expect(parsedBody.invocation_id).toBe('inv-remote');
    expect(parsedBody.session?.id).toBe('session-123');
    expect(parsedBody.session?.app_name).toBe('app-test');
    expect(parsedBody.session?.user_id).toBe('user-456');
    expect(parsedBody.session?.last_update_time).toBe(1_700_000_000.5);
    expect(parsedBody.session?.events?.[0]?.['invocation_id']).toBe(
      'inv-remote',
    );
    expect(parsedBody.session?.events?.[0]?.['timestamp']).toBe(
      1_700_000_000.25,
    );
    expect(
      parsedBody.session?.events?.[0] !== undefined &&
        'branch' in parsedBody.session.events[0],
    ).toBe(false);
    expect(parsedBody.session?.state).toEqual({
      activeKey: 'value',
      emptyNull: null,
      nested: {keep: 42, dropNull: null},
    });
    expect(
      parsedBody.session?.state !== undefined &&
        'emptyUndefined' in parsedBody.session.state,
    ).toBe(false);
    expect(parsedBody.session?.events?.[0]?.['actions']).toEqual({
      state_delta: {
        deltaNull: null,
        deltaVal: 'present',
      },
      artifact_delta: {},
      requested_auth_configs: {},
      requested_tool_confirmations: {},
    });
    expect(parsedBody.session?.events?.[0]?.['content']).toEqual({
      role: 'user',
      parts: [
        {text: 'Hello remote'},
        {
          function_call: {
            name: 'lookup_tool',
            args: {query: 'test', filter: null},
          },
        },
        {
          function_response: {
            name: 'lookup_tool',
            response: {result: null},
          },
        },
      ],
    });

    expect(yielded).toHaveLength(2);
    expect(yielded[0].author).toBe('delegated_remote_agent');
    expect(yielded[0].timestamp).toBe(1_700_000_001_500);
    expect(yielded[0].content?.parts?.[0]?.text).toBe('Remote answer 1');
    expect(yielded[1].author).toBe('delegated_remote_agent');
    expect(yielded[1].timestamp).toBeGreaterThanOrEqual(1_700_000_000_000);
    expect(yielded[1].content?.parts?.[0]?.text).toBe('Remote answer 2');
  });

  it('throws when the remote endpoint responds with HTTP status >= 400', async () => {
    const mockFetch = vi
      .fn<RemoteAgentFetch>()
      .mockResolvedValue(new Response('Internal Server Error', {status: 500}));

    const agent = new RemoteAgent({
      name: 'failing_remote_agent',
      url: 'https://example.test/agent/fail',
      fetchImpl: mockFetch,
    });

    const context = new InvocationContext({
      invocationId: 'inv-500',
      agent,
      session: createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
      }),
      pluginManager: new PluginManager(),
    });

    const run = async () => {
      for await (const _event of agent.runAsync(context)) {
        // Expect failure before yielding.
      }
    };

    await expect(run()).rejects.toThrowError(/HTTP status 500/);
  });

  it('throws when the remote endpoint returns a non-array JSON payload', async () => {
    const mockFetch = vi.fn<RemoteAgentFetch>().mockResolvedValue(
      new Response(JSON.stringify({error: 'not an array'}), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      }),
    );

    const agent = new RemoteAgent({
      name: 'bad_json_remote_agent',
      url: 'https://example.test/agent/object',
      fetchImpl: mockFetch,
    });

    const context = new InvocationContext({
      invocationId: 'inv-bad-json',
      agent,
      session: createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
      }),
      pluginManager: new PluginManager(),
    });

    const run = async () => {
      for await (const _event of agent.runAsync(context)) {
        // Expect failure before yielding.
      }
    };

    await expect(run()).rejects.toThrowError(
      /RemoteAgent expected a JSON array of events/,
    );
  });

  it('throws when the remote endpoint returns a non-object element in the events array', async () => {
    const mockFetch = vi.fn<RemoteAgentFetch>().mockResolvedValue(
      new Response(JSON.stringify([null]), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      }),
    );

    const agent = new RemoteAgent({
      name: 'bad_item_remote_agent',
      url: 'https://example.test/agent/item',
      fetchImpl: mockFetch,
    });

    const context = new InvocationContext({
      invocationId: 'inv-bad-item',
      agent,
      session: createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
      }),
      pluginManager: new PluginManager(),
    });

    const run = async () => {
      for await (const _event of agent.runAsync(context)) {
        // Expect failure before yielding.
      }
    };

    await expect(run()).rejects.toThrowError(
      /RemoteAgent expected each item in the response .* to be a JSON event object/,
    );
  });

  it('rejects subAgents in configuration at runtime', () => {
    expect(() =>
      Reflect.construct(RemoteAgent, [
        {
          name: 'invalid_remote',
          url: 'https://example.test/agent',
          subAgents: [new LoopAgent({name: 'child'})],
        },
      ]),
    ).toThrowError('subAgents is disabled in RemoteAgent.');
  });

  it('identifies RemoteAgent via isRemoteAgent, supports clone, and rejects runLive', async () => {
    const mockFetch = vi.fn<RemoteAgentFetch>();
    const agent = new RemoteAgent({
      name: 'remote_1',
      url: 'https://example.test/v1',
      fetchImpl: mockFetch,
    });

    expect(isRemoteAgent(agent)).toBe(true);
    expect(isRemoteAgent(new LoopAgent({name: 'loop'}))).toBe(false);
    expect(isRemoteAgent(undefined)).toBe(false);

    const cloned = agent.clone({
      name: 'remote_2',
      url: 'https://example.test/v2',
    });
    expect(isRemoteAgent(cloned)).toBe(true);
    expect(cloned.name).toBe('remote_2');
    expect(cloned.url).toBe('https://example.test/v2');

    const context = new InvocationContext({
      invocationId: 'inv-live',
      agent,
      session: createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
      }),
      pluginManager: new PluginManager(),
    });

    const runLive = async () => {
      for await (const _event of agent.runLive(context)) {
        // Should throw before yielding.
      }
    };

    await expect(runLive()).rejects.toThrowError(
      'This is not supported yet for RemoteAgent.',
    );
  });

  it('converts snake_case wire event fields and stops yielding when abortSignal is aborted', async () => {
    const abortController = new AbortController();
    const rawWireEvents = [
      {
        id: 'evt-wire-1',
        invocation_id: 'wire-inv-1',
        long_running_tool_ids: ['tool-1', 'tool-2'],
        actions: {
          state_delta: {snake_state_key: 'preserved'},
          transfer_to_agent: 'target_agent',
        },
        author: 'remote_worker',
        content: {
          role: 'model',
          parts: [{text: 'First wire event'}],
        },
      },
      {
        id: 'evt-wire-2',
        invocation_id: 'wire-inv-2',
        author: 'remote_worker',
        content: {
          role: 'model',
          parts: [{text: 'Second wire event'}],
        },
      },
    ];

    const mockFetch = vi.fn<RemoteAgentFetch>().mockResolvedValue(
      new Response(JSON.stringify(rawWireEvents), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      }),
    );

    const agent = new RemoteAgent({
      name: 'cancellable_remote_agent',
      url: 'https://example.test/agent/stream',
      timeoutMs: 60_000,
      fetchImpl: mockFetch,
    });

    const context = new InvocationContext({
      invocationId: 'fallback-inv',
      agent,
      session: createSession({
        id: 's-wire',
        appName: 'app',
        userId: 'u1',
      }),
      pluginManager: new PluginManager(),
      abortSignal: abortController.signal,
    });

    const yielded: Event[] = [];
    for await (const event of agent.runAsync(context)) {
      yielded.push(event);
      abortController.abort();
    }

    expect(yielded).toHaveLength(1);
    expect(yielded[0].invocationId).toBe('wire-inv-1');
    expect(yielded[0].longRunningToolIds).toEqual(['tool-1', 'tool-2']);
    expect(yielded[0].actions.stateDelta).toEqual({
      snake_state_key: 'preserved',
    });
    expect(yielded[0].actions.transferToAgent).toBe('target_agent');
    expect(yielded[0].author).toBe('cancellable_remote_agent');
  });
});
