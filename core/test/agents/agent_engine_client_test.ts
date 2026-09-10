/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {helpers, v1} from '@google-cloud/aiplatform';
import {AgentEngineClient, AgentExecutionError} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

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
    it('instantiates client with correct endpoint', () => {
      expect(v1.ReasoningEngineExecutionServiceClient).toHaveBeenCalledWith({
        apiEndpoint: 'us-central1-aiplatform.googleapis.com',
      });
      expect(client).toBeInstanceOf(AgentEngineClient);
      expect(mockGrpcClient.reasoningEnginePath).toHaveBeenCalledWith(
        'test-project',
        'us-central1',
        '12345',
      );
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
              userId: expect.objectContaining({stringValue: 'u1'}),
              sessionId: expect.objectContaining({stringValue: 's1'}),
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
  });
});
