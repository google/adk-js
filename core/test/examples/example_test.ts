/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
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
  VertexAiExampleStoreApiClient,
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

describe('VertexAiExampleStoreApiClient and default client', () => {
  const sampleRequest: SearchExamplesRequest = {
    storedContentsExampleParameters: {
      contentSearchKey: {
        contents: [{role: 'user', parts: [{text: 'weather in Paris'}]}],
        searchKeyGenerationMethod: {lastEntry: {}},
      },
    },
    topK: 10,
    exampleStore: STORE_NAME,
  };

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('initializes VertexAiExampleStore with a single argument and searches via default client', async () => {
    const tokenSpy = vi
      .spyOn(GoogleAuth.prototype, 'getAccessToken')
      .mockResolvedValue('adc-token-1');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              similarityScore: 0.85,
              example: {
                storedContentsExample: {
                  searchKey: 'weather in Paris',
                  contentsExample: {
                    expectedContents: [
                      {
                        content: {
                          role: 'model',
                          parts: [
                            {
                              functionCall: {
                                name: 'get_weather',
                                args: {city: 'Paris'},
                              },
                            },
                          ],
                        },
                      },
                      {
                        content: {
                          role: 'model',
                          parts: [{text: 'Sunny in Paris.'}],
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        }),
        {status: 200, headers: {'Content-Type': 'application/json'}},
      ),
    );

    try {
      const store = new VertexAiExampleStore(STORE_NAME);
      expect(store.examplesStoreName).toBe(STORE_NAME);
      const examples = await store.getExamples('weather in Paris');

      expect(tokenSpy).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledWith(
        `https://us-central1-aiplatform.googleapis.com/v1beta1/${STORE_NAME}:searchExamples`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer adc-token-1',
          },
          body: JSON.stringify(sampleRequest),
        },
      );
      expect(examples).toEqual([
        {
          input: {role: 'user', parts: [{text: 'weather in Paris'}]},
          output: [
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'get_weather',
                    args: {city: 'Paris'},
                  },
                },
              ],
            },
            {
              role: 'model',
              parts: [{text: 'Sunny in Paris.'}],
            },
          ],
        },
      ]);
    } finally {
      tokenSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('resolves a bare store ID using GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west1');
    const getAccessToken = vi.fn().mockResolvedValue('injected-token-2');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({results: []}), {status: 200}),
      );

    try {
      const client = new VertexAiExampleStoreApiClient({
        auth: {getAccessToken},
      });
      await client.searchExamples({
        ...sampleRequest,
        exampleStore: 'bare-store-id',
      });

      const expectedResource =
        'projects/env-project/locations/europe-west1/exampleStores/bare-store-id';
      expect(fetchSpy).toHaveBeenCalledWith(
        `https://europe-west1-aiplatform.googleapis.com/v1beta1/${expectedResource}:searchExamples`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer injected-token-2',
          },
          body: JSON.stringify({
            ...sampleRequest,
            exampleStore: expectedResource,
          }),
        },
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('honors a custom apiEndpoint override in VertexAiExampleStoreApiClientOptions', async () => {
    const getAccessToken = vi.fn().mockResolvedValue('custom-endpoint-token');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({results: []}), {status: 200}),
      );

    try {
      const client = new VertexAiExampleStoreApiClient({
        auth: {getAccessToken},
        apiEndpoint: 'custom-aiplatform.googleapis.com/',
      });
      await client.searchExamples(sampleRequest);

      expect(fetchSpy).toHaveBeenCalledWith(
        `https://custom-aiplatform.googleapis.com/v1beta1/${STORE_NAME}:searchExamples`,
        expect.objectContaining({
          method: 'POST',
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws a descriptive error when the resource name is invalid', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');
    const client = new VertexAiExampleStoreApiClient({
      auth: {getAccessToken: vi.fn().mockResolvedValue('token')},
    });

    await expect(
      client.searchExamples({
        ...sampleRequest,
        exampleStore: 'projects/missing-segments',
      }),
    ).rejects.toThrow(/Invalid Vertex AI Example Store resource name/);

    await expect(
      client.searchExamples({
        ...sampleRequest,
        exampleStore: 'bare-id-without-env',
      }),
    ).rejects.toThrow(/GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION/);
  });

  it('throws an error with status and body when the HTTP response is not OK', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('Permission denied', {status: 403}));

    try {
      const client = new VertexAiExampleStoreApiClient({
        auth: {getAccessToken: vi.fn().mockResolvedValue('token')},
      });

      await expect(client.searchExamples(sampleRequest)).rejects.toThrow(
        'Vertex AI Example Store request failed with status 403: Permission denied',
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws an error when GoogleAuth returns no access token', async () => {
    const client = new VertexAiExampleStoreApiClient({
      auth: {getAccessToken: vi.fn().mockResolvedValue(null)},
    });

    await expect(client.searchExamples(sampleRequest)).rejects.toThrow(
      'Failed to obtain an access token for Vertex AI Example Store.',
    );
  });
});
