/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig, Tool} from '@google/genai';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {getLogger} from '../utils/logger.js';
import {
  isGemini1Model,
  isGeminiModel,
  isGeminiModelIdCheckDisabled,
} from '../utils/model_name.js';
import {BaseTool, ToolProcessLlmRequest} from './base_tool.js';

const logger = getLogger();

export interface VertexAISearchDataStoreSpec {
  dataStore?: string;
}

export interface VertexAISearchConfig {
  datastore?: string;
  dataStoreSpecs?: VertexAISearchDataStoreSpec[];
  engine?: string;
  filter?: string;
  maxResults?: number;
}

export interface BaseVertexAiSearchToolParams {
  filter?: string;
  maxResults?: number;
  bypassMultiToolsLimit?: boolean;
}

export interface DataStoreParams extends BaseVertexAiSearchToolParams {
  dataStoreId: string;
  searchEngineId?: never;
  dataStoreSpecs?: never;
}

export interface SearchEngineParams extends BaseVertexAiSearchToolParams {
  searchEngineId: string;
  dataStoreId?: never;
  dataStoreSpecs?: VertexAISearchDataStoreSpec[];
}

export type VertexAiSearchToolParams = DataStoreParams | SearchEngineParams;

/**
 * A built-in tool using Vertex AI Search.
 */
export class VertexAiSearchTool extends BaseTool {
  readonly dataStoreId?: string;
  readonly dataStoreSpecs?: VertexAISearchDataStoreSpec[];
  readonly searchEngineId?: string;
  readonly filter?: string;
  readonly maxResults?: number;
  readonly bypassMultiToolsLimit: boolean;

  constructor(params: VertexAiSearchToolParams) {
    // Name and description are not used because this is a model built-in tool.
    super({name: 'vertex_ai_search', description: 'vertex_ai_search'});

    const {
      dataStoreId,
      dataStoreSpecs,
      searchEngineId,
      filter,
      maxResults,
      bypassMultiToolsLimit = false,
    } = params;

    if (
      (dataStoreId === undefined && searchEngineId === undefined) ||
      (dataStoreId !== undefined && searchEngineId !== undefined)
    ) {
      throw new Error(
        'Either dataStoreId or searchEngineId must be specified.',
      );
    }

    if (dataStoreSpecs !== undefined && searchEngineId === undefined) {
      throw new Error(
        'searchEngineId must be specified if dataStoreSpecs is specified.',
      );
    }

    this.dataStoreId = dataStoreId;
    this.dataStoreSpecs = dataStoreSpecs;
    this.searchEngineId = searchEngineId;
    this.filter = filter;
    this.maxResults = maxResults;
    this.bypassMultiToolsLimit = bypassMultiToolsLimit;
  }

  runAsync(): Promise<unknown> {
    // This is a built-in tool on server side, it's triggered by setting the
    // corresponding request parameters.
    return Promise.resolve();
  }

  /**
   * Builds the VertexAISearch configuration.
   *
   * Override this method in a subclass to dynamically customize the search
   * configuration based on the context (e.g., set filter based on session
   * state).
   */
  protected buildVertexAiSearchConfig(
    _readonlyContext: ReadonlyContext,
  ): VertexAISearchConfig {
    return {
      datastore: this.dataStoreId,
      dataStoreSpecs: this.dataStoreSpecs,
      engine: this.searchEngineId,
      filter: this.filter,
      maxResults: this.maxResults,
    };
  }

  override async processLlmRequest({
    toolContext,
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    if (!llmRequest.model) {
      return;
    }

    const modelCheckDisabled = isGeminiModelIdCheckDisabled();
    llmRequest.config = llmRequest.config || ({} as GenerateContentConfig);
    llmRequest.config.tools = llmRequest.config.tools || [];

    // Guard against unsupported models unless check is disabled.
    if (!isGeminiModel(llmRequest.model) && !modelCheckDisabled) {
      throw new Error(
        `Vertex AI search tool is not supported for model ${llmRequest.model}`,
      );
    }

    // Guard against multi-tool usage in Gemini 1.x unless explicitly bypassed.
    if (
      isGemini1Model(llmRequest.model) &&
      llmRequest.config.tools.length > 0 &&
      !this.bypassMultiToolsLimit
    ) {
      throw new Error(
        'Vertex AI search tool cannot be used with other tools in Gemini 1.x.',
      );
    }

    // Build the search config (can be overridden by subclasses)
    const vertexAiSearchConfig = this.buildVertexAiSearchConfig(toolContext);

    // Format dataStoreSpecs concisely for logging
    let specsInfo: string | undefined;
    if (vertexAiSearchConfig.dataStoreSpecs) {
      const specIds = vertexAiSearchConfig.dataStoreSpecs.map((spec) =>
        spec.dataStore ? spec.dataStore.split('/').pop() : 'unnamed',
      );
      specsInfo = `${vertexAiSearchConfig.dataStoreSpecs.length} spec(s): [${specIds.join(', ')}]`;
    }

    logger.debug(
      `Adding Vertex AI Search tool config to LLM request: ` +
        `datastore=${vertexAiSearchConfig.datastore}, ` +
        `engine=${vertexAiSearchConfig.engine}, ` +
        `filter=${vertexAiSearchConfig.filter}, ` +
        `maxResults=${vertexAiSearchConfig.maxResults}, ` +
        `dataStoreSpecs=${specsInfo}`,
    );

    llmRequest.config.tools.push({
      retrieval: {
        vertexAiSearch: vertexAiSearchConfig,
      },
    } as unknown as Tool);
  }
}
