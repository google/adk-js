/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Context} from '../../src/agents/context.js';
import {InputValidationError} from '../../src/errors/input_validation_error.js';
import {
  DiscoveryEngineRestClient,
  DiscoveryEngineSearchApiRequest,
  DiscoveryEngineSearchApiResponse,
  DiscoveryEngineSearchClient,
  DiscoveryEngineSearchTool,
  DiscoveryEngineSearchToolParams,
  isDiscoveryEngineSearchTool,
  SearchResultMode,
} from '../../src/tools/discovery_engine_search_tool.js';
import {isFunctionTool} from '../../src/tools/function_tool.js';

function invalidParams(
  params: Record<string, unknown>,
): DiscoveryEngineSearchToolParams {
  return params as unknown as DiscoveryEngineSearchToolParams;
}

function createMockClient(
  impl?: (
    req: DiscoveryEngineSearchApiRequest,
  ) => Promise<DiscoveryEngineSearchApiResponse>,
) {
  const search = vi.fn(
    impl ?? (async (): Promise<DiscoveryEngineSearchApiResponse> => ({})),
  );
  return {client: {search} satisfies DiscoveryEngineSearchClient, search};
}

describe('DiscoveryEngineSearchTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initialization and declaration', () => {
    it('initializes with dataStoreId and builds servingConfig', () => {
      const {client} = createMockClient();
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        client,
      });

      expect(tool.servingConfig).toBe(
        'test_data_store/servingConfigs/default_config',
      );
      expect(tool.resolvedLocation).toBe('global');
      expect(tool.currentSearchResultMode).toBeUndefined();
      expect(isDiscoveryEngineSearchTool(tool)).toBe(true);
      expect(isDiscoveryEngineSearchTool({})).toBe(false);
      expect(isFunctionTool(tool)).toBe(true);
    });

    it('initializes with searchEngineId and builds servingConfig', () => {
      const {client} = createMockClient();
      const tool = new DiscoveryEngineSearchTool({
        searchEngineId: 'test_search_engine',
        client,
      });

      expect(tool.servingConfig).toBe(
        'test_search_engine/servingConfigs/default_config',
      );
      expect(tool.resolvedLocation).toBe('global');
    });

    it('supports custom name and description in tool and _getDeclaration()', () => {
      const {client} = createMockClient();
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        name: 'custom_search',
        description: 'Custom search description.',
        client,
      });

      expect(tool.name).toBe('custom_search');
      expect(tool.description).toBe('Custom search description.');

      const declaration = tool._getDeclaration();
      expect(declaration.name).toBe('custom_search');
      expect(declaration.description).toBe('Custom search description.');
      expect(declaration.parameters?.properties?.query).toBeDefined();
    });

    it('supports custom name only and custom description only', () => {
      const {client} = createMockClient();
      const namedTool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        name: 'custom_search',
        client,
      });
      expect(namedTool.name).toBe('custom_search');
      expect(
        namedTool.description.startsWith(
          "Search through Vertex AI Search's discovery engine search API.",
        ),
      ).toBe(true);

      const describedTool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        description: 'Custom search description.',
        client,
      });
      expect(describedTool.name).toBe('discovery_engine_search');
      expect(describedTool.description).toBe('Custom search description.');
    });

    it('falls back to default name and description when empty strings are passed', () => {
      const {client} = createMockClient();
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        name: '',
        description: '',
        client,
      });

      expect(tool.name).toBe('discovery_engine_search');
      expect(
        tool.description.startsWith(
          "Search through Vertex AI Search's discovery engine search API.",
        ),
      ).toBe(true);

      const declaration = tool._getDeclaration();
      expect(declaration.name).toBe('discovery_engine_search');
      expect(
        declaration.description?.startsWith(
          "Search through Vertex AI Search's discovery engine search API.",
        ),
      ).toBe(true);
    });
  });

  describe('input and security validation', () => {
    it('throws InputValidationError when neither dataStoreId nor searchEngineId is specified', () => {
      expect(() => new DiscoveryEngineSearchTool(invalidParams({}))).toThrow(
        InputValidationError,
      );
      expect(() => new DiscoveryEngineSearchTool(invalidParams({}))).toThrow(
        'Either dataStoreId or searchEngineId must be specified.',
      );
    });

    it('throws InputValidationError when both dataStoreId and searchEngineId are specified', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool(
            invalidParams({
              dataStoreId: 'test_data_store',
              searchEngineId: 'test_search_engine',
            }),
          ),
      ).toThrow(InputValidationError);
      expect(
        () =>
          new DiscoveryEngineSearchTool(
            invalidParams({
              dataStoreId: 'test_data_store',
              searchEngineId: 'test_search_engine',
            }),
          ),
      ).toThrow('Either dataStoreId or searchEngineId must be specified.');
    });

    it('throws InputValidationError when dataStoreSpecs is specified without searchEngineId', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool(
            invalidParams({
              dataStoreId: 'test_data_store',
              dataStoreSpecs: [{dataStore: 'ds1'}],
            }),
          ),
      ).toThrow(
        'searchEngineId must be specified if dataStoreSpecs is specified.',
      );
    });

    it('throws InputValidationError on non-positive or non-integer maxResults', () => {
      const {client} = createMockClient();
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId: 'test_data_store',
            maxResults: 0,
            client,
          }),
      ).toThrow(InputValidationError);
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId: 'test_data_store',
            maxResults: 2.5,
            client,
          }),
      ).toThrow('maxResults must be a positive integer if specified.');
    });

    it.each([
      [
        {
          dataStoreId:
            'projects/test/locations/eu/collections/default_collection/dataStores/test_data_store',
        },
        'eu',
        'https://eu-discoveryengine.googleapis.com',
      ],
      [
        {
          searchEngineId:
            'projects/test/locations/us/collections/default_collection/engines/test_search_engine',
        },
        'us',
        'https://us-discoveryengine.googleapis.com',
      ],
      [
        {
          dataStoreId:
            'projects/test/locations/europe-west1/collections/default_collection/dataStores/test_data_store',
        },
        'europe-west1',
        'https://europe-west1-discoveryengine.googleapis.com',
      ],
      [
        {
          dataStoreId:
            'projects/test/locations/global/collections/default_collection/dataStores/test_data_store',
        },
        'global',
        'https://discoveryengine.googleapis.com',
      ],
    ])(
      'resolves regional and global endpoints correctly for %o',
      (toolParams, expectedLocation, expectedBaseUrl) => {
        const tool = new DiscoveryEngineSearchTool(
          toolParams as DiscoveryEngineSearchToolParams,
        );
        expect(tool.resolvedLocation).toBe(expectedLocation);
        const restClient = new DiscoveryEngineRestClient({
          location: tool.resolvedLocation,
        });
        expect(restClient.baseUrl).toBe(expectedBaseUrl);
      },
    );

    it('uses explicit location override when resource ID has no /locations/ segment', () => {
      const {client} = createMockClient();
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        location: 'EU',
        client,
      });
      expect(tool.resolvedLocation).toBe('eu');
    });

    it('rejects mismatched location override', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId:
              'projects/test/locations/us/collections/default_collection/dataStores/test_data_store',
            location: 'eu',
          }),
      ).toThrow(
        'location must match the location in dataStoreId or searchEngineId.',
      );
    });

    it('rejects empty location override', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId:
              'projects/test/locations/us/collections/default_collection/dataStores/test_data_store',
            location: '   ',
          }),
      ).toThrow('location must not be empty if specified.');
    });

    it('rejects invalid characters in location override (SSRF host injection protection)', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId: 'test_data_store',
            location: 'attacker.com#',
          }),
      ).toThrow('location must contain only letters, digits, and hyphens.');
    });

    it('rejects invalid characters in resource location', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId:
              'projects/test/locations/attacker.com#/collections/default_collection/dataStores/test_data_store',
          }),
      ).toThrow('Invalid location in dataStoreId or searchEngineId.');
    });

    it.each([
      '../projects/p/dataStores/d',
      'projects/p/../../evil',
      'projects/p/dataStores/d?alt=media',
      'projects/p/dataStores/d#fragment',
      'projects//dataStores/d',
      '  test_data_store  ',
      '',
    ])('rejects unsafe resource path %j', (unsafeId) => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId: unsafeId,
          }),
      ).toThrow(InputValidationError);
    });

    it('rejects empty dataStore entry in dataStoreSpecs', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            searchEngineId: 'test_engine',
            dataStoreSpecs: [{}],
          }),
      ).toThrow(InputValidationError);
    });
  });

  describe('DiscoveryEngineRestClient', () => {
    it('sends authenticated POST request with quota project header and parses response', async () => {
      const getRequestHeaders = vi
        .fn()
        .mockResolvedValue({Authorization: 'Bearer test-token'});
      vi.spyOn(GoogleAuth.prototype, 'getClient').mockResolvedValue({
        getRequestHeaders,
        quotaProjectId: 'test-quota-project',
      } as unknown as Awaited<ReturnType<GoogleAuth['getClient']>>);

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              {
                chunk: {
                  content: 'Chunk text',
                  documentMetadata: {
                    title: 'Doc Title',
                    uri: 'gs://bucket/doc',
                    structData: {uri: 'https://example.com/doc'},
                  },
                },
              },
            ],
          }),
          {status: 200, headers: {'Content-Type': 'application/json'}},
        ),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId:
          'projects/test/locations/eu/collections/default_collection/dataStores/test_store',
        filter: 'lang="en"',
        maxResults: 5,
      });

      const result = await tool.discoveryEngineSearch('adk search');

      expect(result).toEqual({
        status: 'success',
        results: [
          {
            title: 'Doc Title',
            url: 'https://example.com/doc',
            content: 'Chunk text',
          },
        ],
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
      expect(calledUrl).toBe(
        'https://eu-discoveryengine.googleapis.com/v1beta/projects/test/locations/eu/collections/default_collection/dataStores/test_store/servingConfigs/default_config:search',
      );
      expect(calledInit?.method).toBe('POST');
      const sentHeaders = calledInit?.headers as Headers;
      expect(sentHeaders.get('Authorization')).toBe('Bearer test-token');
      expect(sentHeaders.get('x-goog-user-project')).toBe('test-quota-project');
      expect(sentHeaders.get('Content-Type')).toBe('application/json');
      expect(JSON.parse(calledInit?.body as string)).toEqual({
        query: 'adk search',
        filter: 'lang="en"',
        pageSize: 5,
        contentSearchSpec: {
          searchResultMode: 'CHUNKS',
          chunkSpec: {
            numPreviousChunks: 0,
            numNextChunks: 0,
          },
        },
      });
    });

    it('surfaces structured JSON error message when HTTP response is non-OK', async () => {
      vi.spyOn(GoogleAuth.prototype, 'getClient').mockResolvedValue({
        getRequestHeaders: vi.fn().mockResolvedValue({}),
      } as unknown as Awaited<ReturnType<GoogleAuth['getClient']>>);

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {code: 403, message: 'Permission denied on data store'},
          }),
          {status: 403},
        ),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_store',
      });
      const result = await tool.discoveryEngineSearch('query');

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error_message).toContain(
          'Permission denied on data store',
        );
      }
      expect(tool._detectErrorInResponse(result)).toBe('TOOL_ERROR');
    });
  });

  describe('search behavior, result parsing, and mode auto-detection', () => {
    it('converts camelCase and snake_case dataStoreSpecs', async () => {
      const {client, search} = createMockClient(async () => ({results: []}));
      const dataStore =
        'projects/p/locations/global/collections/c/dataStores/d';

      const tool = new DiscoveryEngineSearchTool({
        searchEngineId: 'projects/p/locations/global/collections/c/engines/e',
        dataStoreSpecs: [{dataStore, filter: 'f'}, {data_store: dataStore}],
        client,
      });

      const result = await tool.discoveryEngineSearch('test query');
      expect(result).toEqual({status: 'success', results: []});
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({
          dataStoreSpecs: [{dataStore, filter: 'f'}, {dataStore}],
        }),
      );
      expect(tool._detectErrorInResponse(result)).toBeUndefined();
    });

    it('parses DOCUMENTS mode with structured data and strips title/uri/link from JSON content', async () => {
      const {client} = createMockClient(async () => ({
        results: [
          {
            document: {
              id: 'doc1',
              name: 'projects/p/locations/l/doc1',
              structData: {
                title: 'Jira Issue',
                uri: 'https://jira.example.com/123',
                link: 'https://fallback.example.com/123',
                summary: 'Bug fix for login',
              },
            },
          },
        ],
      }));

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
        client,
      });

      const result = await tool.discoveryEngineSearch('test query');
      expect(result).toEqual({
        status: 'success',
        results: [
          {
            title: 'Jira Issue',
            url: 'https://jira.example.com/123',
            content: JSON.stringify({summary: 'Bug fix for login'}),
          },
        ],
      });
    });

    it('parses DOCUMENTS mode with unstructured derivedStructData snippets and extractiveAnswers', async () => {
      const {client} = createMockClient(async () => ({
        results: [
          {
            document: {
              id: 'doc2',
              derivedStructData: {
                title: 'Web Page',
                link: 'https://example.com',
                snippets: [{snippet: 'Relevant text here'}],
              },
            },
          },
          {
            document: {
              id: 'doc3',
              derived_struct_data: {
                title: 'FAQ Page',
                link: 'https://example.com/faq',
                extractive_answers: ['Answer line 1', 'Answer line 2'],
              },
            },
          },
        ],
      }));

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
        client,
      });

      const result = await tool.discoveryEngineSearch('test query');
      expect(result).toEqual({
        status: 'success',
        results: [
          {
            title: 'Web Page',
            url: 'https://example.com',
            content: 'Relevant text here',
          },
          {
            title: 'FAQ Page',
            url: 'https://example.com/faq',
            content: 'Answer line 1\nAnswer line 2',
          },
        ],
      });
    });

    it('caches CHUNKS mode on successful auto-detect search', async () => {
      const {client, search} = createMockClient(async () => ({
        results: [
          {
            chunk: {
              content: 'Bug fix',
              document_metadata: {
                title: 'Jira Issue',
                uri: 'https://jira.example.com/123',
                struct_data: {summary: 'Bug fix'},
              },
            },
          },
        ],
      }));

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        client,
      });

      const result = await tool.discoveryEngineSearch('test query');
      expect(result).toEqual({
        status: 'success',
        results: [
          {
            title: 'Jira Issue',
            url: 'https://jira.example.com/123',
            content: 'Bug fix',
          },
        ],
      });
      expect(search).toHaveBeenCalledTimes(1);
      expect(tool.currentSearchResultMode).toBe(SearchResultMode.CHUNKS);
    });

    it('falls back to DOCUMENTS on structured datastore error and caches DOCUMENTS mode', async () => {
      let call = 0;
      const {client, search} = createMockClient(async (req) => {
        call += 1;
        if (
          req.contentSearchSpec.searchResultMode === SearchResultMode.CHUNKS
        ) {
          throw new Error(
            '`contentSearchSpec.searchResultMode` must be set to SearchRequest.ContentSearchSpec.SearchResultMode.DOCUMENTS when the engine contains structured data store.',
          );
        }
        return {
          results: [
            {
              document: {
                id: 'doc1',
                structData: {
                  title: 'Jira Issue',
                  uri: 'https://jira.example.com/123',
                  summary: 'Bug fix',
                },
              },
            },
          ],
        };
      });

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        client,
      });

      const first = await tool.discoveryEngineSearch('query 1');
      expect(first.status).toBe('success');
      expect(call).toBe(2);
      expect(tool.currentSearchResultMode).toBe(SearchResultMode.DOCUMENTS);

      // Subsequent call skips CHUNKS probe completely.
      const second = await tool.discoveryEngineSearch('query 2');
      expect(second.status).toBe('success');
      expect(search).toHaveBeenCalledTimes(3);
    });

    it('single-flights concurrent cold calls during structured datastore fallback', async () => {
      const workerCount = 8;
      const recordedModes: SearchResultMode[] = [];

      const {client} = createMockClient(async (req) => {
        const mode = req.contentSearchSpec.searchResultMode;
        recordedModes.push(mode);
        if (mode === SearchResultMode.CHUNKS) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          throw new Error(
            '`content_search_spec.search_result_mode` must be set to SearchRequest.ContentSearchSpec.SearchResultMode.DOCUMENTS when the engine contains structured data store.',
          );
        }
        return {
          results: [
            {
              document: {
                id: 'doc1',
                structData: {
                  title: 'Jira Issue',
                  uri: 'https://jira.example.com/123',
                  summary: `Result for ${req.query}`,
                },
              },
            },
          ],
        };
      });

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        client,
      });

      const responses = await Promise.all(
        Array.from({length: workerCount}, (_, idx) =>
          tool.discoveryEngineSearch(`test query ${idx}`),
        ),
      );

      expect(responses.every((r) => r.status === 'success')).toBe(true);
      expect(
        recordedModes.filter((m) => m === SearchResultMode.CHUNKS),
      ).toHaveLength(1);
      expect(
        recordedModes.filter((m) => m === SearchResultMode.DOCUMENTS),
      ).toHaveLength(workerCount);
      expect(tool.currentSearchResultMode).toBe(SearchResultMode.DOCUMENTS);
    });

    it('does not retry on unrelated API errors during auto-detection', async () => {
      const {client, search} = createMockClient(async () => {
        throw new Error('Permission denied');
      });

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        client,
      });

      const result = await tool.discoveryEngineSearch('test query');
      expect(result).toEqual({
        status: 'error',
        error_message: 'Permission denied',
      });
      expect(search).toHaveBeenCalledTimes(1);
      expect(tool.currentSearchResultMode).toBeUndefined();
    });

    it('runs end-to-end via FunctionTool.runAsync and validates query schema', async () => {
      const {client} = createMockClient(async (req) => ({
        results: [
          {
            chunk: {
              content: `Matched: ${req.query}`,
              documentMetadata: {title: 'Doc 1', uri: 'https://example.com/1'},
            },
          },
        ],
      }));

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        client,
      });
      const toolContext = {} as Context;

      const output = await tool.runAsync({
        args: {query: 'enterprise policy'},
        toolContext,
      });
      expect(output).toEqual({
        status: 'success',
        results: [
          {
            title: 'Doc 1',
            url: 'https://example.com/1',
            content: 'Matched: enterprise policy',
          },
        ],
      });

      await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
        "Error in tool 'discovery_engine_search':",
      );
    });
  });
});
