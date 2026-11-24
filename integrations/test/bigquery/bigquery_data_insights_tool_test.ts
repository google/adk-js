/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ASK_DATA_INSIGHTS_DESCRIPTION,
  askDataInsights,
  type AskDataInsightsArgs,
  askDataInsightsParameters,
  type AskDataInsightsResult,
  type AskDataInsightsSuccessResult,
  type BigQueryAuthClient,
  BigQueryToolConfig,
  type GoogleOAuthCredentials,
} from '@google/adk-integrations';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  extractDataResult,
  formatDataRetrieved,
  getStream,
} from '../../src/bigquery/data_insights_tool.js';

const PENGUIN_USER_QUESTION =
  'Penguins on which island have the highest average body mass?';

const PENGUIN_MOCK_API_STREAM = `[{
  "timestamp": "2025-07-17T17:25:28.231Z",
  "systemMessage": {
    "text": {
      "parts": [
        "Penguins on which island have the highest average body mass?"
      ],
      "textType": "THOUGHT"
    }
  }
}
,
{
  "timestamp": "2025-07-17T17:25:31.171Z",
  "systemMessage": {
    "data": {
      "generatedSql": "SELECT island, AVG(body_mass_g) AS average_body_mass\\nFROM \`bigframes-dev-perf\`.\`bigframes_testing_eu\`.\`penguins\`\\nGROUP BY island;"
    }
  }
}
,
{
  "timestamp": "2025-07-17T17:25:32.664Z",
  "systemMessage": {
    "data": {
      "result": {
        "data": [
          {
            "island": "Biscoe",
            "average_body_mass": "4716.017964071853"
          },
          {
            "island": "Dream",
            "average_body_mass": "3712.9032258064512"
          },
          {
            "island": "Torgersen",
            "average_body_mass": "3706.3725490196075"
          }
        ],
        "name": "average_body_mass_by_island",
        "schema": {
          "fields": [
            {
              "name": "island",
              "type": "STRING",
              "mode": "NULLABLE"
            },
            {
              "name": "average_body_mass",
              "type": "FLOAT",
              "mode": "NULLABLE"
            }
          ]
        }
      }
    }
  }
}
,
{
  "timestamp": "2025-07-17T17:25:40.018Z",
  "systemMessage": {
    "text": {
      "parts": [
        "Penguins on Biscoe island have the highest average body mass, with an average of 4716.02g."
      ],
      "textType": "FINAL_RESPONSE"
    }
  }
}
]`;

const PENGUIN_EXPECTED_OUTPUT: Array<Record<string, unknown>> = [
  {
    text: {
      parts: ['Penguins on which island have the highest average body mass?'],
      textType: 'THOUGHT',
    },
  },
  {
    data: {
      generatedSql:
        'SELECT island, AVG(body_mass_g) AS average_body_mass\nFROM `bigframes-dev-perf`.`bigframes_testing_eu`.`penguins`\nGROUP BY island;',
    },
  },
  {
    'Data Retrieved': {
      headers: ['island', 'average_body_mass'],
      rows: [
        ['Biscoe', '4716.017964071853'],
        ['Dream', '3712.9032258064512'],
        ['Torgersen', '3706.3725490196075'],
      ],
      summary: 'Showing all 3 rows.',
    },
  },
  {
    text: {
      parts: [
        'Penguins on Biscoe island have the highest average body mass, with an average of 4716.02g.',
      ],
      textType: 'FINAL_RESPONSE',
    },
  },
];

describe('askDataInsights and GDA stream helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('parses a full penguin insights stream and formats retrieved data rows', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(PENGUIN_MOCK_API_STREAM, {status: 200}));

    const credentials: GoogleOAuthCredentials = {
      token: 'fake-token',
      valid: true,
    };
    const config = new BigQueryToolConfig({maxQueryResultRows: 50});
    const args: AskDataInsightsArgs = {
      project_id: 'test-project',
      user_query_with_context: PENGUIN_USER_QUESTION,
      table_references: [],
      credentials,
      config,
    };

    const result: AskDataInsightsResult = await askDataInsights(args);

    expect(result).toEqual({
      status: 'SUCCESS',
      response: PENGUIN_EXPECTED_OUTPUT,
    } satisfies AskDataInsightsSuccessResult);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = fetchSpy.mock.calls[0] ?? [];
    expect(requestUrl).toBe(
      'https://geminidataanalytics.googleapis.com/v1/projects/test-project/locations/global:chat',
    );
    expect(requestInit?.method).toBe('POST');
    expect(requestInit?.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Goog-API-Client': 'GOOGLE_ADK',
      Authorization: 'Bearer fake-token',
    });
    const parsedBody = JSON.parse(
      typeof requestInit?.body === 'string' ? requestInit.body : '{}',
    ) as Record<string, unknown>;
    expect(parsedBody).toEqual({
      messages: [{userMessage: {text: PENGUIN_USER_QUESTION}}],
      inlineContext: {
        datasourceReferences: {bq: {tableReferences: []}},
        systemInstruction: expect.stringContaining(
          'INSTRUCTIONS - FOLLOW THESE RULES',
        ),
      },
      clientIdEnum: 'GOOGLE_ADK',
    });
  });

  it('targets geminidataanalytics.googleapis.com even when mTLS environment variables are enabled', async () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[{\n"systemMessage": {"text": {"parts": ["ok"]}}\n}]', {
        status: 200,
      }),
    );

    const result = await askDataInsights({
      project_id: 'domain.com:test-project',
      user_query_with_context: 'test query',
      table_references: [],
      credentials: {token: 'fake-token', valid: true},
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      response: [{text: {parts: ['ok']}}],
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [requestUrl] = fetchSpy.mock.calls[0] ?? [];
    expect(requestUrl).toBe(
      'https://geminidataanalytics.googleapis.com/v1/projects/domain.com:test-project/locations/global:chat',
    );
  });

  it('returns SUCCESS with parsed stream messages and forwards maxQueryResultRows', async () => {
    const streamBody = [
      '[{',
      '"systemMessage": {"text": {"parts": ["response1"], "textType": "THOUGHT"}}',
      '}',
      ',',
      '{',
      '"systemMessage": {"data": {"result": {"data": [{"id": 1}, {"id": 2}, {"id": 3}], "schema": {"fields": [{"name": "id"}]}}}}',
      '}',
      ',',
      '{',
      '"systemMessage": {"text": {"parts": ["response2"], "textType": "FINAL_RESPONSE"}}',
      '}]',
    ].join('\n');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(streamBody, {status: 200}));

    const result = await askDataInsights({
      project_id: 'test-project',
      user_query_with_context: 'test query',
      table_references: [
        {projectId: 'my-gcp-project', datasetId: 'sales', tableId: 'orders'},
      ],
      credentials: {token: 'fake-token', valid: true},
      config: new BigQueryToolConfig({maxQueryResultRows: 2}),
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [requestUrl] = fetchSpy.mock.calls[0] ?? [];
    expect(requestUrl).toBe(
      'https://geminidataanalytics.googleapis.com/v1/projects/test-project/locations/global:chat',
    );
    expect(result).toEqual({
      status: 'SUCCESS',
      response: [
        {text: {parts: ['response1'], textType: 'THOUGHT'}},
        {
          'Data Retrieved': {
            headers: ['id'],
            rows: [[1], [2]],
            summary: 'Showing the first 2 of 3 total rows.',
          },
        },
        {text: {parts: ['response2'], textType: 'FINAL_RESPONSE'}},
      ],
    });
  });

  it('returns ERROR when the streaming API call throws an exception', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('API call failed!'),
    );

    const result = await askDataInsights({
      project_id: 'test-project',
      user_query_with_context: 'test query',
      table_references: [],
      credentials: {token: 'fake-token', valid: true},
      config: new BigQueryToolConfig(),
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'API call failed!',
    });
  });

  it('returns ERROR when HTTP response status is non-OK', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Permission denied', {status: 403}),
    );

    const result = await askDataInsights({
      project_id: 'test-project',
      user_query_with_context: 'test query',
      table_references: [],
      credentials: {token: 'fake-token', valid: true},
    });

    expect(result.status).toBe('ERROR');
    if (result.status === 'ERROR') {
      expect(result.error_details).toContain('403');
      expect(result.error_details).toContain('Permission denied');
    }
  });

  it('returns ERROR when credentials lack a valid access token', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected fetch call'));

    const resultWithoutToken = await askDataInsights({
      project_id: 'test-project',
      user_query_with_context: 'test query',
      table_references: [],
      credentials: {valid: false},
    });

    expect(resultWithoutToken).toEqual({
      status: 'ERROR',
      error_details: 'ask_data_insights requires a valid access token.',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('authenticates with BigQueryAuthClient returning Headers or Record headers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('[{\n"systemMessage": {"text": {"parts": ["ok"]}}\n}]', {
          status: 200,
        }),
    );

    const headersAuthClient: BigQueryAuthClient = {
      getRequestHeaders: async () =>
        new Headers({Authorization: 'Bearer from-headers-instance'}),
    };

    const firstResult = await askDataInsights({
      project_id: 'test-project',
      user_query_with_context: 'test query',
      table_references: [],
      credentials: headersAuthClient,
    });
    expect(firstResult).toEqual({
      status: 'SUCCESS',
      response: [{text: {parts: ['ok']}}],
    });
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Goog-API-Client': 'GOOGLE_ADK',
      Authorization: 'Bearer from-headers-instance',
    });

    const tokenFallbackAuthClient: BigQueryAuthClient = {
      getRequestHeaders: async () => ({}),
      getAccessToken: async () => ({token: 'from-get-access-token'}),
    };

    const secondResult = await askDataInsights({
      project_id: 'test-project',
      user_query_with_context: 'test query',
      table_references: [],
      credentials: tokenFallbackAuthClient,
    });
    expect(secondResult.status).toBe('SUCCESS');
    expect(fetchSpy.mock.calls[1]?.[1]?.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Goog-API-Client': 'GOOGLE_ADK',
      Authorization: 'Bearer from-get-access-token',
    });
  });

  it.each(['', '.', '..', '.leading-dot', '-leading-hyphen', 'bad/project#id'])(
    'rejects invalid project ID %j before making a network request',
    async (invalidProjectId) => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Unexpected fetch call'));

      const result = await askDataInsights({
        project_id: invalidProjectId,
        user_query_with_context: 'test query',
        table_references: [],
        credentials: {token: 'fake-token'},
      });

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'A valid project_id is required for ask_data_insights.',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Number.NaN])(
    'returns ERROR when config.maxQueryResultRows is %s',
    async (invalidRows) => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Unexpected fetch call'));

      const result = await askDataInsights({
        project_id: 'test-project',
        user_query_with_context: 'test query',
        table_references: [],
        credentials: {token: 'fake-token', valid: true},
        config: {maxQueryResultRows: invalidRows},
      });

      expect(result).toEqual({
        status: 'ERROR',
        error_details: 'maxQueryResultRows must be a positive integer.',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('exposes askDataInsightsParameters and ASK_DATA_INSIGHTS_DESCRIPTION', () => {
    expect(ASK_DATA_INSIGHTS_DESCRIPTION).toContain(
      'Answers questions about structured data in BigQuery tables using natural language.',
    );
    const parsed = askDataInsightsParameters.parse({
      project_id: 'my-project',
      user_query_with_context: 'How many orders were placed?',
      table_references: [
        {projectId: 'my-project', datasetId: 'sales', tableId: 'orders'},
      ],
    });
    expect(parsed.project_id).toBe('my-project');
    expect(parsed.table_references).toHaveLength(1);
  });

  describe('extractDataResult', () => {
    it('extracts systemMessage.data.result when it contains a data array', () => {
      const msg = {
        systemMessage: {data: {result: {data: [1, 2], schema: {}}}},
      };
      expect(extractDataResult(msg)).toEqual({data: [1, 2], schema: {}});
    });

    it('returns undefined when systemMessage.data.result.data is missing or not an array', () => {
      expect(extractDataResult({})).toBeUndefined();
      expect(extractDataResult({systemMessage: null})).toBeUndefined();
      expect(extractDataResult({systemMessage: {data: null}})).toBeUndefined();
      expect(
        extractDataResult({systemMessage: {data: {result: null}}}),
      ).toBeUndefined();
      expect(
        extractDataResult({
          systemMessage: {data: {result: {noData: 1}}},
        }),
      ).toBeUndefined();
    });
  });

  describe('formatDataRetrieved', () => {
    it('formats a data result with schema fields when row count is within maxRows', () => {
      const result = {
        data: [{col1: 'val1', col2: 10}],
        schema: {fields: [{name: 'col1'}, {name: 'col2'}]},
      };
      expect(formatDataRetrieved(result, 10)).toEqual({
        'Data Retrieved': {
          headers: ['col1', 'col2'],
          rows: [['val1', 10]],
          summary: 'Showing all 1 rows.',
        },
      });
    });

    it('truncates rows to maxRows and reports the total row count in summary', () => {
      const result = {
        data: Array.from({length: 5}, (_, index) => ({col1: `val${index}`})),
        schema: {fields: [{name: 'col1'}]},
      };
      expect(formatDataRetrieved(result, 2)).toEqual({
        'Data Retrieved': {
          headers: ['col1'],
          rows: [['val0'], ['val1']],
          summary: 'Showing the first 2 of 5 total rows.',
        },
      });
    });

    it('derives headers from the first row when schema is missing', () => {
      const result = {data: [{col1: 'val1'}], schema: null};
      expect(formatDataRetrieved(result, 10)).toEqual({
        'Data Retrieved': {
          headers: ['col1'],
          rows: [['val1']],
          summary: 'Showing all 1 rows.',
        },
      });
    });

    it.each([0, -1, 1.5, Number.NaN])(
      'throws RangeError when maxRows is %s',
      (invalidRows) => {
        expect(() => formatDataRetrieved({data: []}, invalidRows)).toThrow(
          RangeError,
        );
        expect(() => formatDataRetrieved({data: []}, invalidRows)).toThrow(
          'maxQueryResultRows must be a positive integer.',
        );
      },
    );
  });

  describe('getStream', () => {
    it('replaces earlier Data Retrieved messages with Intermediate result omitted', async () => {
      const streamLines = [
        '[{',
        '"systemMessage": {"text": "msg1"}',
        '}',
        ',',
        '{',
        '"systemMessage": { "data": { "result": { "data": [{"a":1}], "schema": {"fields":[{"name":"a"}]}}}}',
        '}',
        ',',
        '{',
        '"systemMessage": { "data": { "result": { "data": [{"b":2}], "schema": {"fields":[{"name":"b"}]}}}}',
        '}',
        ',',
        '{',
        '"systemMessage": {"text": "msg4"}',
        '}]',
      ].join('\n');

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(streamLines, {status: 200}),
      );

      const messages = await getStream({
        url: 'https://geminidataanalytics.googleapis.com/v1/projects/p/locations/global:chat',
        caPayload: {},
        headers: {},
        maxQueryResultRows: 10,
      });

      expect(messages).toHaveLength(4);
      expect(messages[0]).toEqual({text: 'msg1'});
      expect(messages[1]).toEqual({
        'Data Retrieved': 'Intermediate result omitted',
      });
      expect(messages[2]).toEqual({
        'Data Retrieved': {
          headers: ['b'],
          rows: [[2]],
          summary: 'Showing all 1 rows.',
        },
      });
      expect(messages[3]).toEqual({text: 'msg4'});
    });
  });
});
