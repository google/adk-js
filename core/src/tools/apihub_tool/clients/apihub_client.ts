/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {parseServiceAccountJson} from './service_account.js';

/** Root of the API Hub REST API that every request is made against. */
const APIHUB_ROOT_URL = 'https://apihub.googleapis.com/v1';

/** OAuth scope requested for tokens minted by the client itself. */
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** The `accept` header sent with every API Hub request. */
const ACCEPT_HEADER = 'application/json, text/plain, */*';

/**
 * Fetches the content of an API specification registered in API Hub.
 *
 * Implement this interface to give an `APIHubToolset` a different source of
 * specs, such as a cache, a local file, or a test double.
 */
export interface BaseAPIHubClient {
  /**
   * Returns the content of the spec that `path` resolves to.
   *
   * @param path An API, API version or API spec resource name, or an API Hub
   *     console URL.
   */
  getSpecContent(path: string): Promise<string>;
}

/** Options for {@link APIHubClient}. */
export interface APIHubClientOptions {
  /**
   * An OAuth access token sent as the bearer token on every request, for
   * example the output of `gcloud auth print-access-token`. Takes precedence
   * over `serviceAccountJson`.
   */
  accessToken?: string;
  /**
   * The content of a service account key file, as a JSON string. Used to mint
   * access tokens when `accessToken` is not set. When neither is set, the
   * client uses application default credentials.
   */
  serviceAccountJson?: string;
}

/** An API resource as API Hub returns it. */
export interface APIHubApi {
  /** Resource name, `projects/{p}/locations/{l}/apis/{a}`. */
  name: string;
  /** Resource names of the versions of this API. */
  versions?: string[];
}

/** An API version resource as API Hub returns it. */
export interface APIHubApiVersion {
  /** Resource name, `projects/{p}/locations/{l}/apis/{a}/versions/{v}`. */
  name: string;
  /** Resource names of the specs attached to this version. */
  specs?: string[];
}

/** The resource names parsed out of an API Hub path or URL. */
export interface APIHubResourceNames {
  /** `projects/{p}/locations/{l}/apis/{a}`. */
  apiResourceName: string;
  /** `.../apis/{a}/versions/{v}`, when the input names a version. */
  apiVersionResourceName?: string;
  /** `.../versions/{v}/specs/{s}`, when the input names a version and a spec. */
  apiSpecResourceName?: string;
}

/**
 * Client for the API Hub REST API.
 *
 * Each request sends a bearer token. The token is `accessToken` when it is
 * set; otherwise the client mints one from `serviceAccountJson`, or from
 * application default credentials when that is not set either. Minted tokens
 * are cached and refreshed by `google-auth-library`.
 */
export class APIHubClient implements BaseAPIHubClient {
  private readonly accessToken?: string;
  private readonly serviceAccountJson?: string;
  private auth?: GoogleAuth;

  constructor(options: APIHubClientOptions = {}) {
    if (options.accessToken) {
      this.accessToken = options.accessToken;
    } else if (options.serviceAccountJson) {
      this.serviceAccountJson = options.serviceAccountJson;
    }
  }

  /**
   * Returns the content of the first spec that `path` resolves to.
   *
   * - A path naming an API resolves to the first spec of its first version.
   * - A path naming an API version resolves to the first spec of that version.
   * - A path naming an API spec resolves to that spec.
   *
   * `path` may be a resource name such as
   * `projects/my-project/locations/us-central1/apis/my-api`, or a console URL
   * such as
   * `https://console.cloud.google.com/apigee/api-hub/locations/us-central1/apis/my-api?project=my-project`.
   *
   * @param path The API, API version or API spec to read.
   * @return The decoded spec content, or `''` when the spec is empty.
   * @throws When the path cannot be parsed, when the API has no versions, when
   *     the version has no specs, or when a request fails.
   */
  async getSpecContent(path: string): Promise<string> {
    const names = extractResourceName(path);
    let apiVersionResourceName = names.apiVersionResourceName;
    let apiSpecResourceName = names.apiSpecResourceName;

    if (!apiVersionResourceName) {
      const api = await this.getApi(names.apiResourceName);
      const versions = api.versions ?? [];
      if (versions.length === 0) {
        throw new Error(
          `No versions found in API Hub resource: ${names.apiResourceName}`,
        );
      }
      apiVersionResourceName = versions[0];
    }

    if (!apiSpecResourceName) {
      const apiVersion = await this.getApiVersion(apiVersionResourceName);
      const specs = apiVersion.specs ?? [];
      if (specs.length === 0) {
        throw new Error(
          `No specs found in API Hub version: ${apiVersionResourceName}`,
        );
      }
      apiSpecResourceName = specs[0];
    }

    if (apiSpecResourceName) {
      return this.fetchSpec(apiSpecResourceName);
    }

    throw new Error(`No API Hub resource found in path: ${path}`);
  }

  /**
   * Lists the APIs registered in a project and location.
   *
   * @param project The Google Cloud project ID.
   * @param location The API Hub location, for example `us-central1`.
   * @return The APIs, or an empty array when there are none.
   */
  async listApis(project: string, location: string): Promise<APIHubApi[]> {
    const body = await this.get<{apis?: APIHubApi[]}>(
      `${APIHUB_ROOT_URL}/projects/${project}/locations/${location}/apis`,
    );
    return body.apis ?? [];
  }

  /**
   * Gets an API by resource name.
   *
   * @param apiResourceName `projects/{p}/locations/{l}/apis/{a}`.
   */
  async getApi(apiResourceName: string): Promise<APIHubApi> {
    return this.get<APIHubApi>(`${APIHUB_ROOT_URL}/${apiResourceName}`);
  }

  /**
   * Gets an API version by resource name.
   *
   * @param apiVersionName `projects/{p}/locations/{l}/apis/{a}/versions/{v}`.
   */
  async getApiVersion(apiVersionName: string): Promise<APIHubApiVersion> {
    return this.get<APIHubApiVersion>(`${APIHUB_ROOT_URL}/${apiVersionName}`);
  }

  /** Reads the base64-encoded contents of a spec and decodes them as UTF-8. */
  private async fetchSpec(apiSpecResourceName: string): Promise<string> {
    const body = await this.get<{contents?: string}>(
      `${APIHUB_ROOT_URL}/${apiSpecResourceName}:contents`,
    );
    if (!body.contents) {
      return '';
    }
    return Buffer.from(body.contents, 'base64').toString('utf-8');
  }

  /** Sends an authenticated GET request and parses the JSON response. */
  private async get<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        accept: ACCEPT_HEADER,
        Authorization: `Bearer ${await this.getAccessToken()}`,
      },
    });
    if (!response.ok) {
      throw new Error(
        `API Hub request failed with status ${response.status}: ${url}`,
      );
    }
    return (await response.json()) as T;
  }

  /**
   * Returns the bearer token for the next request.
   *
   * `GoogleAuth` is created once and reused, so that it can cache the token
   * and refresh it when it expires.
   */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }

    this.auth ??= this.createAuth();

    let token: string | null | undefined;
    try {
      token = await this.auth.getAccessToken();
    } catch (e: unknown) {
      throw this.tokenError(e);
    }
    if (!token) {
      throw this.tokenError();
    }
    return token;
  }

  /**
   * Builds the error for a token that could not be obtained.
   *
   * Without a service account, the likely fix is to supply a credential. With
   * one, the key itself was rejected, so the error says so and gives the
   * reason.
   */
  private tokenError(cause?: unknown): Error {
    if (!this.serviceAccountJson) {
      return new Error(
        'Please provide a service account or an access token to API Hub client.',
        {cause},
      );
    }
    const reason =
      cause === undefined
        ? 'no token was returned'
        : cause instanceof Error
          ? cause.message
          : String(cause);
    return new Error(
      `Failed to get an access token for API Hub client from the given ` +
        `service account: ${reason}`,
      {cause},
    );
  }

  private createAuth(): GoogleAuth {
    const scopes = [CLOUD_PLATFORM_SCOPE];
    if (!this.serviceAccountJson) {
      return new GoogleAuth({scopes});
    }
    return new GoogleAuth({
      credentials: parseServiceAccountJson(this.serviceAccountJson),
      scopes,
    });
  }
}

/**
 * Returns the value that follows `key` in `segments`, if any.
 */
function segmentAfter(segments: string[], key: string): string | undefined {
  const index = segments.indexOf(key);
  if (index === -1 || index + 1 >= segments.length) {
    return undefined;
  }
  return segments[index + 1];
}

/**
 * Splits a URL or a resource path into its path and its query parameters.
 *
 * An absolute URL is parsed with `URL`. Anything else is split on the first
 * `?`, because `URL` rejects relative inputs such as `projects/...`.
 */
function splitPathAndQuery(urlOrPath: string): {
  path: string;
  query: URLSearchParams;
} {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(urlOrPath)) {
    try {
      const url = new URL(urlOrPath);
      return {path: url.pathname, query: url.searchParams};
    } catch {
      // Fall through and treat the input as a plain path.
    }
  }
  const queryStart = urlOrPath.indexOf('?');
  if (queryStart === -1) {
    return {path: urlOrPath, query: new URLSearchParams()};
  }
  return {
    path: urlOrPath.slice(0, queryStart),
    query: new URLSearchParams(urlOrPath.slice(queryStart + 1)),
  };
}

/**
 * Extracts the API, API version and API spec resource names from an API Hub
 * resource path or console URL.
 *
 * The project comes from a `projects/{p}` segment, or from a `project` query
 * parameter when the path has none. The location and the API are required.
 * The spec name is returned only when both a version and a spec are present.
 *
 * @param urlOrPath A resource name, or a console URL under `api-hub/`.
 * @throws When the project, the location or the API cannot be found.
 */
export function extractResourceName(urlOrPath: string): APIHubResourceNames {
  const {path: rawPath, query} = splitPathAndQuery(urlOrPath);

  // A console URL carries a prefix, such as `/apigee/api-hub/`, before the
  // resource path.
  let path = rawPath;
  if (path.includes('api-hub/')) {
    path = path.split('api-hub')[1];
  }

  const segments = path.split('/').filter((segment) => segment);

  const project = segments.includes('projects')
    ? segmentAfter(segments, 'projects')
    : (query.get('project') ?? undefined);
  if (!project) {
    throw new Error(
      `Project ID not found in URL or path in APIHubClient. Input path is ` +
        `'${urlOrPath}'. Please make sure there is either ` +
        `'/projects/PROJECT_ID' in the path or 'project=PROJECT_ID' query ` +
        `param in the input.`,
    );
  }

  const location = segmentAfter(segments, 'locations');
  if (!location) {
    throw new Error(
      `Location not found in URL or path in APIHubClient. Input path is ` +
        `'${urlOrPath}'. Please make sure there is either ` +
        `'/location/LOCATION_ID' in the path.`,
    );
  }

  const apiId = segmentAfter(segments, 'apis');
  if (!apiId) {
    throw new Error(
      `API id not found in URL or path in APIHubClient. Input path is ` +
        `'${urlOrPath}'. Please make sure there is either ` +
        `'/apis/API_ID' in the path.`,
    );
  }

  const versionId = segmentAfter(segments, 'versions');
  const specId = segmentAfter(segments, 'specs');

  const apiResourceName = `projects/${project}/locations/${location}/apis/${apiId}`;
  const apiVersionResourceName = versionId
    ? `${apiResourceName}/versions/${versionId}`
    : undefined;
  const apiSpecResourceName =
    apiVersionResourceName && specId
      ? `${apiVersionResourceName}/specs/${specId}`
      : undefined;

  return {apiResourceName, apiVersionResourceName, apiSpecResourceName};
}
