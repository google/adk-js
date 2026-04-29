/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {ContentsOptions, Exa} from 'exa-js';

import {getLogger} from '../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

const logger = getLogger();

/**
 * Search types supported by the Exa /search endpoint.
 *
 * - `auto` (default): Exa picks between neural and keyword retrieval.
 * - `fast`: Lower-latency retrieval optimized for agent loops.
 * - `neural`: Embedding-based semantic search.
 * - `hybrid`: Combined neural and keyword retrieval.
 * - `instant`: Returns cached results with minimal latency.
 */
export type ExaSearchType = 'auto' | 'fast' | 'neural' | 'hybrid' | 'instant';

/**
 * Categories supported by the Exa /search endpoint for topical filtering.
 */
export type ExaCategory =
  | 'company'
  | 'research paper'
  | 'news'
  | 'pdf'
  | 'personal site'
  | 'financial report'
  | 'people';

/**
 * Contents options that control what is returned per result.
 *
 * Multiple fields can be set simultaneously. Defaults to
 * `{highlights: true}` when no contents options are provided, which keeps
 * tool responses compact while still giving the model usable snippets.
 */
export interface ExaContentsOptions {
  text?: boolean;
  highlights?: boolean;
  summary?: boolean;
}

/**
 * Constructor parameters for {@link ExaSearchTool}.
 */
export interface ExaSearchToolParams {
  /**
   * Exa API key. If omitted, the value of the `EXA_API_KEY` environment
   * variable is used. The tool throws at call time if neither source is
   * populated.
   */
  apiKey?: string;

  /**
   * Default search type used when the model does not provide one.
   * Defaults to `auto`.
   */
  type?: ExaSearchType;

  /**
   * Default number of results returned when the model does not provide one.
   * Defaults to 5. Clamped to the Exa API range of 1-100.
   */
  numResults?: number;

  /**
   * Default category used when the model does not provide one.
   */
  category?: ExaCategory;

  /**
   * Default contents options used when the model does not provide them.
   * Defaults to `{highlights: true}`.
   */
  contents?: ExaContentsOptions;
}

/**
 * Schema describing the arguments the model can pass to the Exa search tool.
 * Kept narrower than the full Exa API surface to keep tool calls predictable.
 */
export interface ExaSearchToolArgs {
  query: string;
  type?: ExaSearchType;
  numResults?: number;
  category?: ExaCategory;
  includeDomains?: string[];
  excludeDomains?: string[];
  includeText?: string[];
  excludeText?: string[];
  startPublishedDate?: string;
  endPublishedDate?: string;
  contents?: ExaContentsOptions;
}

/**
 * A single result returned by {@link ExaSearchTool.runAsync}.
 */
export interface ExaSearchToolResult {
  title: string;
  url: string;
  id: string;
  publishedDate?: string;
  author?: string;
  score?: number;
  snippet: string;
  text?: string;
  highlights?: string[];
  summary?: string;
}

/**
 * Tool response shape returned by {@link ExaSearchTool.runAsync}.
 */
export interface ExaSearchToolResponse {
  results: ExaSearchToolResult[];
}

const INTEGRATION_HEADER = 'x-exa-integration';
const INTEGRATION_NAME = 'adk-js';
const DEFAULT_NUM_RESULTS = 5;
const DEFAULT_TYPE: ExaSearchType = 'auto';
const DEFAULT_CONTENTS: ExaContentsOptions = {highlights: true};

/**
 * A tool that performs web search through the
 * {@link https://exa.ai | Exa} AI search API.
 *
 * Unlike {@link './google_search_tool.js'.GoogleSearchTool} or
 * {@link './vertex_ai_search_tool.js'.VertexAiSearchTool}, this tool runs on
 * the client side: each call hits the Exa REST API and returns structured
 * results that the model can read directly. It works with any LLM that
 * supports function calling.
 *
 * @example
 * ```ts
 * import {LlmAgent, ExaSearchTool} from '@google/adk';
 *
 * const agent = new LlmAgent({
 *   name: 'researcher',
 *   model: 'gemini-2.5-flash',
 *   instruction: 'Use exa_search to find recent web sources before answering.',
 *   tools: [new ExaSearchTool()],
 * });
 * ```
 *
 * Authentication: set the `EXA_API_KEY` environment variable, or pass an
 * `apiKey` to the constructor.
 */
export class ExaSearchTool extends BaseTool {
  private readonly apiKey?: string;
  private readonly defaultType: ExaSearchType;
  private readonly defaultNumResults: number;
  private readonly defaultCategory?: ExaCategory;
  private readonly defaultContents: ExaContentsOptions;
  private client?: Exa;

  constructor(params: ExaSearchToolParams = {}) {
    super({
      name: 'exa_search',
      description:
        'Search the web with the Exa AI search API. Returns a list of ' +
        'results with title, url, and content snippets (highlights, text, ' +
        'or summary). Useful for retrieving up-to-date information from ' +
        'the open web.',
    });
    this.apiKey = params.apiKey;
    this.defaultType = params.type ?? DEFAULT_TYPE;
    this.defaultNumResults = clampNumResults(
      params.numResults ?? DEFAULT_NUM_RESULTS,
    );
    this.defaultCategory = params.category;
    this.defaultContents = params.contents ?? DEFAULT_CONTENTS;
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: 'The natural-language search query.',
          },
          type: {
            type: Type.STRING,
            description:
              'Search type. One of: auto, fast, neural, hybrid, instant. ' +
              'Defaults to the value configured on the tool.',
            enum: ['auto', 'fast', 'neural', 'hybrid', 'instant'],
          },
          numResults: {
            type: Type.INTEGER,
            description:
              'Number of results to return (1-100). Defaults to the value ' +
              'configured on the tool.',
          },
          category: {
            type: Type.STRING,
            description:
              'Restrict results to a single category, e.g. news, ' +
              'research paper, company, financial report.',
            enum: [
              'company',
              'research paper',
              'news',
              'pdf',
              'personal site',
              'financial report',
              'people',
            ],
          },
          includeDomains: {
            type: Type.ARRAY,
            description:
              'Only return results from these domains (e.g. ["nytimes.com"]).',
            items: {type: Type.STRING},
          },
          excludeDomains: {
            type: Type.ARRAY,
            description: 'Drop results from these domains.',
            items: {type: Type.STRING},
          },
          includeText: {
            type: Type.ARRAY,
            description:
              'Only return results whose page contains these strings.',
            items: {type: Type.STRING},
          },
          excludeText: {
            type: Type.ARRAY,
            description: 'Drop results whose page contains these strings.',
            items: {type: Type.STRING},
          },
          startPublishedDate: {
            type: Type.STRING,
            description:
              'Only return results published on or after this ISO 8601 date.',
          },
          endPublishedDate: {
            type: Type.STRING,
            description:
              'Only return results published on or before this ISO 8601 date.',
          },
        },
        required: ['query'],
      },
    };
  }

  override async runAsync({
    args,
  }: RunAsyncToolRequest): Promise<ExaSearchToolResponse> {
    const typedArgs = args as unknown as ExaSearchToolArgs;
    if (!typedArgs.query || typeof typedArgs.query !== 'string') {
      throw new Error('exa_search requires a non-empty `query` string.');
    }

    const client = this.getClient();
    const contents = typedArgs.contents ?? this.defaultContents;
    const numResults = clampNumResults(
      typedArgs.numResults ?? this.defaultNumResults,
    );
    const type = typedArgs.type ?? this.defaultType;
    const category = typedArgs.category ?? this.defaultCategory;

    logger.debug(
      `Running Exa search: query="${typedArgs.query}", type=${type}, ` +
        `numResults=${numResults}, category=${category ?? 'none'}`,
    );

    const response = await client.search(typedArgs.query, {
      type,
      numResults,
      contents: toSdkContents(contents),
      ...(category ? {category} : {}),
      ...(typedArgs.includeDomains
        ? {includeDomains: typedArgs.includeDomains}
        : {}),
      ...(typedArgs.excludeDomains
        ? {excludeDomains: typedArgs.excludeDomains}
        : {}),
      ...(typedArgs.includeText ? {includeText: typedArgs.includeText} : {}),
      ...(typedArgs.excludeText ? {excludeText: typedArgs.excludeText} : {}),
      ...(typedArgs.startPublishedDate
        ? {startPublishedDate: typedArgs.startPublishedDate}
        : {}),
      ...(typedArgs.endPublishedDate
        ? {endPublishedDate: typedArgs.endPublishedDate}
        : {}),
    });

    return {
      results: (response.results ?? []).map(formatResult),
    };
  }

  private getClient(): Exa {
    if (this.client) {
      return this.client;
    }
    const key = this.apiKey ?? process.env['EXA_API_KEY'];
    if (!key) {
      throw new Error(
        'Exa API key is not configured. Set the EXA_API_KEY environment ' +
          'variable or pass `apiKey` to ExaSearchTool.',
      );
    }
    const client = new Exa(key);
    // Tag every request so Exa can attribute usage to this integration.
    const headers = (
      client as unknown as {
        headers?: {set?: (key: string, value: string) => void};
      }
    ).headers;
    if (headers && typeof headers.set === 'function') {
      headers.set(INTEGRATION_HEADER, INTEGRATION_NAME);
    }
    this.client = client;
    return client;
  }
}

function toSdkContents(opts: ExaContentsOptions): ContentsOptions {
  const out: ContentsOptions = {};
  if (opts.text === true) out.text = true;
  if (opts.highlights === true) out.highlights = true;
  if (opts.summary === true) out.summary = true;
  return out;
}

function clampNumResults(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_NUM_RESULTS;
  }
  const rounded = Math.floor(value);
  if (rounded < 1) return 1;
  if (rounded > 100) return 100;
  return rounded;
}

function formatResult(result: Record<string, unknown>): ExaSearchToolResult {
  const text =
    typeof result['text'] === 'string' ? (result['text'] as string) : undefined;
  const highlights = Array.isArray(result['highlights'])
    ? (result['highlights'] as unknown[]).filter(
        (h): h is string => typeof h === 'string',
      )
    : undefined;
  const summary =
    typeof result['summary'] === 'string'
      ? (result['summary'] as string)
      : undefined;
  return {
    title:
      typeof result['title'] === 'string' ? (result['title'] as string) : '',
    url: typeof result['url'] === 'string' ? (result['url'] as string) : '',
    id: typeof result['id'] === 'string' ? (result['id'] as string) : '',
    ...(typeof result['publishedDate'] === 'string'
      ? {publishedDate: result['publishedDate'] as string}
      : {}),
    ...(typeof result['author'] === 'string'
      ? {author: result['author'] as string}
      : {}),
    ...(typeof result['score'] === 'number'
      ? {score: result['score'] as number}
      : {}),
    snippet: pickSnippet({highlights, summary, text}),
    ...(text ? {text} : {}),
    ...(highlights && highlights.length > 0 ? {highlights} : {}),
    ...(summary ? {summary} : {}),
  };
}

function pickSnippet(parts: {
  highlights?: string[];
  summary?: string;
  text?: string;
}): string {
  if (parts.highlights && parts.highlights.length > 0) {
    return parts.highlights.join(' ').trim();
  }
  if (parts.summary) {
    return parts.summary.trim();
  }
  if (parts.text) {
    return parts.text.slice(0, 500).trim();
  }
  return '';
}
