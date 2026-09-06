/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RagRetrievalConfig, VertexRagStore} from '@google/genai';
import {GoogleAuth} from 'google-auth-library';

/** OAuth scope every Vertex AI RAG Engine call needs. */
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** One file in a RAG corpus. */
export interface RagFile {
  /**
   * Full resource name,
   * `projects/{project}/locations/{location}/ragCorpora/{corpus}/ragFiles/{file}`.
   */
  name?: string;
  /** Caller-supplied label for the file. */
  displayName?: string;
}

/** One page of a `ragFiles` listing. */
export interface ListRagFilesResponse {
  ragFiles?: RagFile[];
  nextPageToken?: string;
}

/** One chunk returned by a retrieval query. */
export interface RagContext {
  /** The `displayName` of the RAG file this chunk came from. */
  sourceDisplayName?: string;
  text?: string;
}

/** The response of a retrieval query. */
export interface RetrieveContextsResponse {
  contexts?: {contexts?: RagContext[]};
}

/** The response of a `ragFiles:upload` request. */
interface UploadRagFileResponse {
  /** The upload endpoint reports a rejected file here, with HTTP 200. */
  error?: unknown;
}

/** Parameters of {@link RagApiClient.listRagFiles}. */
export interface ListRagFilesParams {
  ragCorpus: string;
  pageSize: number;
  pageToken?: string;
}

/** Parameters of {@link RagApiClient.uploadRagFile}. */
export interface UploadRagFileParams {
  ragCorpus: string;
  displayName: string;
  content: string;
}

/** Parameters of {@link RagApiClient.retrieveContexts}. */
export interface RetrieveContextsParams {
  /** `projects/{project}/locations/{location}`. */
  parent: string;
  vertexRagStore: VertexRagStore;
  /** `@google/genai` models the store and the config, but not the query. */
  query: {text: string; ragRetrievalConfig?: RagRetrievalConfig};
}

/**
 * The file and retrieval calls of the Vertex AI RAG Engine.
 *
 * `VertexRagApiClient` is the implementation; the interface is the seam
 * a test substitutes.
 */
export interface RagApiClient {
  listRagFiles(params: ListRagFilesParams): Promise<ListRagFilesResponse>;
  uploadRagFile(params: UploadRagFileParams): Promise<void>;
  retrieveContexts(
    params: RetrieveContextsParams,
  ): Promise<RetrieveContextsResponse>;
}

/**
 * A {@link RagApiClient} over the Vertex AI RAG Engine REST API.
 *
 * The calls go to the REST API directly because neither
 * `@google-cloud/vertexai` nor `@google/genai` ships a RAG client. Requests
 * carry Application Default Credentials.
 */
export class VertexRagApiClient implements RagApiClient {
  private readonly host: string;
  private readonly auth: GoogleAuth;

  constructor(options: {location: string}) {
    this.host = `https://${options.location}-aiplatform.googleapis.com`;
    this.auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});
  }

  /** Lists one page of the files in a corpus. */
  async listRagFiles(
    params: ListRagFilesParams,
  ): Promise<ListRagFilesResponse> {
    const query = new URLSearchParams({pageSize: String(params.pageSize)});
    if (params.pageToken) {
      query.set('pageToken', params.pageToken);
    }
    const url = `${this.host}/v1/${params.ragCorpus}/ragFiles?${query.toString()}`;
    return this.send<ListRagFilesResponse>(url, {
      method: 'GET',
      headers: await this.authHeaders(url),
    });
  }

  /** Uploads `content` into a corpus as one RAG file. */
  async uploadRagFile(params: UploadRagFileParams): Promise<void> {
    const url = `${this.host}/upload/v1/${params.ragCorpus}/ragFiles:upload`;
    const metadata = JSON.stringify({
      ragFile: {displayName: params.displayName},
      // Required by ragFiles:upload. Empty selects the corpus default chunking.
      uploadRagFileConfig: {},
    });
    const body = new FormData();
    body.append(
      'metadata',
      new Blob([metadata], {type: 'application/json; charset=UTF-8'}),
    );
    body.append(
      'file',
      new Blob([params.content], {type: 'text/plain; charset=UTF-8'}),
      'content.txt',
    );

    const headers = await this.authHeaders(url);
    headers.set('X-Goog-Upload-Protocol', 'multipart');
    const response = await this.send<UploadRagFileResponse>(url, {
      method: 'POST',
      headers,
      body,
    });
    if (response.error) {
      throw new Error(
        `Vertex AI RAG file upload was rejected: ${JSON.stringify(response.error)}`,
      );
    }
  }

  /** Runs a retrieval query over a corpus. */
  async retrieveContexts(
    params: RetrieveContextsParams,
  ): Promise<RetrieveContextsResponse> {
    const url = `${this.host}/v1/${params.parent}:retrieveContexts`;
    const headers = await this.authHeaders(url);
    headers.set('Content-Type', 'application/json');
    return this.send<RetrieveContextsResponse>(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        vertexRagStore: params.vertexRagStore,
        query: params.query,
      }),
    });
  }

  private async authHeaders(url: string): Promise<Headers> {
    const client = await this.auth.getClient();
    return client.getRequestHeaders(url);
  }

  private async send<T>(
    url: string,
    init: {method: string; headers: Headers; body?: FormData | string},
  ): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(
        `Vertex AI RAG request failed with status ${response.status}: ${await response.text()}`,
      );
    }
    return (await response.json()) as T;
  }
}
