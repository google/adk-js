/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth, GoogleAuthOptions} from 'google-auth-library';
import {z} from 'zod/v4';
import {InputValidationError} from '../errors/input_validation_error.js';
import {ToolExecutionError} from '../errors/tool_execution_error.js';
import {logger} from '../utils/logger.js';
import {FunctionTool} from './function_tool.js';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_ENDPOINT = 'discoveryengine.googleapis.com';
const GLOBAL_LOCATION = 'global';
const DEFAULT_TOOL_NAME = 'discovery_engine_search';
const DEFAULT_TOOL_DESCRIPTION =
  "Search through Vertex AI Search's discovery engine search API.";

const STRUCTURED_STORE_ERROR_PATTERN = /search_?result_?mode.*DOCUMENTS/i;
const LOCATION_PATTERN = /\/locations\/([a-z0-9-]+)(?:\/|$)/i;
const VALID_LOCATION_PATTERN = /^[a-z0-9-]+$/;
const SAFE_RESOURCE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const DISCOVERY_ENGINE_SEARCH_PARAMETERS = z.object({
  query: z.string().describe('The search query.'),
});

type DiscoveryEngineSearchSchema = typeof DISCOVERY_ENGINE_SEARCH_PARAMETERS;

const DISCOVERY_ENGINE_SEARCH_TOOL_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.discoveryEngineSearchTool',
);

/**
 * Search result mode for Discovery Engine search.
 */
export enum SearchResultMode {
  /** Results as chunks (default). Works for unstructured data. */
  CHUNKS = 'CHUNKS',
  /** Results as documents. Required for structured datastores. */
  DOCUMENTS = 'DOCUMENTS',
}

/**
 * Specification defining a specific Discovery Engine data store to search.
 */
export interface DiscoveryEngineDataStoreSpec {
  /** Full resource name of the data store (camelCase). */
  dataStore?: string;
  /** Full resource name of the data store (snake_case alias). */
  data_store?: string;
  /** Optional filter expression applied to this data store. */
  filter?: string;
}

/**
 * Normalized data store specification sent in a Discovery Engine search request.
 */
export interface NormalizedDataStoreSpec {
  dataStore: string;
  filter?: string;
}

/**
 * ContentSearchSpec sent to the Discovery Engine Search API.
 */
export interface DiscoveryEngineContentSearchSpec {
  searchResultMode: SearchResultMode;
  chunkSpec?: {
    numPreviousChunks: number;
    numNextChunks: number;
  };
}

/**
 * Request parameters passed to {@link DiscoveryEngineSearchClient.search}.
 */
export interface DiscoveryEngineSearchApiRequest {
  servingConfig: string;
  query: string;
  contentSearchSpec: DiscoveryEngineContentSearchSpec;
  dataStoreSpecs?: NormalizedDataStoreSpec[];
  filter?: string;
  pageSize?: number;
}

/**
 * Document metadata attached to a Discovery Engine chunk result.
 */
export interface DiscoveryEngineChunkDocumentMetadata {
  title?: string;
  uri?: string;
  structData?: Record<string, unknown>;
  struct_data?: Record<string, unknown>;
}

/**
 * A chunk item returned by the Discovery Engine Search API.
 */
export interface DiscoveryEngineChunk {
  content?: string;
  documentMetadata?: DiscoveryEngineChunkDocumentMetadata;
  document_metadata?: DiscoveryEngineChunkDocumentMetadata;
}

/**
 * A document item returned by the Discovery Engine Search API.
 */
export interface DiscoveryEngineDocument {
  id?: string;
  name?: string;
  structData?: Record<string, unknown>;
  struct_data?: Record<string, unknown>;
  derivedStructData?: Record<string, unknown>;
  derived_struct_data?: Record<string, unknown>;
}

/**
 * Raw response returned by {@link DiscoveryEngineSearchClient.search}.
 */
export interface DiscoveryEngineSearchApiResponse {
  results?: Array<{
    chunk?: DiscoveryEngineChunk;
    document?: DiscoveryEngineDocument;
  }>;
}

/**
 * Transport interface for executing Discovery Engine search requests.
 */
export interface DiscoveryEngineSearchClient {
  search(
    request: DiscoveryEngineSearchApiRequest,
  ): Promise<DiscoveryEngineSearchApiResponse>;
}

/**
 * Options for {@link DiscoveryEngineRestClient}.
 */
export interface DiscoveryEngineRestClientOptions {
  /** Resolved Discovery Engine location (e.g. `"global"`, `"us"`, `"eu"`). */
  location: string;
  /** Optional `GoogleAuth` configuration. */
  googleAuthOptions?: GoogleAuthOptions;
}

/**
 * Normalized search result item returned by {@link DiscoveryEngineSearchTool}.
 */
export interface DiscoveryEngineSearchResultItem {
  title: string;
  url: string;
  content: string;
}

/**
 * Response object returned by {@link DiscoveryEngineSearchTool.discoveryEngineSearch}.
 */
export type DiscoveryEngineSearchResponse =
  | {
      status: 'success';
      results: DiscoveryEngineSearchResultItem[];
    }
  | {
      status: 'error';
      error_message: string;
    };

/**
 * Common configuration options shared by all {@link DiscoveryEngineSearchTool}
 * initialization modes.
 */
export interface BaseDiscoveryEngineSearchToolParams {
  /** Optional filter to apply to the search request. */
  filter?: string;
  /** Optional maximum number of results to return. */
  maxResults?: number;
  /**
   * Optional search result mode. When omitted, automatically detects the
   * mode by trying `CHUNKS` first and falling back to `DOCUMENTS` if the
   * datastore requires it.
   */
  searchResultMode?: SearchResultMode;
  /**
   * Optional endpoint location override (e.g. `"global"`, `"us"`, `"eu"`).
   * When omitted, location is inferred from `dataStoreId` or `searchEngineId`
   * and defaults to `"global"`.
   */
  location?: string;
  /**
   * Optional override for the tool name advertised to the model.
   * Defaults to `"discovery_engine_search"`.
   */
  name?: string;
  /**
   * Optional override for the tool description advertised to the model.
   */
  description?: string;
  /** Optional `GoogleAuth` configuration for authenticating REST requests. */
  googleAuthOptions?: GoogleAuthOptions;
  /** Optional custom search client (for example, in unit tests). */
  client?: DiscoveryEngineSearchClient;
}

/**
 * Parameters for initializing {@link DiscoveryEngineSearchTool} with a data store.
 */
export interface DiscoveryEngineDataStoreParams extends BaseDiscoveryEngineSearchToolParams {
  /**
   * The Vertex AI Search data store resource ID in the format
   * `projects/{project}/locations/{location}/collections/{collection}/dataStores/{dataStore}`.
   */
  dataStoreId: string;
  searchEngineId?: never;
  dataStoreSpecs?: never;
}

/**
 * Parameters for initializing {@link DiscoveryEngineSearchTool} with a search engine.
 */
export interface DiscoveryEngineSearchEngineParams extends BaseDiscoveryEngineSearchToolParams {
  /**
   * The Vertex AI Search engine resource ID in the format
   * `projects/{project}/locations/{location}/collections/{collection}/engines/{engine}`.
   */
  searchEngineId: string;
  dataStoreId?: never;
  /**
   * Specifications defining the specific data stores to be searched.
   * Only valid when `searchEngineId` is specified.
   */
  dataStoreSpecs?: DiscoveryEngineDataStoreSpec[];
}

/**
 * Parameters for initializing {@link DiscoveryEngineSearchTool}.
 */
export type DiscoveryEngineSearchToolParams =
  DiscoveryEngineDataStoreParams | DiscoveryEngineSearchEngineParams;

function normalizeLocation(location: string, locationType: string): string {
  const normalized = location.trim().toLowerCase();
  if (!normalized) {
    throw new InputValidationError(
      `${locationType} must not be empty if specified.`,
    );
  }
  if (!VALID_LOCATION_PATTERN.test(normalized)) {
    throw new InputValidationError(
      `${locationType} must contain only letters, digits, and hyphens.`,
    );
  }
  return normalized;
}

function extractResourceLocation(resourceId: string): string | undefined {
  if (!resourceId.toLowerCase().includes('/locations/')) {
    return undefined;
  }
  const match = LOCATION_PATTERN.exec(resourceId);
  if (!match) {
    throw new InputValidationError(
      'Invalid location in dataStoreId or searchEngineId.',
    );
  }
  return normalizeLocation(match[1], 'resource location');
}

function resolveLocation(resourceId: string, location?: string): string {
  const inferredLocation = extractResourceLocation(resourceId);

  if (location !== undefined) {
    const normalizedLocation = normalizeLocation(location, 'location');
    if (inferredLocation && normalizedLocation !== inferredLocation) {
      throw new InputValidationError(
        'location must match the location in dataStoreId or searchEngineId.',
      );
    }
    return normalizedLocation;
  }

  return inferredLocation ?? GLOBAL_LOCATION;
}

function validateResourcePath(resourceId: string, fieldName: string): void {
  if (!resourceId || resourceId.trim() !== resourceId) {
    throw new InputValidationError(
      `${fieldName} must be a non-empty resource path without leading or trailing whitespace.`,
    );
  }
  const segments = resourceId.split('/');
  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      !SAFE_RESOURCE_SEGMENT_PATTERN.test(segment)
    ) {
      throw new InputValidationError(`Invalid resource path in ${fieldName}.`);
    }
  }
}

function normalizeDataStoreSpecs(
  specs: DiscoveryEngineDataStoreSpec[],
): NormalizedDataStoreSpec[] {
  return specs.map((spec) => {
    const dataStore = spec.dataStore ?? spec.data_store;
    if (typeof dataStore !== 'string' || !dataStore) {
      throw new InputValidationError(
        'Each entry in dataStoreSpecs must specify a non-empty dataStore.',
      );
    }
    validateResourcePath(dataStore, 'dataStoreSpecs[].dataStore');
    if (spec.filter !== undefined) {
      return {dataStore, filter: spec.filter};
    }
    return {dataStore};
  });
}

function getApiBaseUrl(location: string): string {
  if (location === GLOBAL_LOCATION) {
    return `https://${DEFAULT_ENDPOINT}`;
  }
  return `https://${location}-${DEFAULT_ENDPOINT}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Default REST client for the Google Cloud Discovery Engine v1beta Search API.
 */
export class DiscoveryEngineRestClient implements DiscoveryEngineSearchClient {
  readonly baseUrl: string;
  private readonly auth: GoogleAuth;

  constructor(options: DiscoveryEngineRestClientOptions) {
    const normalizedLocation = normalizeLocation(options.location, 'location');
    this.baseUrl = getApiBaseUrl(normalizedLocation);
    const scopes = options.googleAuthOptions?.scopes ?? [CLOUD_PLATFORM_SCOPE];
    this.auth = new GoogleAuth({
      ...options.googleAuthOptions,
      scopes,
    });
  }

  async search(
    request: DiscoveryEngineSearchApiRequest,
  ): Promise<DiscoveryEngineSearchApiResponse> {
    validateResourcePath(request.servingConfig, 'servingConfig');
    const url = `${this.baseUrl}/v1beta/${request.servingConfig}:search`;
    const parsedUrl = new URL(url);
    if (parsedUrl.origin !== this.baseUrl) {
      throw new InputValidationError(
        'Resolved Discovery Engine request URL origin does not match expected endpoint.',
      );
    }

    const authClient = await this.auth.getClient();
    const rawHeaders = await authClient.getRequestHeaders(url);
    const headers = new Headers(
      rawHeaders as ConstructorParameters<typeof Headers>[0],
    );
    headers.set('Content-Type', 'application/json');
    if (authClient.quotaProjectId && !headers.has('x-goog-user-project')) {
      headers.set('x-goog-user-project', authClient.quotaProjectId);
    }

    const body: Record<string, unknown> = {
      query: request.query,
      contentSearchSpec: request.contentSearchSpec,
    };
    if (request.dataStoreSpecs) {
      body.dataStoreSpecs = request.dataStoreSpecs;
    }
    if (request.filter) {
      body.filter = request.filter;
    }
    if (request.pageSize !== undefined) {
      body.pageSize = request.pageSize;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let detail = errorText;
      try {
        const parsed = JSON.parse(errorText) as unknown;
        if (
          isPlainRecord(parsed) &&
          isPlainRecord(parsed.error) &&
          typeof parsed.error.message === 'string'
        ) {
          detail = parsed.error.message;
        }
      } catch {
        // Keep raw response text when body is not JSON.
      }
      throw new ToolExecutionError(
        `Discovery Engine search failed (${response.status}): ${detail}`,
        String(response.status),
      );
    }

    return (await response.json()) as DiscoveryEngineSearchApiResponse;
  }
}

/**
 * Type guard to check whether an object is a {@link DiscoveryEngineSearchTool}.
 */
export function isDiscoveryEngineSearchTool(
  obj: unknown,
): obj is DiscoveryEngineSearchTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    DISCOVERY_ENGINE_SEARCH_TOOL_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[
      DISCOVERY_ENGINE_SEARCH_TOOL_SIGNATURE_SYMBOL
    ] === true
  );
}

/**
 * Function tool for searching Vertex AI Search via the Discovery Engine API.
 *
 * Unlike `VertexAiSearchTool` (which attaches Gemini built-in retrieval
 * grounding configuration), `DiscoveryEngineSearchTool` executes searches as a
 * standard {@link FunctionTool}, so it can be combined freely with other custom
 * tools and used across any model provider.
 */
export class DiscoveryEngineSearchTool extends FunctionTool<DiscoveryEngineSearchSchema> {
  readonly [DISCOVERY_ENGINE_SEARCH_TOOL_SIGNATURE_SYMBOL] = true;

  readonly servingConfig: string;
  readonly resolvedLocation: string;
  private readonly dataStoreSpecs?: NormalizedDataStoreSpec[];
  private readonly filter?: string;
  private readonly maxResults?: number;
  private searchResultMode?: SearchResultMode;
  private modeProbePromise?: Promise<{
    result?: DiscoveryEngineSearchResponse;
    error?: unknown;
  }>;
  private readonly client: DiscoveryEngineSearchClient;

  constructor(params: DiscoveryEngineSearchToolParams) {
    const {
      dataStoreId,
      dataStoreSpecs,
      searchEngineId,
      filter,
      maxResults,
      searchResultMode,
      location,
      name,
      description,
      googleAuthOptions,
      client,
    } = params ?? ({} as DiscoveryEngineSearchToolParams);

    if (
      (dataStoreId === undefined && searchEngineId === undefined) ||
      (dataStoreId !== undefined && searchEngineId !== undefined)
    ) {
      throw new InputValidationError(
        'Either dataStoreId or searchEngineId must be specified.',
      );
    }

    if (dataStoreSpecs !== undefined && searchEngineId === undefined) {
      throw new InputValidationError(
        'searchEngineId must be specified if dataStoreSpecs is specified.',
      );
    }

    if (
      maxResults !== undefined &&
      (!Number.isInteger(maxResults) || maxResults <= 0)
    ) {
      throw new InputValidationError(
        'maxResults must be a positive integer if specified.',
      );
    }

    const resourceId = (dataStoreId ?? searchEngineId)!;
    const resolvedLocation = resolveLocation(resourceId, location);
    validateResourcePath(
      resourceId,
      dataStoreId !== undefined ? 'dataStoreId' : 'searchEngineId',
    );
    const normalizedSpecs = dataStoreSpecs
      ? normalizeDataStoreSpecs(dataStoreSpecs)
      : undefined;

    const resolvedClient =
      client ??
      new DiscoveryEngineRestClient({
        location: resolvedLocation,
        googleAuthOptions,
      });

    super({
      name: name || DEFAULT_TOOL_NAME,
      description: description || DEFAULT_TOOL_DESCRIPTION,
      parameters: DISCOVERY_ENGINE_SEARCH_PARAMETERS,
      execute: async ({query}) => this.discoveryEngineSearch(query),
    });

    this.servingConfig = `${resourceId}/servingConfigs/default_config`;
    this.resolvedLocation = resolvedLocation;
    this.dataStoreSpecs = normalizedSpecs;
    this.filter = filter;
    this.maxResults = maxResults;
    this.searchResultMode = searchResultMode;
    this.client = resolvedClient;
  }

  /**
   * Returns the current search result mode (`undefined` while in auto-detect
   * mode prior to the first resolved search).
   */
  get currentSearchResultMode(): SearchResultMode | undefined {
    return this.searchResultMode;
  }

  /**
   * Searches through Vertex AI Search's Discovery Engine Search API.
   *
   * @param query The search query.
   * @returns Status and normalized list of `{title, url, content}` results.
   */
  async discoveryEngineSearch(
    query: string,
  ): Promise<DiscoveryEngineSearchResponse> {
    try {
      const mode = this.searchResultMode;
      if (mode !== undefined) {
        return await this.doSearch(query, mode);
      }

      // Auto-detect is per datastore, not per query. Keep the initial CHUNKS
      // probe single-flight so concurrent cold calls do not all spend a CHUNKS
      // request before learning the same DOCUMENTS fallback.
      if (!this.modeProbePromise) {
        const probe = (async (): Promise<{
          result?: DiscoveryEngineSearchResponse;
          error?: unknown;
        }> => {
          try {
            const result = await this.doSearch(query, SearchResultMode.CHUNKS);
            this.searchResultMode = SearchResultMode.CHUNKS;
            return {result};
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (STRUCTURED_STORE_ERROR_PATTERN.test(message)) {
              logger.info(
                'CHUNKS mode failed for structured datastore, retrying with DOCUMENTS mode.',
              );
              this.searchResultMode = SearchResultMode.DOCUMENTS;
              return {};
            }
            return {error};
          } finally {
            this.modeProbePromise = undefined;
          }
        })();

        this.modeProbePromise = probe;
        const probeOutcome = await probe;
        if (probeOutcome.result) {
          return probeOutcome.result;
        }
        if (probeOutcome.error !== undefined) {
          throw probeOutcome.error;
        }
        return await this.doSearch(query, this.searchResultMode!);
      }

      await this.modeProbePromise;
      const resolvedMode = this.searchResultMode;
      if (resolvedMode !== undefined) {
        return await this.doSearch(query, resolvedMode);
      }
      // If the prior probe failed with a non-mode error (e.g. transient error),
      // let this caller attempt normally.
      return await this.discoveryEngineSearch(query);
    } catch (error: unknown) {
      return {
        status: 'error',
        error_message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Telemetry helper returning `'TOOL_ERROR'` when the tool response indicates
   * an error.
   */
  _detectErrorInResponse(response: unknown): string | undefined {
    if (isPlainRecord(response) && response.status === 'error') {
      return 'TOOL_ERROR';
    }
    return undefined;
  }

  private async doSearch(
    query: string,
    mode: SearchResultMode,
  ): Promise<DiscoveryEngineSearchResponse> {
    const contentSearchSpec = this.buildContentSearchSpec(mode);
    const request: DiscoveryEngineSearchApiRequest = {
      servingConfig: this.servingConfig,
      query,
      contentSearchSpec,
    };

    if (this.dataStoreSpecs) {
      request.dataStoreSpecs = this.dataStoreSpecs;
    }
    if (this.filter) {
      request.filter = this.filter;
    }
    if (this.maxResults !== undefined) {
      request.pageSize = this.maxResults;
    }

    const response = await this.client.search(request);
    const results: DiscoveryEngineSearchResultItem[] = [];
    for (const item of response.results ?? []) {
      if (mode === SearchResultMode.DOCUMENTS) {
        if (!item.document) {
          continue;
        }
        results.push(this.parseDocumentResult(item.document));
      } else {
        if (!item.chunk) {
          continue;
        }
        results.push(this.parseChunkResult(item.chunk));
      }
    }

    return {status: 'success', results};
  }

  private buildContentSearchSpec(
    mode: SearchResultMode,
  ): DiscoveryEngineContentSearchSpec {
    if (mode === SearchResultMode.DOCUMENTS) {
      return {
        searchResultMode: SearchResultMode.DOCUMENTS,
      };
    }
    return {
      searchResultMode: SearchResultMode.CHUNKS,
      chunkSpec: {
        numPreviousChunks: 0,
        numNextChunks: 0,
      },
    };
  }

  private parseChunkResult(
    chunk: DiscoveryEngineChunk,
  ): DiscoveryEngineSearchResultItem {
    let title = '';
    let uri = '';
    const docMetadata = chunk.documentMetadata ?? chunk.document_metadata;
    if (docMetadata) {
      title = docMetadata.title ?? '';
      uri = docMetadata.uri ?? '';
      const structData = docMetadata.structData ?? docMetadata.struct_data;
      if (isPlainRecord(structData) && 'uri' in structData) {
        uri = structData.uri != null ? String(structData.uri) : '';
      }
    }
    return {
      title,
      url: uri,
      content: chunk.content ?? '',
    };
  }

  private parseDocumentResult(
    doc: DiscoveryEngineDocument,
  ): DiscoveryEngineSearchResultItem {
    let title = '';
    let uri = '';
    let content = '';

    const rawStructData = doc.structData ?? doc.struct_data;
    const rawDerivedStructData =
      doc.derivedStructData ?? doc.derived_struct_data;

    if (isPlainRecord(rawStructData) && Object.keys(rawStructData).length > 0) {
      const data: Record<string, unknown> = {...rawStructData};
      if ('title' in data) {
        title = data.title != null ? String(data.title) : '';
        delete data.title;
      }
      const hasUri = 'uri' in data;
      const rawUri = data.uri;
      const hasLink = 'link' in data;
      const rawLink = data.link;
      delete data.uri;
      delete data.link;
      if (hasUri) {
        uri = rawUri != null ? String(rawUri) : '';
      } else if (hasLink) {
        uri = rawLink != null ? String(rawLink) : '';
      }
      content = JSON.stringify(data);
    } else if (
      isPlainRecord(rawDerivedStructData) &&
      Object.keys(rawDerivedStructData).length > 0
    ) {
      title =
        rawDerivedStructData.title != null
          ? String(rawDerivedStructData.title)
          : '';
      uri =
        rawDerivedStructData.link != null
          ? String(rawDerivedStructData.link)
          : '';

      const snippets = rawDerivedStructData.snippets;
      if (Array.isArray(snippets) && snippets.length > 0) {
        const snippetTexts: string[] = [];
        for (const s of snippets) {
          if (isPlainRecord(s) && s.snippet) {
            snippetTexts.push(String(s.snippet));
          } else {
            snippetTexts.push(typeof s === 'string' ? s : JSON.stringify(s));
          }
        }
        content = snippetTexts.join('\n');
      }

      const extractiveAnswers =
        rawDerivedStructData.extractiveAnswers ??
        rawDerivedStructData.extractive_answers;
      if (
        !content &&
        Array.isArray(extractiveAnswers) &&
        extractiveAnswers.length > 0
      ) {
        content = extractiveAnswers
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join('\n');
      }
    }

    return {
      title,
      url: uri,
      content,
    };
  }
}
