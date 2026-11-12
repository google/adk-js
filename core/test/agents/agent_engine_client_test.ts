/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {helpers, v1} from '@google-cloud/aiplatform';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AgentEngineClient,
  AgentExecutionError,
} from '../../src/agents/agent_engine_client.js';
import type {OptionalPeer} from '../../src/utils/optional_peer.js';

// When `missing` is set, the real `loadOptionalPeer` runs against a loader that
// fails the way Node does for an uninstalled package.
const peerState = vi.hoisted(() => ({missing: false}));

vi.mock('../../src/utils/optional_peer.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/optional_peer.js')>();
  return {
    ...actual,
    loadOptionalPeer: <T>(peer: OptionalPeer, load: () => Promise<T>) =>
      actual.loadOptionalPeer(
        peer,
        peerState.missing
          ? () =>
              Promise.reject(
                Object.assign(
                  new Error(`Cannot find package '${peer.packageName}'`),
                  {code: 'ERR_MODULE_NOT_FOUND'},
                ),
              )
          : load,
      ),
  };
});

// Mock the grpc client. The method mocks are hoisted so the tests can drive
// them directly instead of reaching into `.mock.instances[0]`, which is typed
// as the real client and therefore not assignable to a mock-shaped local.
const mockGrpcClient = vi.hoisted(() => ({
  reasoningEnginePath: vi.fn(
    (project: string, location: string, id: string) =>
      `projects/${project}/locations/${location}/reasoningEngines/${id}`,
  ),
  queryReasoningEngine: vi.fn(),
  streamQueryReasoningEngine: vi.fn(),
  close: vi.fn(),
}));

vi.mock('@google-cloud/aiplatform', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google-cloud/aiplatform')>();
  const MockReasoningEngineExecutionServiceClient = vi.fn();
  Object.assign(
    MockReasoningEngineExecutionServiceClient.prototype,
    mockGrpcClient,
  );

  return {
    ...actual,
    v1: {
      ...actual.v1,
      ReasoningEngineExecutionServiceClient:
        MockReasoningEngineExecutionServiceClient,
    },
  };
});

describe('AgentEngineClient', () => {
  const mockConfig = {
    project: 'test-project',
    location: 'us-central1',
    reasoningEngineId: '12345',
  };

  let client: AgentEngineClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new AgentEngineClient(mockConfig);
  });

  describe('constructor', () => {
    it('instantiates client with correct endpoint on the first call', async () => {
      expect(client).toBeInstanceOf(AgentEngineClient);
      expect(v1.ReasoningEngineExecutionServiceClient).not.toHaveBeenCalled();

      mockGrpcClient.queryReasoningEngine.mockResolvedValue([{}]);
      await client.query({message: 'hello'});

      expect(v1.ReasoningEngineExecutionServiceClient).toHaveBeenCalledTimes(1);
      expect(v1.ReasoningEngineExecutionServiceClient).toHaveBeenCalledWith({
        apiEndpoint: 'us-central1-aiplatform.googleapis.com',
      });
      expect(mockGrpcClient.queryReasoningEngine).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'projects/test-project/locations/us-central1/reasoningEngines/12345',
        }),
      );
    });

    it('reuses one gRPC client across calls', async () => {
      mockGrpcClient.queryReasoningEngine.mockResolvedValue([{}]);
      await client.query({message: 'one'});
      await client.createSession({userId: 'u1'});

      expect(v1.ReasoningEngineExecutionServiceClient).toHaveBeenCalledTimes(1);
    });

    it('resolves the global location to aiplatform.googleapis.com', async () => {
      mockGrpcClient.queryReasoningEngine.mockResolvedValue([{}]);
      const globalClient = new AgentEngineClient({
        ...mockConfig,
        location: 'global',
      });
      await globalClient.query({message: 'hello'});

      expect(v1.ReasoningEngineExecutionServiceClient).toHaveBeenCalledWith({
        apiEndpoint: 'aiplatform.googleapis.com',
      });
      expect(mockGrpcClient.queryReasoningEngine).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'projects/test-project/locations/global/reasoningEngines/12345',
        }),
      );
    });

    it('uses an explicit apiEndpoint over the resolved one', async () => {
      mockGrpcClient.queryReasoningEngine.mockResolvedValue([{}]);
      const customClient = new AgentEngineClient({
        ...mockConfig,
        apiEndpoint: 'custom.example.com',
      });
      await customClient.query({message: 'hello'});

      expect(v1.ReasoningEngineExecutionServiceClient).toHaveBeenCalledWith({
        apiEndpoint: 'custom.example.com',
      });
    });
  });

  describe('optional peer loading', () => {
    beforeEach(() => {
      peerState.missing = false;
    });

    it('reports a missing @google-cloud/aiplatform with the install command', async () => {
      peerState.missing = true;

      const result = client.query({message: 'hello'});

      await expect(result).rejects.toThrow(AgentExecutionError);
      await expect(result).rejects.toThrow(
        /^Failed to execute query: AgentEngineClient requires the optional peer dependency "@google-cloud\/aiplatform"/,
      );
      await expect(result).rejects.toThrow(
        /npm install @google-cloud\/aiplatform/,
      );
      expect(v1.ReasoningEngineExecutionServiceClient).not.toHaveBeenCalled();
    });

    it('reports a missing peer from streamQuery', async () => {
      peerState.missing = true;

      const gen = client.streamQuery({message: 'hello'});

      await expect(gen.next()).rejects.toThrow(
        /npm install @google-cloud\/aiplatform/,
      );
    });

    it('does not cache a failed load, so a later call can succeed', async () => {
      peerState.missing = true;
      await expect(client.query({message: 'hello'})).rejects.toThrow(
        AgentExecutionError,
      );

      peerState.missing = false;
      mockGrpcClient.queryReasoningEngine.mockResolvedValue([
        {output: helpers.toValue({answer: 'ok'})},
      ]);

      await expect(client.query({message: 'hello'})).resolves.toEqual({
        answer: 'ok',
      });
      expect(v1.ReasoningEngineExecutionServiceClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('classMethod', () => {
    beforeEach(() => {
      mockGrpcClient.queryReasoningEngine.mockResolvedValue([{}]);
    });

    it.each([
      {
        name: 'query',
        call: (c: AgentEngineClient) => c.query({message: 'hi'}),
        expected: 'query',
      },
      {
        name: 'createSession',
        call: (c: AgentEngineClient) => c.createSession({userId: 'u1'}),
        expected: 'async_create_session',
      },
      {
        name: 'getSession',
        call: (c: AgentEngineClient) =>
          c.getSession({userId: 'u1', sessionId: 's1'}),
        expected: 'async_get_session',
      },
      {
        name: 'listSessions',
        call: (c: AgentEngineClient) => c.listSessions({userId: 'u1'}),
        expected: 'async_list_sessions',
      },
      {
        name: 'deleteSession',
        call: (c: AgentEngineClient) =>
          c.deleteSession({userId: 'u1', sessionId: 's1'}),
        expected: 'async_delete_session',
      },
    ])('$name calls the $expected class method', async ({call, expected}) => {
      await call(client);

      expect(mockGrpcClient.queryReasoningEngine).toHaveBeenCalledWith(
        expect.objectContaining({classMethod: expected}),
      );
    });

    it('streamQuery calls the async_stream_query class method', async () => {
      async function* mockStream() {}
      mockGrpcClient.streamQueryReasoningEngine.mockReturnValue(mockStream());

      for await (const _ of client.streamQuery({message: 'hi'})) {
        // Drain the stream.
      }

      expect(mockGrpcClient.streamQueryReasoningEngine).toHaveBeenCalledWith(
        expect.objectContaining({classMethod: 'async_stream_query'}),
      );
    });

    it('sends an overriding classMethod on the request, not in input', async () => {
      await client.query({message: 'hi', classMethod: 'custom'});

      const request = mockGrpcClient.queryReasoningEngine.mock.calls[0][0];
      expect(request.classMethod).toBe('custom');
      expect(request.input.fields).not.toHaveProperty('classMethod');
      expect(request.input.fields).toHaveProperty('message');
    });

    it('sends an overriding classMethod from streamQuery on the request', async () => {
      async function* mockStream() {}
      mockGrpcClient.streamQueryReasoningEngine.mockReturnValue(mockStream());

      for await (const _ of client.streamQuery({
        message: 'hi',
        classMethod: 'stream_query',
      })) {
        // Drain the stream.
      }

      const request =
        mockGrpcClient.streamQueryReasoningEngine.mock.calls[0][0];
      expect(request.classMethod).toBe('stream_query');
      expect(request.input.fields).not.toHaveProperty('classMethod');
    });
  });

  describe('wire input', () => {
    beforeEach(() => {
      mockGrpcClient.queryReasoningEngine.mockResolvedValue([{}]);
    });

    function sentInput(): unknown {
      return helpers.fromValue({
        kind: 'structValue',
        structValue: mockGrpcClient.queryReasoningEngine.mock.calls[0][0].input,
      });
    }

    it('sends session keys in snake_case', async () => {
      await client.createSession({
        userId: 'u1',
        sessionId: 's1',
        expireTime: '2026-12-31T00:00:00Z',
      });

      expect(sentInput()).toEqual({
        user_id: 'u1',
        session_id: 's1',
        expire_time: '2026-12-31T00:00:00Z',
      });
    });

    it('renames runConfig and stateDelta and keeps nested keys as they are', async () => {
      await client.query({
        userId: 'u1',
        sessionId: 's1',
        message: {role: 'user', parts: [{text: 'hello'}]},
        runConfig: {maxLlmCalls: 5},
        stateDelta: {someCount: 1},
        state: {nestedKey: {innerKey: true}},
        customMetadata: {requestId: 'abc'},
      });

      expect(sentInput()).toEqual({
        user_id: 'u1',
        session_id: 's1',
        message: {role: 'user', parts: [{text: 'hello'}]},
        run_config: {maxLlmCalls: 5},
        state_delta: {someCount: 1},
        state: {nestedKey: {innerKey: true}},
        customMetadata: {requestId: 'abc'},
      });
    });

    it('prefers the snake_case value when both spellings are given', async () => {
      await client.createSession({
        userId: 'camel-user',
        user_id: 'snake-user',
        sessionId: 'camel-session',
        session_id: 'snake-session',
      });

      expect(sentInput()).toEqual({
        user_id: 'snake-user',
        session_id: 'snake-session',
      });
    });

    it('omits undefined values', async () => {
      await client.createSession({userId: 'u1', sessionId: undefined});

      expect(sentInput()).toEqual({user_id: 'u1'});
    });
  });

  describe('session operations', () => {
    it('getSession returns the parsed session', async () => {
      mockGrpcClient.queryReasoningEngine.mockResolvedValue([
        {output: helpers.toValue({id: 's1', userId: 'u1'})},
      ]);

      await expect(
        client.getSession({user_id: 'u1', session_id: 's1'}),
      ).resolves.toEqual({id: 's1', userId: 'u1'});
    });

    it.each([
      {name: 'user id', config: {sessionId: 's1'}},
      {name: 'session id', config: {userId: 'u1'}},
    ])(
      'getSession rejects a missing $name before any call',
      async ({config}) => {
        await expect(client.getSession(config)).rejects.toThrow(
          'Failed to get session: user_id and session_id are required',
        );
        expect(mockGrpcClient.queryReasoningEngine).not.toHaveBeenCalled();
      },
    );

    it('listSessions returns the parsed list', async () => {
      mockGrpcClient.queryReasoningEngine.mockResolvedValue([
        {output: helpers.toValue({sessions: [{id: 's1'}]})},
      ]);

      await expect(client.listSessions({userId: 'u1'})).resolves.toEqual({
        sessions: [{id: 's1'}],
      });
    });

    it('deleteSession resolves to undefined', async () => {
      mockGrpcClient.queryReasoningEngine.mockResolvedValue([
        {output: helpers.toValue({ignored: true})},
      ]);

      await expect(
        client.deleteSession({userId: 'u1', sessionId: 's1'}),
      ).resolves.toBeUndefined();
    });

    it.each([
      {
        name: 'getSession',
        call: (c: AgentEngineClient) =>
          c.getSession({userId: 'u1', sessionId: 's1'}),
        prefix: 'Failed to get session: API Error',
      },
      {
        name: 'listSessions',
        call: (c: AgentEngineClient) => c.listSessions({userId: 'u1'}),
        prefix: 'Failed to list sessions: API Error',
      },
      {
        name: 'deleteSession',
        call: (c: AgentEngineClient) =>
          c.deleteSession({userId: 'u1', sessionId: 's1'}),
        prefix: 'Failed to delete session: API Error',
      },
    ])(
      '$name wraps a failure in AgentExecutionError',
      async ({call, prefix}) => {
        mockGrpcClient.queryReasoningEngine.mockRejectedValue(
          new Error('API Error'),
        );

        const result = call(client);

        await expect(result).rejects.toThrow(AgentExecutionError);
        await expect(result).rejects.toThrow(prefix);
      },
    );
  });

  describe('close', () => {
    it('does nothing when no call has created the client', async () => {
      await expect(client.close()).resolves.toBeUndefined();

      expect(v1.ReasoningEngineExecutionServiceClient).not.toHaveBeenCalled();
      expect(mockGrpcClient.close).not.toHaveBeenCalled();
    });

    it('closes the gRPC client once, even when called twice', async () => {
      mockGrpcClient.queryReasoningEngine.mockResolvedValue([{}]);
      await client.query({message: 'hello'});

      await client.close();
      await client.close();

      expect(mockGrpcClient.close).toHaveBeenCalledTimes(1);
    });

    it('does not throw when the client could not be created', async () => {
      peerState.missing = true;
      try {
        const pending = client.query({message: 'hello'});
        await expect(client.close()).resolves.toBeUndefined();
        await expect(pending).rejects.toThrow(AgentExecutionError);
      } finally {
        peerState.missing = false;
      }
      expect(mockGrpcClient.close).not.toHaveBeenCalled();
    });
  });

  describe('createSession', () => {
    it('calls queryReasoningEngine with correct struct', async () => {
      mockGrpcClient.queryReasoningEngine.mockResolvedValue([{}]);
      await client.createSession({userId: 'u1', sessionId: 's1'});

      expect(mockGrpcClient.queryReasoningEngine).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'projects/test-project/locations/us-central1/reasoningEngines/12345',
          input: expect.objectContaining({
            fields: expect.objectContaining({
              user_id: expect.objectContaining({stringValue: 'u1'}),
              session_id: expect.objectContaining({stringValue: 's1'}),
            }),
          }),
        }),
      );
    });

    it('throws AgentExecutionError on failure', async () => {
      mockGrpcClient.queryReasoningEngine.mockRejectedValue(
        new Error('API Error'),
      );
      await expect(client.createSession({userId: '1'})).rejects.toThrow(
        AgentExecutionError,
      );
      await expect(client.createSession({userId: '1'})).rejects.toThrow(
        'Failed to create session: API Error',
      );
    });

    it('throws AgentExecutionError on failure with primitive error', async () => {
      mockGrpcClient.queryReasoningEngine.mockRejectedValue('Primitive Error');
      await expect(client.createSession({userId: '1'})).rejects.toThrow(
        AgentExecutionError,
      );
      await expect(client.createSession({userId: '1'})).rejects.toThrow(
        'Failed to create session: Primitive Error',
      );
    });

    it('returns the created session so a generated sessionId is readable', async () => {
      mockGrpcClient.queryReasoningEngine.mockResolvedValue([
        {
          output: helpers.toValue({
            id: 'generated-session-id',
            userId: 'u1',
          }),
        },
      ]);

      const created = await client.createSession({userId: 'u1'});

      expect(created).toEqual({id: 'generated-session-id', userId: 'u1'});
    });

    it('returns undefined when the response carries no output', async () => {
      mockGrpcClient.queryReasoningEngine.mockResolvedValue([{}]);

      await expect(
        client.createSession({userId: 'u1'}),
      ).resolves.toBeUndefined();
    });
  });

  describe('query', () => {
    it('executes and unmarshals result correctly', async () => {
      mockGrpcClient.queryReasoningEngine.mockResolvedValue([
        {
          output: helpers.toValue({answer: 'response text'}),
        },
      ]);

      const res = await client.query({message: 'hello'});
      expect(res).toEqual({answer: 'response text'});
    });

    it('handles missing output', async () => {
      mockGrpcClient.queryReasoningEngine.mockResolvedValue([{}]);
      const res = await client.query({message: 'hello'});
      expect(res).toBeUndefined();
    });

    it('throws AgentExecutionError on failure', async () => {
      mockGrpcClient.queryReasoningEngine.mockRejectedValue(
        new Error('API crash'),
      );
      await expect(client.query({message: 'hello'})).rejects.toThrow(
        AgentExecutionError,
      );
    });

    it('throws AgentExecutionError on failure with primitive error', async () => {
      mockGrpcClient.queryReasoningEngine.mockRejectedValue('String Error');
      await expect(client.query({message: 'test'})).rejects.toThrow(
        AgentExecutionError,
      );
      await expect(client.query({message: 'test'})).rejects.toThrow(
        'Failed to execute query: String Error',
      );
    });
  });

  describe('streamQuery', () => {
    it('smoothly parses SSE JSON stream', async () => {
      async function* mockStream() {
        yield {data: 'data: {"answer": "part 1"}\n\n'};
        yield {data: 'data: {"answer": "part 2"}\n\n'};
        yield {data: '[DONE]\n\n'};
      }

      mockGrpcClient.streamQueryReasoningEngine.mockReturnValue(mockStream());

      const chunks = [];
      for await (const chunk of client.streamQuery({message: 'test'})) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([{answer: 'part 1'}, {answer: 'part 2'}]);
    });

    it('smoothly parses SSE JSON stream with Uint8Array data', async () => {
      async function* mockStream() {
        yield {
          data: new TextEncoder().encode('data: {"answer": "part 1"}\n\n'),
        };
        yield {data: new TextEncoder().encode('[DONE]\n\n')};
      }
      mockGrpcClient.streamQueryReasoningEngine.mockReturnValue(mockStream());
      const chunks = [];
      for await (const chunk of client.streamQuery({message: 'test'})) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual([{answer: 'part 1'}]);
    });

    it('handles fragmented parses without throwing if JSON completes', async () => {
      async function* mockStream() {
        yield {data: 'data: {"partial"'};
        yield {data: ': "yes"}\n\n'};
      }

      mockGrpcClient.streamQueryReasoningEngine.mockReturnValue(mockStream());
      const chunks = [];
      for await (const chunk of client.streamQuery({message: 'test'})) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual([{partial: 'yes'}]);
    });

    it('yields plain object chunk if returned instead of string', async () => {
      async function* mockStream() {
        yield {answer: 'raw-object'}; // simulate what happens if raw object passed
        yield 'plain string'; // simulate string without data field
        yield null; // simulate null
      }

      mockGrpcClient.streamQueryReasoningEngine.mockReturnValue(mockStream());
      const chunks = [];
      for await (const chunk of client.streamQuery({message: 'test'})) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual([{answer: 'raw-object'}]);
    });

    it('throws AgentExecutionError on underlying failure', async () => {
      mockGrpcClient.streamQueryReasoningEngine.mockImplementation(() => {
        throw new Error('Stream start error');
      });

      const gen = client.streamQuery({message: 'hello'});
      await expect(gen.next()).rejects.toThrow(AgentExecutionError);
    });

    it('throws AgentExecutionError if parse fails terribly on stream end', async () => {
      async function* mockStream() {
        yield {data: 'data: {invalid-json\n\n'};
      }
      mockGrpcClient.streamQueryReasoningEngine.mockReturnValue(mockStream());

      const gen = client.streamQuery({message: 'hello'});
      const promise = gen.next();
      await expect(promise).rejects.toThrow(AgentExecutionError);
      await expect(promise).rejects.toThrow('Failed to parse stream fragment');
    });

    it('does not re-wrap a parse failure in a second AgentExecutionError', async () => {
      async function* mockStream() {
        yield {data: 'data: {invalid-json\n\n'};
      }
      mockGrpcClient.streamQueryReasoningEngine.mockReturnValue(mockStream());

      const gen = client.streamQuery({message: 'hello'});
      // Anchored: a re-wrap would prefix 'Failed to execute stream query: '.
      await expect(gen.next()).rejects.toThrow(
        /^Failed to parse stream fragment: \{invalid-json$/,
      );
    });

    it('throws AgentExecutionError on stream query failure with primitive error', async () => {
      mockGrpcClient.streamQueryReasoningEngine.mockImplementation(() => {
        throw 'String Stream Error';
      });
      const items = [];
      try {
        for await (const chunk of client.streamQuery({message: 'hello'})) {
          items.push(chunk);
        }
      } catch (err) {
        expect(err).toBeInstanceOf(AgentExecutionError);
        expect((err as Error).message).toContain('String Stream Error');
      }
    });

    it('smoothly parses SSE JSON stream with data: no-space', async () => {
      async function* mockStream() {
        yield {data: 'data:{"answer": "part no-space"}\n\n'};
      }
      mockGrpcClient.streamQueryReasoningEngine.mockReturnValue(mockStream());
      const chunks = [];
      for await (const chunk of client.streamQuery({message: 'test'})) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual([{answer: 'part no-space'}]);
    });

    it('smoothly parses SSE JSON stream when remaining buffer flushed at end', async () => {
      async function* mockStream() {
        // Yield payload WITHOUT newline so it sits in buffer until the end.
        yield {data: 'data: {"buffer": "only"}'};
      }
      mockGrpcClient.streamQueryReasoningEngine.mockReturnValue(mockStream());
      const chunks = [];
      for await (const chunk of client.streamQuery({message: 'test'})) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual([{buffer: 'only'}]);
    });

    it('smoothly parses SSE JSON stream when remaining buffer is data: without space', async () => {
      async function* mockStream() {
        yield {data: 'data:{"buffer": "space"}'};
      }
      mockGrpcClient.streamQueryReasoningEngine.mockReturnValue(mockStream());
      const chunks = [];
      for await (const chunk of client.streamQuery({message: 'test'})) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual([{buffer: 'space'}]);
    });

    it('throws AgentExecutionError when remaining buffer flushed at end fails to parse', async () => {
      async function* mockStream() {
        yield {data: 'data: {"buffer": "bad JSON'};
      }
      mockGrpcClient.streamQueryReasoningEngine.mockReturnValue(mockStream());
      const gen = client.streamQuery({message: 'test'});
      await expect(gen.next()).rejects.toThrow(AgentExecutionError);
    });

    async function collect(chunks: unknown[]): Promise<unknown[]> {
      async function* mockStream() {
        yield* chunks;
      }
      mockGrpcClient.streamQueryReasoningEngine.mockReturnValue(mockStream());
      const results = [];
      for await (const chunk of client.streamQuery({message: 'test'})) {
        results.push(chunk);
      }
      return results;
    }

    it('ignores SSE comments and the event, id and retry fields', async () => {
      const results = await collect([
        {data: ': keep-alive\n\n'},
        {data: 'event: message\nid: 42\nretry: 1000\n'},
        {data: 'data: {"answer": "one"}\n\n'},
        {data: 'event\nid\nretry\n:\n\n'},
      ]);

      expect(results).toEqual([{answer: 'one'}]);
    });

    it('accepts SSE lines that start with spaces or tabs', async () => {
      const results = await collect([
        {data: '  data: {"a": 1}\n\n'},
        {data: '\t: keep-alive\n  event: message\n\tdata: {"b": 2}\n\n'},
      ]);

      expect(results).toEqual([{a: 1}, {b: 2}]);
    });

    it('joins a multi-line data event at the blank line', async () => {
      const results = await collect([{data: 'data: {"a":\ndata: 1}\n\n'}]);

      expect(results).toEqual([{a: 1}]);
    });

    it('parses each data line on its own when events have no blank line between them', async () => {
      const results = await collect([
        {data: 'data: {"a": 1}\ndata: {"b": 2}\ndata: [DONE]\n'},
      ]);

      expect(results).toEqual([{a: 1}, {b: 2}]);
    });

    it('yields the first event before stream end when consecutive data lines have no blank line', async () => {
      let sendSecondChunk!: () => void;
      const secondChunkGate = new Promise<void>((resolve) => {
        sendSecondChunk = resolve;
      });
      let finishStream!: () => void;
      const finishGate = new Promise<void>((resolve) => {
        finishStream = resolve;
      });

      async function* mockStream() {
        yield {data: 'data: {"a": 1}\n'};
        await secondChunkGate;
        yield {data: 'data: {"b": 2}\n'};
        await finishGate;
      }

      mockGrpcClient.streamQueryReasoningEngine.mockReturnValue(mockStream());
      const gen = client.streamQuery({message: 'test'});

      sendSecondChunk();
      const first = await gen.next();
      expect(first).toEqual({value: {a: 1}, done: false});

      finishStream();
      const second = await gen.next();
      expect(second).toEqual({value: {b: 2}, done: false});

      const end = await gen.next();
      expect(end).toEqual({value: undefined, done: true});
    });

    it('parses a multi-line data event split across multiple data lines as a single object', async () => {
      const results = await collect([
        {data: 'data: {\ndata: "a": 1\ndata: }\n\n'},
      ]);

      expect(results).toEqual([{a: 1}]);
    });

    it('parses a large multi-line data event split across many data lines', async () => {
      const parseSpy = vi.spyOn(JSON, 'parse');
      try {
        const lines = ['{'];
        for (let i = 0; i < 50; i++) {
          lines.push(`"key_${i}": ${i}${i < 49 ? ',' : ''}`);
        }
        lines.push('}');
        const payload = lines.map((l) => `data: ${l}\n`).join('') + '\n';
        const results = await collect([{data: payload}]);

        expect(results).toHaveLength(1);
        const obj = results[0] as Record<string, number>;
        expect(obj['key_0']).toBe(0);
        expect(obj['key_49']).toBe(49);

        // An early parse attempt runs on line 2 (when dataLines.length === 1 with
        // '{') and fails. Intermediate lines (dataLines.length > 1) must not call
        // JSON.parse. The only other call is on the blank line dispatching the
        // complete object.
        expect(parseSpy).toHaveBeenCalledTimes(2);
        expect(parseSpy).toHaveBeenNthCalledWith(1, '{');
        expect(parseSpy).toHaveBeenNthCalledWith(2, lines.join('\n'));
      } finally {
        parseSpy.mockRestore();
      }
    });

    it('throws the joined-payload error when a multi-line event and its lines fail to parse', async () => {
      const promise = collect([{data: 'data: {"a":\ndata: {bad\n\n'}]);

      await expect(promise).rejects.toThrow(AgentExecutionError);
      await expect(promise).rejects.toThrow(
        /^Failed to parse stream fragment: \{"a":\n\{bad$/,
      );
    });

    it('parses an SSE stream with CRLF line endings', async () => {
      const results = await collect([
        {data: 'event: message\r\ndata: {"answer": "one"}\r\n\r\n'},
        {data: 'data: {"answer": "two"}\r\n\r\n'},
      ]);

      expect(results).toEqual([{answer: 'one'}, {answer: 'two'}]);
    });

    it('parses a newline-delimited JSON stream', async () => {
      const results = await collect([
        {data: '{"answer": "one"}\n{"answer": "two"}\n'},
      ]);

      expect(results).toEqual([{answer: 'one'}, {answer: 'two'}]);
    });

    it('flushes a pending data event when an NDJSON line follows it', async () => {
      const results = await collect([
        {data: 'data: {"answer": "one"}\n{"answer": "two"}\n'},
      ]);

      expect(results).toEqual([{answer: 'one'}, {answer: 'two'}]);
    });

    it('flushes a data event with no closing blank line at end of stream', async () => {
      const results = await collect([{data: 'data: {"answer": "one"}\n'}]);

      expect(results).toEqual([{answer: 'one'}]);
    });

    it('decodes a multi-byte character split across binary chunks', async () => {
      const bytes = new TextEncoder().encode('data: {"text": "\u{1F389}"}\n\n');
      // Split inside the 4-byte emoji, after its first two bytes.
      const cut = bytes.indexOf(0xf0) + 2;

      const results = await collect([
        {data: bytes.slice(0, cut)},
        {data: bytes.slice(cut)},
      ]);

      expect(results).toEqual([{text: '\u{1F389}'}]);
      expect(JSON.stringify(results)).not.toContain('\uFFFD');
    });

    it('decodes a multi-byte character split across Buffer chunks', async () => {
      const bytes = Buffer.from('{"text": "\u65E5\u672C"}\n', 'utf8');
      // Split inside the first 3-byte CJK character.
      const cut = bytes.indexOf(0xe6) + 1;

      const results = await collect([
        {data: bytes.subarray(0, cut)},
        {data: bytes.subarray(cut)},
      ]);

      expect(results).toEqual([{text: '\u65E5\u672C'}]);
    });
  });
});
