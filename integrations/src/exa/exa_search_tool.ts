/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool, getLogger, type RunAsyncToolRequest} from '@google/adk';
import {type FunctionDeclaration, Type} from '@google/genai';

const logger = getLogger();

const SEARCH_TYPES = [
  'auto',
  'lite',
  'deep-lite',
  'deep',
  'instant',
  'fast',
  'deep-reasoning',
] as const;

/** Search types supported by the Exa Search API. */
export type ExaSearchType = (typeof SEARCH_TYPES)[number];

const CATEGORIES = [
  'company',
  'publication',
  'news',
  'personal site',
  'financial report',
  'people',
] as const;

/** Categories exposed by the Exa search tool. */
export type ExaCategory = (typeof CATEGORIES)[number];

/**
 * Contents options that control what is returned per result.
 *
 * Defaults to `{highlights: true}`. Choose one content view per request.
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
  /** Exa API key. Defaults to the EXA_API_KEY environment variable. */
  apiKey?: string;

  /**
   * Default search type used when the model does not provide one.
   * Defaults to `auto`.
   */
  type?: ExaSearchType;

  /**
   * Default number of results returned when the model does not provide one.
   * Defaults to 5. Clamped to the tool range of 1–10.
   */
  numResults?: number;

  /**
   * Default category used when the model does not provide one.
   */
  category?: ExaCategory;

  /**
   * Developer-configured contents options.
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
  startPublishedDate?: string;
  endPublishedDate?: string;
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
export type ExaSearchToolResponse =
  {results: ExaSearchToolResult[]} | {error: string};

const SEARCH_URL = 'https://api.exa.ai/search';
const DEFAULT_NUM_RESULTS = 5;
const MAX_RESULTS = 10;
const MAX_TEXT_CHARS = 1000;
const MAX_SNIPPET_CHARS = 500;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A server-side web search tool for LLMs that support function calling.
 * Search results contain untrusted web content.
 *
 * @example
 * ```ts
 * import {LlmAgent} from '@google/adk';
 * import {ExaSearchTool} from '@google/adk-integrations';
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
    this.defaultType = params.type ?? 'auto';
    this.defaultNumResults = clampNumResults(
      params.numResults ?? DEFAULT_NUM_RESULTS,
    );
    this.defaultCategory = params.category;
    this.defaultContents = {...(params.contents ?? {highlights: true})};
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
              'Use auto for general search, lite for low latency, or deep-lite ' +
              'and deep for research. Prefer these over legacy modes.',
            enum: [...SEARCH_TYPES],
          },
          numResults: {
            type: Type.INTEGER,
            description:
              'Number of results to return (1–10). Defaults to the value ' +
              'configured on the tool.',
          },
          category: {
            type: Type.STRING,
            description:
              'Restrict results to a category. Company and people do not ' +
              'support published-date filters. People also disallows excludeDomains.',
            enum: [...CATEGORIES],
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
    args: rawArgs,
    toolContext,
  }: RunAsyncToolRequest): Promise<ExaSearchToolResponse> {
    const args = rawArgs as Partial<ExaSearchToolArgs>;
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return {error: 'exa_search requires a non-empty query string.'};
    }

    const type = args.type ?? this.defaultType;
    const category = args.category ?? this.defaultCategory;
    if (
      !SEARCH_TYPES.includes(type) ||
      (category !== undefined && !CATEGORIES.includes(category))
    ) {
      return {error: 'Unsupported Exa search type or category.'};
    }
    if (
      (category === 'company' || category === 'people') &&
      (args.startPublishedDate !== undefined ||
        args.endPublishedDate !== undefined)
    ) {
      return {
        error: 'Company and people searches do not support date filters.',
      };
    }
    if (category === 'people' && args.excludeDomains !== undefined) {
      return {error: 'People searches do not support excludeDomains.'};
    }
    if (type === 'lite' && this.defaultContents.summary) {
      return {
        error: 'Lite search does not support summaries. Use auto instead.',
      };
    }

    const callerSignal = toolContext.abortSignal;
    if (callerSignal?.aborted) {
      return {error: 'Exa search was cancelled.'};
    }
    const apiKey = (this.apiKey ?? process.env['EXA_API_KEY'])?.trim();
    if (!apiKey) {
      return {error: 'Set EXA_API_KEY or pass apiKey to ExaSearchTool.'};
    }

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeout])
      : timeout;
    const limit = clampNumResults(args.numResults ?? this.defaultNumResults);
    try {
      const response = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'x-exa-integration': 'adk-js',
        },
        redirect: 'error',
        signal,
        body: JSON.stringify({
          query,
          type,
          category,
          numResults: limit,
          includeDomains: args.includeDomains,
          excludeDomains: args.excludeDomains,
          startPublishedDate: args.startPublishedDate,
          endPublishedDate: args.endPublishedDate,
          contents: {
            text: this.defaultContents.text
              ? {maxCharacters: MAX_TEXT_CHARS}
              : false,
            highlights: this.defaultContents.highlights
              ? {maxCharacters: MAX_SNIPPET_CHARS}
              : false,
            ...(this.defaultContents.summary ? {summary: true} : {}),
          },
        }),
      });
      if (!response.ok) {
        logger.debug(`Exa search returned HTTP ${response.status}`);
        await response.body?.cancel();
        return {error: 'Exa search failed.'};
      }
      const payload: unknown = await response.json();
      signal.throwIfAborted();
      if (!isRecord(payload) || !Array.isArray(payload['results'])) {
        logger.debug('Exa search response was missing a results array');
        return {error: 'Exa search failed.'};
      }
      return {
        results: payload['results']
          .slice(0, limit)
          .filter(isRecord)
          .map(formatResult),
      };
    } catch {
      if (timeout.aborted && signal.reason === timeout.reason) {
        logger.debug('Exa search timed out');
        return {error: 'Exa search timed out.'};
      }
      if (callerSignal?.aborted) {
        logger.debug('Exa search was cancelled');
        return {error: 'Exa search was cancelled.'};
      }
      logger.debug('Exa search request or response parsing failed');
      return {error: 'Exa search failed.'};
    }
  }
}

function clampNumResults(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_NUM_RESULTS;
  return Math.min(MAX_RESULTS, Math.max(1, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, limit) : undefined;
}

function formatResult(result: Record<string, unknown>): ExaSearchToolResult {
  const text = boundedString(result['text'], MAX_TEXT_CHARS);
  const summary = boundedString(result['summary'], MAX_SNIPPET_CHARS);
  const rawHighlights = result['highlights'];
  const highlights = Array.isArray(rawHighlights)
    ? rawHighlights
        .slice(0, 3)
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.slice(0, MAX_SNIPPET_CHARS))
    : [];
  const author = boundedString(result['author'], 200);
  const publishedDate = boundedString(result['publishedDate'], 64);
  const score = result['score'];
  // Keep source URLs intact for citations.
  const url =
    typeof result['url'] === 'string' && result['url'].length <= 2048
      ? result['url']
      : '';
  return {
    title: boundedString(result['title'], 300) ?? '',
    url,
    id: boundedString(result['id'], 2048) ?? '',
    ...(publishedDate ? {publishedDate} : {}),
    ...(author ? {author} : {}),
    ...(typeof score === 'number' && Number.isFinite(score) ? {score} : {}),
    snippet: (
      highlights.join(' ').trim() ||
      summary?.trim() ||
      text?.trim() ||
      ''
    ).slice(0, MAX_SNIPPET_CHARS),
    ...(text ? {text} : {}),
    ...(highlights.length ? {highlights} : {}),
    ...(summary ? {summary} : {}),
  };
}
