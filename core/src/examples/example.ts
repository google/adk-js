/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';

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
    private readonly apiClient: ExampleStoreApiClient,
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
