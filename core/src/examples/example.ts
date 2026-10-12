/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';
import type {GoogleAuth} from 'google-auth-library';

import {BaseExampleProvider} from './base_example_provider.js';

/**
 * A few-shot example.
 */
export interface Example {
  /**
   * The input content for the example.
   */
  input: Content;
  /**
   * The expected output content for the example.
   */
  output: Content[];
}

/**
 * Request payload for searching examples in Vertex AI Example Store.
 */
export interface SearchExamplesRequest {
  storedContentsExampleParameters: {
    contentSearchKey: {
      contents: Content[];
      searchKeyGenerationMethod: {lastEntry: Record<string, never>};
    };
  };
  topK: number;
  exampleStore: string;
}

/**
 * A stored example returned inside a {@link SearchExamplesResult}.
 */
export interface StoredContentsExample {
  searchKey?: string;
  contentsExample?: {
    expectedContents?: Array<{content?: Content}>;
  };
}

/**
 * Single result item returned by {@link ExampleStoreApiClient.searchExamples}.
 */
export interface SearchExamplesResult {
  similarityScore?: number;
  example?: {
    storedContentsExample?: StoredContentsExample;
  };
}

/**
 * Response returned by {@link ExampleStoreApiClient.searchExamples}.
 */
export interface SearchExamplesResponse {
  results?: SearchExamplesResult[];
}

/**
 * API client interface for the Vertex AI Example Store.
 *
 * The Python SDK obtains this client from its bundled `vertexai` dependency.
 * adk-js does not bundle that dependency, so the caller injects a client that
 * reaches the Vertex AI Example Store API.
 */
export interface ExampleStoreApiClient {
  searchExamples(
    request: SearchExamplesRequest,
  ): Promise<SearchExamplesResponse>;
}

/**
 * Options for configuring {@link VertexAiExampleStoreApiClient}.
 */
export interface VertexAiExampleStoreApiClientOptions {
  /**
   * Optional GoogleAuth instance used to obtain access tokens. When omitted,
   * Application Default Credentials are loaded lazily on the first request.
   */
  auth?: Pick<GoogleAuth, 'getAccessToken'>;
  /**
   * Optional API endpoint host or base URL override, such as
   * `'us-central1-aiplatform.googleapis.com'` or
   * `'https://us-central1-aiplatform.googleapis.com'`. When omitted, the
   * regional endpoint is derived from the example store resource location.
   */
  apiEndpoint?: string;
}

interface GoogleAuthModule {
  GoogleAuth: typeof GoogleAuth;
}

const GOOGLE_AUTH_MODULE = 'google-auth-library';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const EXAMPLE_STORE_RESOURCE_PATTERN =
  /^projects\/([^/]+)\/locations\/([^/]+)\/exampleStores\/([^/]+)$/;
const BARE_STORE_ID_PATTERN = /^[^/\s]+$/;

function resolveExampleStoreResource(exampleStore: string): {
  resourceName: string;
  location: string;
} {
  const match = EXAMPLE_STORE_RESOURCE_PATTERN.exec(exampleStore);
  if (match) {
    return {
      resourceName: exampleStore,
      location: match[2],
    };
  }

  const project = process.env.GOOGLE_CLOUD_PROJECT?.trim();
  const location = process.env.GOOGLE_CLOUD_LOCATION?.trim();
  if (BARE_STORE_ID_PATTERN.test(exampleStore) && project && location) {
    return {
      resourceName: `projects/${project}/locations/${location}/exampleStores/${exampleStore}`,
      location,
    };
  }

  throw new Error(
    `Invalid Vertex AI Example Store resource name "${exampleStore}". ` +
      'Expected "projects/{project}/locations/{location}/exampleStores/{exampleStore}" ' +
      'or a bare store ID with GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION set.',
  );
}

function resolveApiBaseUrl(location: string, apiEndpoint?: string): string {
  const endpoint = apiEndpoint?.trim().replace(/\/+$/, '');
  if (!endpoint) {
    return `https://${location}-aiplatform.googleapis.com`;
  }
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint;
  }
  return `https://${endpoint}`;
}

/**
 * Default {@link ExampleStoreApiClient} implementation that queries the
 * Vertex AI Example Store `v1beta1` REST API using Application Default
 * Credentials.
 */
export class VertexAiExampleStoreApiClient implements ExampleStoreApiClient {
  private auth?: Pick<GoogleAuth, 'getAccessToken'>;

  constructor(
    private readonly options: VertexAiExampleStoreApiClientOptions = {},
  ) {
    this.auth = options.auth;
  }

  /**
   * Searches for matching examples in the configured Vertex AI Example Store.
   */
  async searchExamples(
    request: SearchExamplesRequest,
  ): Promise<SearchExamplesResponse> {
    const {resourceName, location} = resolveExampleStoreResource(
      request.exampleStore,
    );
    const baseUrl = resolveApiBaseUrl(location, this.options.apiEndpoint);
    const url = `${baseUrl}/v1beta1/${resourceName}:searchExamples`;
    const token = await this.getAccessToken();

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        storedContentsExampleParameters:
          request.storedContentsExampleParameters,
        topK: request.topK,
        exampleStore: resourceName,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Vertex AI Example Store request failed with status ${response.status}: ${await response.text()}`,
      );
    }

    return (await response.json()) as SearchExamplesResponse;
  }

  private async getAccessToken(): Promise<string> {
    const auth = await this.getAuth();
    const token = await auth.getAccessToken();
    if (!token) {
      throw new Error(
        'Failed to obtain an access token for Vertex AI Example Store.',
      );
    }
    return token;
  }

  private async getAuth(): Promise<Pick<GoogleAuth, 'getAccessToken'>> {
    if (!this.auth) {
      const {GoogleAuth: GoogleAuthCtor} = (await import(
        GOOGLE_AUTH_MODULE
      )) as GoogleAuthModule;
      this.auth = new GoogleAuthCtor({scopes: [CLOUD_PLATFORM_SCOPE]});
    }
    return this.auth;
  }
}

const SIMILARITY_SCORE_THRESHOLD = 0.5;
const DEFAULT_TOP_K = 10;

/**
 * Provides examples from a Vertex AI Example Store.
 */
export class VertexAiExampleStore extends BaseExampleProvider {
  /**
   * Initializes the VertexAiExampleStore.
   *
   * @param examplesStoreName The resource name of the vertex example store, in
   *   the format of
   *   `projects/{project}/locations/{location}/exampleStores/{example_store}`.
   * @param apiClient A client that reaches the Vertex AI Example Store API.
   *   adk-js does not bundle the `vertexai` dependency the Python SDK relies
   *   on, so the caller supplies this client.
   */
  constructor(
    readonly examplesStoreName: string,
    private readonly apiClient: ExampleStoreApiClient = new VertexAiExampleStoreApiClient(),
  ) {
    super();
  }

  /**
   * Retrieves relevant examples from the Vertex AI Example Store for the given
   * query.
   */
  override async getExamples(query: string): Promise<Example[]> {
    const request: SearchExamplesRequest = {
      storedContentsExampleParameters: {
        contentSearchKey: {
          contents: [{role: 'user', parts: [{text: query}]}],
          searchKeyGenerationMethod: {lastEntry: {}},
        },
      },
      topK: DEFAULT_TOP_K,
      exampleStore: this.examplesStoreName,
    };

    const response = await this.apiClient.searchExamples(request);

    const returnedExamples: Example[] = [];
    for (const result of response.results ?? []) {
      if ((result.similarityScore ?? 0) < SIMILARITY_SCORE_THRESHOLD) {
        continue;
      }

      const storedExample = result.example?.storedContentsExample;
      const expectedContents = (
        storedExample?.contentsExample?.expectedContents ?? []
      )
        .map((entry) => entry.content)
        .filter((content): content is Content => content !== undefined);

      const expectedOutput: Content[] = [];
      for (const content of expectedContents) {
        const expectedParts: Part[] = [];
        for (const part of content.parts ?? []) {
          if (part.text) {
            expectedParts.push({text: part.text});
          } else if (part.functionCall) {
            expectedParts.push({
              functionCall: {
                name: part.functionCall.name,
                args: {...(part.functionCall.args ?? {})},
              },
            });
          } else if (part.functionResponse) {
            expectedParts.push({
              functionResponse: {
                name: part.functionResponse.name,
                response: {...(part.functionResponse.response ?? {})},
              },
            });
          }
        }
        expectedOutput.push({role: content.role, parts: expectedParts});
      }

      returnedExamples.push({
        input: {
          role: 'user',
          parts: [{text: storedExample?.searchKey ?? ''}],
        },
        output: expectedOutput,
      });
    }
    return returnedExamples;
  }
}
