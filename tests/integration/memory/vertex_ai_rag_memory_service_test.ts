/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createSession,
  InMemorySessionService,
  ListRagFilesParams,
  ListRagFilesResponse,
  LlmAgent,
  LOAD_MEMORY,
  RagApiClient,
  RetrieveContextsParams,
  RetrieveContextsResponse,
  Runner,
  Session,
  UploadRagFileParams,
  VertexAiRagMemoryService,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {GeminiWithMockResponses} from '../test_case_utils.js';

const CORPUS = 'projects/test-project/locations/us-central1/ragCorpora/1';

/**
 * A RAG corpus that keeps its files in memory and answers a retrieval query
 * with every chunk whose text contains a word of the query.
 */
class FakeRagCorpus implements RagApiClient {
  /** Bare file id -> display name. */
  private readonly files = new Map<string, string>();
  /** Display name -> transcript. */
  private readonly contents = new Map<string, string>();
  private nextFileId = 1;

  async uploadRagFile(params: UploadRagFileParams): Promise<void> {
    this.files.set(`file-${this.nextFileId++}`, params.displayName);
    this.contents.set(params.displayName, params.content);
  }

  async listRagFiles(
    params: ListRagFilesParams,
  ): Promise<ListRagFilesResponse> {
    return {
      ragFiles: [...this.files].map(([fileId, displayName]) => ({
        name: `${params.ragCorpus}/ragFiles/${fileId}`,
        displayName,
      })),
    };
  }

  async retrieveContexts(
    params: RetrieveContextsParams,
  ): Promise<RetrieveContextsResponse> {
    const ragFileIds = params.vertexRagStore.ragResources?.[0].ragFileIds;
    const words = params.query.text.toLowerCase().split(/\W+/).filter(Boolean);
    const contexts = [...this.files]
      .filter(([fileId]) => !ragFileIds || ragFileIds.includes(fileId))
      .map(([, displayName]) => ({
        sourceDisplayName: displayName,
        text: this.contents.get(displayName) ?? '',
      }))
      .filter((context) =>
        words.some((word) => context.text.toLowerCase().includes(word)),
      );
    return {contexts: {contexts}};
  }
}

function conversation(
  appName: string,
  userId: string,
  sessionId: string,
  turns: Array<[number, string]>,
): Session {
  return createSession({
    id: sessionId,
    appName,
    userId,
    events: turns.map(([timestamp, text]) =>
      createEvent({author: 'user', timestamp, content: {parts: [{text}]}}),
    ),
  });
}

describe('VertexAiRagMemoryService integration', () => {
  it('recalls one user of a shared corpus and never the other', async () => {
    const memoryService = new VertexAiRagMemoryService({
      ragCorpus: CORPUS,
      ragApiClient: new FakeRagCorpus(),
    });

    await memoryService.addSessionToMemory(
      conversation('demo', 'alice', 'alice-session', [
        [2000, 'my cat is called Mango'],
        [1000, 'I live in Zurich'],
      ]),
    );
    await memoryService.addSessionToMemory(
      conversation('demo', 'bob', 'bob-session', [
        [3000, 'my cat is called Pepper'],
      ]),
    );

    const response = await memoryService.searchMemory({
      appName: 'demo',
      userId: 'alice',
      query: 'cat Zurich',
    });

    expect(response.memories.map((memory) => memory.content.parts?.[0].text)) //
      .toEqual(['I live in Zurich', 'my cat is called Mango']);
    expect(response.memories[0].timestamp).toBe('1970-01-01T00:00:01.000Z');
  });

  it('answers from memory through the Runner and the load_memory tool', async () => {
    const agent = new LlmAgent({
      name: 'memory_agent',
      description: 'Answers questions from memory.',
      instruction: 'Answer questions about the user using memory.',
      tools: [LOAD_MEMORY],
    });
    agent.model = new GeminiWithMockResponses([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'load_memory',
                    args: {query: 'colour'},
                  },
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Your favorite colour is green.'}],
            },
          },
        ],
      },
    ]);

    const runner = new Runner({
      appName: 'test_rag_memory_app',
      agent,
      sessionService: new InMemorySessionService(),
      memoryService: new VertexAiRagMemoryService({
        ragCorpus: CORPUS,
        ragApiClient: new FakeRagCorpus(),
      }),
    });

    const pastSession = await runner.sessionService.createSession({
      appName: 'test_rag_memory_app',
      userId: 'test_user',
    });
    await runner.sessionService.appendEvent({
      session: pastSession,
      event: createEvent({
        author: 'user',
        content: createUserContent('My favorite colour is green.'),
      }),
    });
    await runner.memoryService!.addSessionToMemory(pastSession);

    const session = await runner.sessionService.createSession({
      appName: 'test_rag_memory_app',
      userId: 'test_user',
    });

    let finalResponse = '';
    let memoryLoaded = false;
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('What is my favorite colour?'),
    })) {
      if (event.author === 'memory_agent') {
        finalResponse += event.content?.parts?.[0]?.text ?? '';
      }
      const functionResponse = event.content?.parts?.[0]?.functionResponse;
      if (functionResponse?.name === 'load_memory') {
        memoryLoaded = true;
        expect(JSON.stringify(functionResponse.response)).toContain(
          'My favorite colour is green.',
        );
      }
    }

    expect(memoryLoaded).toBe(true);
    expect(finalResponse).toContain('Your favorite colour is green.');
  });
});
