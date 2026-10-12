/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  BaseExampleProvider,
  isBaseExampleProvider,
} from '../../src/examples/base_example_provider.js';
import {
  ExampleStoreApiClient,
  SearchExamplesRequest,
  SearchExamplesResponse,
  VertexAiExampleStore,
} from '../../src/examples/example.js';
import {buildExampleSi} from '../../src/examples/example_util.js';

const STORE_NAME =
  'projects/my-project/locations/us-central1/exampleStores/my-store';

describe('vertex_ai_example_store (v0.1.0 parity)', () => {
  const searchExamplesMock =
    vi.fn<(req: SearchExamplesRequest) => Promise<SearchExamplesResponse>>();
  const apiClient: ExampleStoreApiClient = {searchExamples: searchExamplesMock};

  beforeEach(() => {
    searchExamplesMock.mockReset();
    searchExamplesMock.mockResolvedValue({results: []});
  });

  it('initializes with examplesStoreName and extends BaseExampleProvider', () => {
    const store = new VertexAiExampleStore(STORE_NAME, apiClient);
    expect(store).toBeInstanceOf(BaseExampleProvider);
    expect(isBaseExampleProvider(store)).toBe(true);
    expect(store.examplesStoreName).toBe(STORE_NAME);
  });

  it('calls searchExamples with topK=10, exampleStore, and lastEntry searchKeyGenerationMethod', async () => {
    const store = new VertexAiExampleStore(STORE_NAME, apiClient);
    await store.getExamples('what is the weather?');

    expect(searchExamplesMock).toHaveBeenCalledOnce();
    expect(searchExamplesMock).toHaveBeenCalledWith({
      storedContentsExampleParameters: {
        contentSearchKey: {
          contents: [{role: 'user', parts: [{text: 'what is the weather?'}]}],
          searchKeyGenerationMethod: {lastEntry: {}},
        },
      },
      topK: 10,
      exampleStore: STORE_NAME,
    });
  });

  it('filters out results with similarityScore < 0.5 and retains >= 0.5', async () => {
    searchExamplesMock.mockResolvedValue({
      results: [
        {
          similarityScore: 0.49,
          example: {
            storedContentsExample: {
              searchKey: 'low score query',
              contentsExample: {
                expectedContents: [
                  {content: {role: 'model', parts: [{text: 'ignored'}]}},
                ],
              },
            },
          },
        },
        {
          similarityScore: 0.5,
          example: {
            storedContentsExample: {
              searchKey: 'threshold query',
              contentsExample: {
                expectedContents: [
                  {content: {role: 'model', parts: [{text: 'kept response'}]}},
                ],
              },
            },
          },
        },
      ],
    });

    const store = new VertexAiExampleStore(STORE_NAME, apiClient);
    const examples = await store.getExamples('test query');

    expect(examples).toHaveLength(1);
    expect(examples[0]).toEqual({
      input: {role: 'user', parts: [{text: 'threshold query'}]},
      output: [{role: 'model', parts: [{text: 'kept response'}]}],
    });
  });

  it('converts text, functionCall, and functionResponse parts from storedContentsExample', async () => {
    searchExamplesMock.mockResolvedValue({
      results: [
        {
          similarityScore: 0.92,
          example: {
            storedContentsExample: {
              searchKey: 'get weather in London',
              contentsExample: {
                expectedContents: [
                  {
                    content: {
                      role: 'model',
                      parts: [
                        {
                          functionCall: {
                            name: 'get_weather',
                            args: {city: 'London', unit: 'celsius'},
                          },
                        },
                      ],
                    },
                  },
                  {
                    content: {
                      role: 'user',
                      parts: [
                        {
                          functionResponse: {
                            name: 'get_weather',
                            response: {temp: 15, condition: 'cloudy'},
                          },
                        },
                      ],
                    },
                  },
                  {
                    content: {
                      role: 'model',
                      parts: [{text: 'It is 15C and cloudy in London.'}],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    });

    const store = new VertexAiExampleStore(STORE_NAME, apiClient);
    const examples = await store.getExamples('weather in London');

    expect(examples).toEqual([
      {
        input: {
          role: 'user',
          parts: [{text: 'get weather in London'}],
        },
        output: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'get_weather',
                  args: {city: 'London', unit: 'celsius'},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'get_weather',
                  response: {temp: 15, condition: 'cloudy'},
                },
              },
            ],
          },
          {
            role: 'model',
            parts: [{text: 'It is 15C and cloudy in London.'}],
          },
        ],
      },
    ]);

    const si = await buildExampleSi(store, 'weather in London');
    expect(si).toContain('get weather in London');
    expect(si).toContain("get_weather(city='London', unit='celsius')");
    expect(si).toContain('It is 15C and cloudy in London.');
  });
});
