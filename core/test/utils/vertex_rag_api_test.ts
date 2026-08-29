/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {VertexRagApiClient} from '../../src/utils/vertex_rag_api.js';

const CORPUS = 'projects/test-project/locations/us-central1/ragCorpora/1';
const HOST = 'https://us-central1-aiplatform.googleapis.com';

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getClient: vi.fn().mockResolvedValue({
      getRequestHeaders: vi
        .fn()
        .mockResolvedValue(new Headers({Authorization: 'Bearer fake-token'})),
    }),
  })),
}));

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status});
}

function requestAt(index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    expect.fail(`no fetch call at index ${index}`);
  }
  return {url: String(call[0]), init: call[1] ?? {}};
}

function client(): VertexRagApiClient {
  return new VertexRagApiClient({location: 'us-central1'});
}

describe('VertexRagApiClient', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists corpus files with the page size and an auth header', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ragFiles: [{name: `${CORPUS}/ragFiles/a`, displayName: 'a'}],
        nextPageToken: 'page-2',
      }),
    );

    const response = await client().listRagFiles({
      ragCorpus: CORPUS,
      pageSize: 100,
    });

    expect(response.nextPageToken).toBe('page-2');
    const {url, init} = requestAt(0);
    expect(url).toBe(`${HOST}/v1/${CORPUS}/ragFiles?pageSize=100`);
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer fake-token',
    );
  });

  it('forwards the page token when one is given', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ragFiles: []}));

    await client().listRagFiles({
      ragCorpus: CORPUS,
      pageSize: 100,
      pageToken: 'page-2',
    });

    expect(requestAt(0).url).toBe(
      `${HOST}/v1/${CORPUS}/ragFiles?pageSize=100&pageToken=page-2`,
    );
  });

  it('uploads the transcript as a multipart request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ragFile: {displayName: 'x'}}));

    await client().uploadRagFile({
      ragCorpus: CORPUS,
      displayName: 'adk-memory-v1.ZGVtbw.YWxpY2U.cw',
      content: 'transcript line',
    });

    const {url, init} = requestAt(0);
    expect(url).toBe(`${HOST}/upload/v1/${CORPUS}/ragFiles:upload`);
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer fake-token');
    expect(headers.get('X-Goog-Upload-Protocol')).toBe('multipart');

    const body = init.body;
    if (!(body instanceof FormData)) {
      expect.fail('the upload body is not multipart form data');
    }
    const metadata = body.get('metadata');
    const file = body.get('file');
    if (!(metadata instanceof Blob) || !(file instanceof Blob)) {
      expect.fail('the upload body is missing the metadata or file part');
    }
    // Blob lower-cases the media type it is given.
    expect(metadata.type).toBe('application/json; charset=utf-8');
    expect(JSON.parse(await metadata.text())).toEqual({
      ragFile: {displayName: 'adk-memory-v1.ZGVtbw.YWxpY2U.cw'},
    });
    expect(await file.text()).toBe('transcript line');
  });

  it('rejects when the upload endpoint reports an error with HTTP 200', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({error: {code: 400, message: 'corpus is full'}}),
    );

    await expect(
      client().uploadRagFile({
        ragCorpus: CORPUS,
        displayName: 'name',
        content: 'transcript',
      }),
    ).rejects.toThrow('corpus is full');
  });

  it('retrieves contexts from the location endpoint', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({contexts: {contexts: [{text: 'remembered'}]}}),
    );

    const response = await client().retrieveContexts({
      parent: 'projects/test-project/locations/us-central1',
      vertexRagStore: {ragResources: [{ragCorpus: CORPUS}]},
      query: {text: 'what did I say?', ragRetrievalConfig: {topK: 5}},
    });

    expect(response.contexts?.contexts?.[0].text).toBe('remembered');
    const {url, init} = requestAt(0);
    expect(url).toBe(
      `${HOST}/v1/projects/test-project/locations/us-central1:retrieveContexts`,
    );
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer fake-token');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      vertexRagStore: {ragResources: [{ragCorpus: CORPUS}]},
      query: {text: 'what did I say?', ragRetrievalConfig: {topK: 5}},
    });
  });

  it('rejects with the status and the body when the API refuses', async () => {
    fetchMock.mockResolvedValue(
      new Response('caller lacks aiplatform.ragFiles.list', {status: 403}),
    );

    await expect(
      client().listRagFiles({ragCorpus: CORPUS, pageSize: 100}),
    ).rejects.toThrow(
      'Vertex AI RAG request failed with status 403: caller lacks aiplatform.ragFiles.list',
    );
  });
});
