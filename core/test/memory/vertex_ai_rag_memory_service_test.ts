/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createSession,
  getLogger,
  RagApiClient,
  SearchMemoryResponse,
  Session,
  VertexAiRagMemoryService,
  VertexAiRagMemoryServiceOptions,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

const CORPUS = 'projects/test-project/locations/us-central1/ragCorpora/1';
const PARENT = 'projects/test-project/locations/us-central1';

/** Mirrors MAX_RAG_FILE_PAGES in vertex_ai_rag_memory_service.ts. */
const MAX_RAG_FILE_PAGES = 10;

/** `adk-memory-v1.` + base64url of `demo`, `alice` and `session-1`. */
const ALICE_DISPLAY_NAME = 'adk-memory-v1.ZGVtbw.YWxpY2U.c2Vzc2lvbi0x';

/** The same app and user as {@link ALICE_DISPLAY_NAME}, a second session. */
const ALICE_SESSION_2_DISPLAY_NAME =
  'adk-memory-v1.ZGVtbw.YWxpY2U.c2Vzc2lvbi0y';

function fakeRagApiClient() {
  return {
    listRagFiles: vi
      .fn<RagApiClient['listRagFiles']>()
      .mockResolvedValue({ragFiles: [ragFile('alice-1', ALICE_DISPLAY_NAME)]}),
    uploadRagFile: vi
      .fn<RagApiClient['uploadRagFile']>()
      .mockResolvedValue(undefined),
    retrieveContexts: vi
      .fn<RagApiClient['retrieveContexts']>()
      .mockResolvedValue({contexts: {contexts: []}}),
  };
}

type FakeRagApiClient = ReturnType<typeof fakeRagApiClient>;

function service(
  ragApiClient: RagApiClient,
  options: Partial<VertexAiRagMemoryServiceOptions> = {},
): VertexAiRagMemoryService {
  return new VertexAiRagMemoryService({
    ragCorpus: CORPUS,
    ragApiClient,
    ...options,
  });
}

/** A retrieved chunk holding one transcript line. Timestamps are seconds. */
function ragContext(
  sourceDisplayName: string,
  text: string,
  timestampSeconds = 1,
) {
  return {
    sourceDisplayName,
    text: JSON.stringify({
      author: 'user',
      timestamp: timestampSeconds,
      text,
    }),
  };
}

/** A retrieved chunk holding several `[timestampSeconds, text]` lines. */
function ragChunk(sourceDisplayName: string, lines: Array<[number, string]>) {
  return {
    sourceDisplayName,
    text: lines
      .map(([timestamp, text]) =>
        JSON.stringify({author: 'user', timestamp, text}),
      )
      .join('\n'),
  };
}

/** A listing entry reports the full resource name, not the bare file id. */
function ragFile(ragFileId: string, displayName: string) {
  return {name: `${CORPUS}/ragFiles/${ragFileId}`, displayName};
}

function memoryTexts(
  response: SearchMemoryResponse,
): Array<string | undefined> {
  return response.memories.map((memory) => memory.content.parts?.[0].text);
}

function displayNameOf(client: FakeRagApiClient): string {
  const params = client.uploadRagFile.mock.calls[0]?.[0];
  if (!params) {
    expect.fail('uploadRagFile was not called');
  }
  return params.displayName;
}

function sessionWithDottedIds(): Session {
  return createSession({
    id: 'session.secret',
    appName: 'demo.app',
    userId: 'alice.smith',
    events: [
      createEvent({
        author: 'user',
        timestamp: 1000,
        content: {parts: [{text: 'sensitive memory'}]},
      }),
    ],
  });
}

function searchAsAlice(
  memoryService: VertexAiRagMemoryService,
): Promise<SearchMemoryResponse> {
  return memoryService.searchMemory({
    appName: 'demo',
    userId: 'alice',
    query: 'memory',
  });
}

function warnSpy() {
  return vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
}

describe('VertexAiRagMemoryService constructor', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when ragCorpus is empty', () => {
    expect(() => service(fakeRagApiClient(), {ragCorpus: ''})).toThrow(
      'ragCorpus is required for VertexAiRagMemoryService.',
    );
  });

  it('throws when ragCorpus is only whitespace', () => {
    expect(() => service(fakeRagApiClient(), {ragCorpus: '   '})).toThrow(
      'ragCorpus is required for VertexAiRagMemoryService.',
    );
  });

  it('back-fills the project and the location from a full resource name', async () => {
    const client = fakeRagApiClient();

    await searchAsAlice(service(client));

    expect(client.retrieveContexts.mock.calls[0]?.[0].parent).toBe(PARENT);
    expect(client.listRagFiles.mock.calls[0]?.[0].ragCorpus).toBe(CORPUS);
  });

  it('builds the corpus name from a bare id and the environment', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west4');
    const client = fakeRagApiClient();

    await searchAsAlice(service(client, {ragCorpus: 'my-corpus'}));

    expect(client.retrieveContexts.mock.calls[0]?.[0].parent).toBe(
      'projects/env-project/locations/europe-west4',
    );
    expect(client.listRagFiles.mock.calls[0]?.[0].ragCorpus).toBe(
      'projects/env-project/locations/europe-west4/ragCorpora/my-corpus',
    );
  });

  it('prefers the explicit project and location over the environment', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west4');
    const client = fakeRagApiClient();

    await searchAsAlice(
      service(client, {
        ragCorpus: 'my-corpus',
        projectId: 'explicit-project',
        location: 'us-east1',
      }),
    );

    expect(client.retrieveContexts.mock.calls[0]?.[0].parent).toBe(
      'projects/explicit-project/locations/us-east1',
    );
  });

  it('builds a Vertex RAG client when none is injected', () => {
    expect(
      () => new VertexAiRagMemoryService({ragCorpus: CORPUS}),
    ).not.toThrow();
  });

  it('throws naming projectId when a bare corpus id cannot resolve it', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');

    expect(() => service(fakeRagApiClient(), {ragCorpus: 'my-corpus'})).toThrow(
      'projectId is required for VertexAiRagMemoryService',
    );
  });

  it('throws naming location when a bare corpus id cannot resolve it', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');

    expect(() => service(fakeRagApiClient(), {ragCorpus: 'my-corpus'})).toThrow(
      'location is required for VertexAiRagMemoryService',
    );
  });
});

describe('VertexAiRagMemoryService addSessionToMemory', () => {
  it('uploads the transcript under an unambiguous display name', async () => {
    const client = fakeRagApiClient();

    await service(client).addSessionToMemory(sessionWithDottedIds());

    const params = client.uploadRagFile.mock.calls[0]?.[0];
    if (!params) {
      expect.fail('uploadRagFile was not called');
    }
    expect(params.ragCorpus).toBe(CORPUS);
    expect(params.displayName.startsWith('adk-memory-v1.')).toBe(true);
    expect(params.displayName).not.toBe('demo.app.alice.smith.session.secret');
    expect(JSON.parse(params.content)).toEqual({
      author: 'user',
      timestamp: 1,
      text: 'sensitive memory',
    });
  });

  it('rejects when the upload fails', async () => {
    const client = fakeRagApiClient();
    client.uploadRagFile.mockRejectedValue(new Error('corpus is full'));

    await expect(
      service(client).addSessionToMemory(sessionWithDottedIds()),
    ).rejects.toThrow('corpus is full');
  });
});

describe('VertexAiRagMemoryService searchMemory', () => {
  it.each([7, undefined])(
    'sends similarityTopK %s on the query, not on the store',
    async (configuredTopK) => {
      const client = fakeRagApiClient();
      client.listRagFiles.mockRejectedValue(new Error('cannot list files'));
      warnSpy();

      await searchAsAlice(service(client, {similarityTopK: configuredTopK}));

      const params = client.retrieveContexts.mock.calls[0]?.[0];
      if (!params) {
        expect.fail('retrieveContexts was not called');
      }
      expect(params.query.ragRetrievalConfig?.topK).toBe(configuredTopK);
      expect(params.vertexRagStore.similarityTopK).toBe(undefined);
    },
  );

  it('sends the default vector distance threshold', async () => {
    const client = fakeRagApiClient();

    await searchAsAlice(service(client));

    expect(
      client.retrieveContexts.mock.calls[0]?.[0].query.ragRetrievalConfig
        ?.filter?.vectorDistanceThreshold,
    ).toBe(10);
  });

  it('sends a configured vector distance threshold', async () => {
    const client = fakeRagApiClient();

    await searchAsAlice(service(client, {vectorDistanceThreshold: 0.4}));

    expect(
      client.retrieveContexts.mock.calls[0]?.[0].query.ragRetrievalConfig
        ?.filter?.vectorDistanceThreshold,
    ).toBe(0.4);
  });

  it('scopes retrieval to the files of the requesting app and user', async () => {
    const client = fakeRagApiClient();
    client.listRagFiles
      .mockResolvedValueOnce({
        ragFiles: [
          ragFile('alice-1', ALICE_DISPLAY_NAME),
          ragFile('bob-1', 'adk-memory-v1.ZGVtbw.Ym9i.c2Vzc2lvbi0y'),
        ],
        nextPageToken: 'page-2',
      })
      .mockResolvedValueOnce({
        ragFiles: [
          ragFile('alice-2', 'demo.alice.legacy-session'),
          ragFile('other-app-1', 'adk-memory-v1.b3RoZXI.YWxpY2U.c2Vzc2lvbi0z'),
          // A listing entry without a resource name cannot be narrowed to.
          {displayName: 'demo.alice.session-4'},
        ],
      });
    client.retrieveContexts.mockResolvedValue({
      contexts: {
        contexts: [ragContext(ALICE_DISPLAY_NAME, 'ALICE_MEMORY')],
      },
    });
    const response = await searchAsAlice(service(client));

    expect(memoryTexts(response)).toEqual(['ALICE_MEMORY']);
    expect(client.listRagFiles).toHaveBeenCalledTimes(2);
    expect(client.listRagFiles.mock.calls[1]?.[0].pageToken).toBe('page-2');
    expect(
      client.retrieveContexts.mock.calls[0]?.[0].vertexRagStore.ragResources,
    ).toEqual([{ragCorpus: CORPUS, ragFileIds: ['alice-1', 'alice-2']}]);
  });

  it('skips retrieval when a listing page carries no files', async () => {
    const client = fakeRagApiClient();
    client.listRagFiles.mockResolvedValue({});

    const response = await searchAsAlice(service(client));

    expect(response.memories).toEqual([]);
    expect(client.retrieveContexts).not.toHaveBeenCalled();
  });

  it('skips retrieval when the corpus holds no file for the tenant', async () => {
    const client = fakeRagApiClient();
    client.listRagFiles.mockResolvedValue({
      ragFiles: [ragFile('bob-1', 'adk-memory-v1.ZGVtbw.Ym9i.c2Vzc2lvbi0y')],
    });

    const response = await searchAsAlice(service(client));

    expect(response.memories).toEqual([]);
    expect(client.retrieveContexts).not.toHaveBeenCalled();
  });

  it('retrieves unscoped and warns when listing fails', async () => {
    const client = fakeRagApiClient();
    client.listRagFiles.mockRejectedValue(new Error('cannot list files'));
    client.retrieveContexts.mockResolvedValue({
      contexts: {
        contexts: [
          ragContext(ALICE_DISPLAY_NAME, 'ALICE_MEMORY'),
          ragContext('adk-memory-v1.ZGVtbw.Ym9i.c2Vzc2lvbi0y', 'BOB_MEMORY'),
        ],
      },
    });
    const warn = warnSpy();

    const response = await searchAsAlice(service(client));

    expect(memoryTexts(response)).toEqual(['ALICE_MEMORY']);
    expect(
      client.retrieveContexts.mock.calls[0]?.[0].vertexRagStore.ragResources,
    ).toEqual([{ragCorpus: CORPUS, ragFileIds: undefined}]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cannot list files'),
    );
  });

  it('stops listing at the page budget and retrieves unscoped', async () => {
    const client = fakeRagApiClient();
    client.listRagFiles.mockResolvedValue({
      ragFiles: [ragFile('alice-1', ALICE_DISPLAY_NAME)],
      nextPageToken: 'another-page',
    });
    const warn = warnSpy();

    await searchAsAlice(service(client));

    expect(client.listRagFiles).toHaveBeenCalledTimes(MAX_RAG_FILE_PAGES);
    expect(
      client.retrieveContexts.mock.calls[0]?.[0].vertexRagStore.ragResources,
    ).toEqual([{ragCorpus: CORPUS, ragFileIds: undefined}]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('not scoped to the requesting app and user'),
    );
  });

  it('drops contexts whose legacy display name is ambiguous', async () => {
    const client = fakeRagApiClient();
    client.listRagFiles.mockRejectedValue(new Error('cannot list files'));
    client.retrieveContexts.mockResolvedValue({
      contexts: {
        contexts: [
          ragContext('demo.alice.smith.session_secret', 'SECRET_FROM_SMITH'),
          ragContext(
            'adk-memory-v1.ZGVtbw.YWxpY2U.c2Vzc2lvbl9vaw',
            'NORMAL_ALICE_MEMORY',
          ),
          ragContext('demo.alice.legacy_session', 'LEGACY_ALICE_MEMORY'),
          ragContext('demo.bob.session_other', 'BOB_MEMORY'),
        ],
      },
    });
    warnSpy();

    const response = await searchAsAlice(service(client));

    expect(memoryTexts(response)).toEqual([
      'NORMAL_ALICE_MEMORY',
      'LEGACY_ALICE_MEMORY',
    ]);
  });

  it('skips a context that carries no source display name', async () => {
    const client = fakeRagApiClient();
    client.listRagFiles.mockRejectedValue(new Error('cannot list files'));
    client.retrieveContexts.mockResolvedValue({
      contexts: {
        contexts: [
          {text: 'orphan chunk'},
          ragContext(ALICE_DISPLAY_NAME, 'KEPT'),
        ],
      },
    });
    warnSpy();

    expect(memoryTexts(await searchAsAlice(service(client)))).toEqual(['KEPT']);
  });

  it('returns no memories when the response carries no contexts', async () => {
    const client = fakeRagApiClient();
    client.retrieveContexts.mockResolvedValue({});

    expect((await searchAsAlice(service(client))).memories).toEqual([]);
  });

  it('skips a context that carries no text', async () => {
    const client = fakeRagApiClient();
    client.retrieveContexts.mockResolvedValue({
      contexts: {
        contexts: [{sourceDisplayName: ALICE_DISPLAY_NAME}],
      },
    });

    expect((await searchAsAlice(service(client))).memories).toEqual([]);
  });

  it('merges overlapping chunks of one session and orders them by time', async () => {
    const client = fakeRagApiClient();
    client.retrieveContexts.mockResolvedValue({
      contexts: {
        contexts: [
          {
            sourceDisplayName: ALICE_DISPLAY_NAME,
            text: [
              JSON.stringify({author: 'user', timestamp: 2, text: 'second'}),
              JSON.stringify({author: 'model', timestamp: 3, text: 'third'}),
            ].join('\n'),
          },
          {
            sourceDisplayName: ALICE_DISPLAY_NAME,
            text: [
              JSON.stringify({author: 'user', timestamp: 1, text: 'first'}),
              JSON.stringify({author: 'user', timestamp: 2, text: 'second'}),
            ].join('\n'),
          },
        ],
      },
    });

    const response = await searchAsAlice(service(client));

    expect(memoryTexts(response)).toEqual(['first', 'second', 'third']);
    expect(response.memories[0].timestamp).toBe('1970-01-01T00:00:01.000Z');
    expect(response.memories[2].author).toBe('model');
  });

  it('orders chunks of one session by time even when they never overlap', async () => {
    const client = fakeRagApiClient();
    client.retrieveContexts.mockResolvedValue({
      contexts: {
        contexts: [
          ragChunk(ALICE_DISPLAY_NAME, [[5, 'later']]),
          ragChunk(ALICE_DISPLAY_NAME, [[1, 'earlier']]),
        ],
      },
    });

    expect(memoryTexts(await searchAsAlice(service(client)))).toEqual([
      'earlier',
      'later',
    ]);
  });

  it('reports a turn once when a third chunk repeats two others', async () => {
    const client = fakeRagApiClient();
    client.retrieveContexts.mockResolvedValue({
      contexts: {
        contexts: [
          ragChunk(ALICE_DISPLAY_NAME, [[1, 'first']]),
          ragChunk(ALICE_DISPLAY_NAME, [[3, 'third']]),
          ragChunk(ALICE_DISPLAY_NAME, [
            [1, 'first'],
            [3, 'third'],
          ]),
        ],
      },
    });

    expect(memoryTexts(await searchAsAlice(service(client)))).toEqual([
      'first',
      'third',
    ]);
  });

  it('keeps two sessions apart in the order the corpus returned them', async () => {
    const client = fakeRagApiClient();
    client.retrieveContexts.mockResolvedValue({
      contexts: {
        contexts: [
          ragChunk(ALICE_SESSION_2_DISPLAY_NAME, [[9, 'from session two']]),
          ragChunk(ALICE_DISPLAY_NAME, [[1, 'from session one']]),
        ],
      },
    });

    expect(memoryTexts(await searchAsAlice(service(client)))).toEqual([
      'from session two',
      'from session one',
    ]);
  });

  it('rejects when retrieval fails', async () => {
    const client = fakeRagApiClient();
    client.retrieveContexts.mockRejectedValue(new Error('permission denied'));

    await expect(searchAsAlice(service(client))).rejects.toThrow(
      'permission denied',
    );
  });

  it('recalls a stored session whose identifiers contain dots', async () => {
    const client = fakeRagApiClient();
    const memoryService = service(client);
    await memoryService.addSessionToMemory(sessionWithDottedIds());
    client.listRagFiles.mockRejectedValue(new Error('cannot list files'));
    client.retrieveContexts.mockResolvedValue({
      contexts: {
        contexts: [ragContext(displayNameOf(client), 'sensitive memory')],
      },
    });
    warnSpy();

    const response = await memoryService.searchMemory({
      appName: 'demo.app',
      userId: 'alice.smith',
      query: 'sensitive',
    });

    expect(memoryTexts(response)).toEqual(['sensitive memory']);
  });
});
