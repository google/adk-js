/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {APIHubClient} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {extractResourceName} from '../../../../src/tools/apihub_tool/clients/apihub_client.js';

const {getAccessToken} = vi.hoisted(() => ({getAccessToken: vi.fn()}));

vi.mock('google-auth-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('google-auth-library')>();
  return {...actual, GoogleAuth: vi.fn(() => ({getAccessToken}))};
});

const API_NAME = 'projects/test-project/locations/us-central1/apis/api1';
const VERSION_NAME = `${API_NAME}/versions/v1`;
const SPEC_NAME = `${VERSION_NAME}/specs/spec1`;

const MOCK_API_LIST = {
  apis: [
    {name: 'projects/test-project/locations/us-central1/apis/api1'},
    {name: 'projects/test-project/locations/us-central1/apis/api2'},
  ],
};
const MOCK_API_DETAIL = {name: API_NAME, versions: [VERSION_NAME]};
const MOCK_API_VERSION = {name: VERSION_NAME, specs: [SPEC_NAME]};
const MOCK_SPEC_CONTENT = {
  contents: Buffer.from('spec content').toString('base64'),
};

const EXPECTED_HEADERS = {
  accept: 'application/json, text/plain, */*',
  Authorization: 'Bearer mocked_token',
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('APIHubClient', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: Mock;
  let client: APIHubClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    client = new APIHubClient({accessToken: 'mocked_token'});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  describe('listApis', () => {
    it('returns the APIs and sends the expected URL and headers', async () => {
      fetchMock.mockResolvedValue(jsonResponse(MOCK_API_LIST));

      const apis = await client.listApis('test-project', 'us-central1');

      expect(apis).toEqual(MOCK_API_LIST.apis);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://apihub.googleapis.com/v1/projects/test-project/locations/us-central1/apis',
        {headers: EXPECTED_HEADERS},
      );
    });

    it('returns an empty array when there are no APIs', async () => {
      fetchMock.mockResolvedValue(jsonResponse({apis: []}));

      expect(await client.listApis('test-project', 'us-central1')).toEqual([]);
    });

    it('returns an empty array when the response has no apis field', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      expect(await client.listApis('test-project', 'us-central1')).toEqual([]);
    });

    it('rejects when the response is not ok', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, 403));

      await expect(
        client.listApis('test-project', 'us-central1'),
      ).rejects.toThrow(
        'API Hub request failed with status 403: https://apihub.googleapis.com/v1/projects/test-project/locations/us-central1/apis',
      );
    });
  });

  describe('getApi', () => {
    it('returns the API', async () => {
      fetchMock.mockResolvedValue(jsonResponse(MOCK_API_DETAIL));

      expect(await client.getApi(API_NAME)).toEqual(MOCK_API_DETAIL);
      expect(fetchMock).toHaveBeenCalledWith(
        `https://apihub.googleapis.com/v1/${API_NAME}`,
        {headers: EXPECTED_HEADERS},
      );
    });

    it('rejects when the response is not ok', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, 404));

      await expect(client.getApi(API_NAME)).rejects.toThrow('status 404');
    });
  });

  describe('getApiVersion', () => {
    it('returns the API version', async () => {
      fetchMock.mockResolvedValue(jsonResponse(MOCK_API_VERSION));

      expect(await client.getApiVersion(VERSION_NAME)).toEqual(
        MOCK_API_VERSION,
      );
      expect(fetchMock).toHaveBeenCalledWith(
        `https://apihub.googleapis.com/v1/${VERSION_NAME}`,
        {headers: EXPECTED_HEADERS},
      );
    });

    it('rejects when the response is not ok', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, 500));

      await expect(client.getApiVersion(VERSION_NAME)).rejects.toThrow(
        'status 500',
      );
    });
  });

  describe('getSpecContent', () => {
    it('reads a spec path with one request to its contents', async () => {
      fetchMock.mockResolvedValue(jsonResponse(MOCK_SPEC_CONTENT));

      expect(await client.getSpecContent(SPEC_NAME)).toBe('spec content');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        `https://apihub.googleapis.com/v1/${SPEC_NAME}:contents`,
        {headers: EXPECTED_HEADERS},
      );
    });

    it('decodes non-ASCII contents as UTF-8', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({contents: Buffer.from('título ✓').toString('base64')}),
      );

      expect(await client.getSpecContent(SPEC_NAME)).toBe('título ✓');
    });

    it('returns an empty string when the contents are empty', async () => {
      fetchMock.mockResolvedValue(jsonResponse({contents: ''}));

      expect(await client.getSpecContent(SPEC_NAME)).toBe('');
    });

    it('rejects when the contents request fails', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, 500));

      await expect(client.getSpecContent(SPEC_NAME)).rejects.toThrow(
        'status 500',
      );
    });

    it('resolves an API path through its first version and first spec', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(MOCK_API_DETAIL))
        .mockResolvedValueOnce(jsonResponse(MOCK_API_VERSION))
        .mockResolvedValueOnce(jsonResponse(MOCK_SPEC_CONTENT));

      expect(await client.getSpecContent(API_NAME)).toBe('spec content');
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        `https://apihub.googleapis.com/v1/${API_NAME}`,
        `https://apihub.googleapis.com/v1/${VERSION_NAME}`,
        `https://apihub.googleapis.com/v1/${SPEC_NAME}:contents`,
      ]);
    });

    it('resolves a version path through its first spec', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(MOCK_API_VERSION))
        .mockResolvedValueOnce(jsonResponse(MOCK_SPEC_CONTENT));

      expect(await client.getSpecContent(VERSION_NAME)).toBe('spec content');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        `https://apihub.googleapis.com/v1/${VERSION_NAME}`,
        `https://apihub.googleapis.com/v1/${SPEC_NAME}:contents`,
      ]);
    });

    it('rejects when the API has no versions', async () => {
      fetchMock.mockResolvedValue(jsonResponse({name: API_NAME, versions: []}));

      await expect(client.getSpecContent(API_NAME)).rejects.toThrow(
        `No versions found in API Hub resource: ${API_NAME}`,
      );
    });

    it('rejects when the version has no specs', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(MOCK_API_DETAIL))
        .mockResolvedValueOnce(jsonResponse({name: VERSION_NAME, specs: []}));

      await expect(client.getSpecContent(API_NAME)).rejects.toThrow(
        `No specs found in API Hub version: ${VERSION_NAME}`,
      );
      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        `https://apihub.googleapis.com/v1/${API_NAME}`,
        `https://apihub.googleapis.com/v1/${VERSION_NAME}`,
      ]);
    });

    it('rejects an invalid path without sending a request', async () => {
      await expect(client.getSpecContent('invalid-path')).rejects.toThrow(
        "Project ID not found in URL or path in APIHubClient. Input path is 'invalid-path'.",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('extractResourceName', () => {
  it.each([
    {
      input: 'projects/test-project/locations/us-central1/apis/api1',
      expected: {
        apiResourceName:
          'projects/test-project/locations/us-central1/apis/api1',
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      },
    },
    {
      input:
        'projects/test-project/locations/us-central1/apis/api1/versions/v1',
      expected: {
        apiResourceName:
          'projects/test-project/locations/us-central1/apis/api1',
        apiVersionResourceName:
          'projects/test-project/locations/us-central1/apis/api1/versions/v1',
        apiSpecResourceName: undefined,
      },
    },
    {
      input:
        'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
      expected: {
        apiResourceName:
          'projects/test-project/locations/us-central1/apis/api1',
        apiVersionResourceName:
          'projects/test-project/locations/us-central1/apis/api1/versions/v1',
        apiSpecResourceName:
          'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
      },
    },
    {
      input:
        'https://console.cloud.google.com/apigee/api-hub/projects/test-project/locations/us-central1/apis/api1/versions/v1?project=test-project',
      expected: {
        apiResourceName:
          'projects/test-project/locations/us-central1/apis/api1',
        apiVersionResourceName:
          'projects/test-project/locations/us-central1/apis/api1/versions/v1',
        apiSpecResourceName: undefined,
      },
    },
    {
      input:
        'https://console.cloud.google.com/apigee/api-hub/projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1?project=test-project',
      expected: {
        apiResourceName:
          'projects/test-project/locations/us-central1/apis/api1',
        apiVersionResourceName:
          'projects/test-project/locations/us-central1/apis/api1/versions/v1',
        apiSpecResourceName:
          'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
      },
    },
    {
      input:
        '/projects/test-project/locations/us-central1/apis/api1/versions/v1',
      expected: {
        apiResourceName:
          'projects/test-project/locations/us-central1/apis/api1',
        apiVersionResourceName:
          'projects/test-project/locations/us-central1/apis/api1/versions/v1',
        apiSpecResourceName: undefined,
      },
    },
    {
      input: 'projects/test-project/locations/us-central1/apis/api1/',
      expected: {
        apiResourceName:
          'projects/test-project/locations/us-central1/apis/api1',
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      },
    },
    {
      input: 'projects/test-project/locations/LOCATION/apis/api1/',
      expected: {
        apiResourceName: 'projects/test-project/locations/LOCATION/apis/api1',
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      },
    },
    {
      input: 'projects/p1/locations/l1/apis/a1/versions/v1/specs/s1',
      expected: {
        apiResourceName: 'projects/p1/locations/l1/apis/a1',
        apiVersionResourceName: 'projects/p1/locations/l1/apis/a1/versions/v1',
        apiSpecResourceName:
          'projects/p1/locations/l1/apis/a1/versions/v1/specs/s1',
      },
    },
  ])('parses $input', ({input, expected}) => {
    expect(extractResourceName(input)).toEqual(expected);
  });

  it('reads the project from the query when the path has none', () => {
    expect(
      extractResourceName(
        'https://console.cloud.google.com/apigee/api-hub/locations/us-central1/apis/api1?project=query-project',
      ),
    ).toEqual({
      apiResourceName: 'projects/query-project/locations/us-central1/apis/api1',
      apiVersionResourceName: undefined,
      apiSpecResourceName: undefined,
    });
  });

  it('ignores a spec segment when there is no version', () => {
    expect(
      extractResourceName('projects/p1/locations/l1/apis/a1/specs/s1'),
    ).toEqual({
      apiResourceName: 'projects/p1/locations/l1/apis/a1',
      apiVersionResourceName: undefined,
      apiSpecResourceName: undefined,
    });
  });

  it.each([
    {
      input: 'invalid-path',
      message: 'Project ID not found in URL or path in APIHubClient.',
    },
    {
      input: 'projects/test-project',
      message: 'Location not found in URL or path in APIHubClient.',
    },
    {
      input: 'projects/test-project/locations/us-central1',
      message: 'API id not found in URL or path in APIHubClient.',
    },
  ])('rejects $input', ({input, message}) => {
    expect(() => extractResourceName(input)).toThrow(message);
  });
});

describe('APIHubClient access tokens', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({apis: []}));
    globalThis.fetch = fetchMock;
    getAccessToken.mockReset().mockResolvedValue('minted_token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  function sentAuthorization(callIndex = 0): string {
    const init = fetchMock.mock.calls[callIndex][1] as {
      headers: Record<string, string>;
    };
    return init.headers['Authorization'];
  }

  it('uses application default credentials when no option is given', async () => {
    await new APIHubClient().listApis('p', 'l');

    expect(GoogleAuth).toHaveBeenCalledTimes(1);
    expect(GoogleAuth).toHaveBeenCalledWith({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    expect(sentAuthorization()).toBe('Bearer minted_token');
  });

  it('parses the service account JSON and requests the cloud-platform scope', async () => {
    const serviceAccount = {
      type: 'service_account',
      project_id: 'test',
      token_uri: 'test.com',
      client_email: 'test@example.com',
      private_key: '1234',
    };

    await new APIHubClient({
      serviceAccountJson: JSON.stringify(serviceAccount),
    }).listApis('p', 'l');

    expect(GoogleAuth).toHaveBeenCalledWith({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    expect(sentAuthorization()).toBe('Bearer minted_token');
  });

  it('reuses one GoogleAuth and asks it for a token on every request', async () => {
    getAccessToken
      .mockResolvedValueOnce('first_token')
      .mockResolvedValueOnce('refreshed_token');
    const client = new APIHubClient();

    await client.listApis('p', 'l');
    await client.listApis('p', 'l');

    expect(GoogleAuth).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(sentAuthorization(0)).toBe('Bearer first_token');
    expect(sentAuthorization(1)).toBe('Bearer refreshed_token');
  });

  it('asks for a credential when default credentials cannot be resolved', async () => {
    const cause = new Error('Could not load the default credentials.');
    getAccessToken.mockRejectedValue(cause);

    const result = new APIHubClient().listApis('p', 'l');

    await expect(result).rejects.toThrow(
      'Please provide a service account or an access token to API Hub client.',
    );
    await expect(result).rejects.toMatchObject({cause});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for a credential when no token comes back', async () => {
    getAccessToken.mockResolvedValue(null);

    await expect(new APIHubClient().listApis('p', 'l')).rejects.toThrow(
      'Please provide a service account or an access token to API Hub client.',
    );
  });

  it('does not use GoogleAuth when an access token is given', async () => {
    await new APIHubClient({
      accessToken: 'given_token',
      serviceAccountJson: '{}',
    }).listApis('p', 'l');

    expect(GoogleAuth).not.toHaveBeenCalled();
    expect(sentAuthorization()).toBe('Bearer given_token');
  });

  it('rejects invalid service account JSON', async () => {
    await expect(
      new APIHubClient({serviceAccountJson: '{not json'}).listApis('p', 'l'),
    ).rejects.toThrow('Invalid service account JSON:');
    expect(GoogleAuth).not.toHaveBeenCalled();
  });

  it('reports why a token could not be minted from the service account', async () => {
    const cause = new Error('invalid_grant: account not found');
    getAccessToken.mockRejectedValue(cause);

    const result = new APIHubClient({
      serviceAccountJson: JSON.stringify({type: 'service_account'}),
    }).listApis('p', 'l');

    await expect(result).rejects.toThrow(
      'Failed to get an access token for API Hub client from the given ' +
        'service account: invalid_grant: account not found',
    );
    await expect(result).rejects.toMatchObject({cause});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an empty token from the service account', async () => {
    getAccessToken.mockResolvedValue(null);

    await expect(
      new APIHubClient({
        serviceAccountJson: JSON.stringify({type: 'service_account'}),
      }).listApis('p', 'l'),
    ).rejects.toThrow(
      'Failed to get an access token for API Hub client from the given ' +
        'service account: no token was returned',
    );
  });
});
