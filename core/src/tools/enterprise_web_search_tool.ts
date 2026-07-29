/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {GenerateContentConfig} from '@google/genai';

import {LlmRequest} from '../models/llm_request.js';
import {
  isGemini1Model,
  isGeminiModel,
  isGeminiModelIdCheckDisabled,
} from '../utils/model_name.js';

import {BaseTool, ToolProcessLlmRequest} from './base_tool.js';

/**
 * Appends the Enterprise Web Search built-in tool to the LLM request when the
 * target model supports it.
 *
 * NOTE: This is NOT Vertex AI Search (formerly "Enterprise Search"). See
 * https://cloud.google.com/vertex-ai/generative-ai/docs/grounding/web-grounding-enterprise
 */
export function applyEnterpriseWebSearch(llmRequest: LlmRequest): void {
  if (!llmRequest.model) {
    return;
  }

  const modelCheckDisabled = isGeminiModelIdCheckDisabled();
  llmRequest.config = llmRequest.config || ({} as GenerateContentConfig);
  llmRequest.config.tools = llmRequest.config.tools || [];

  if (isGeminiModel(llmRequest.model) || modelCheckDisabled) {
    if (
      isGemini1Model(llmRequest.model) &&
      llmRequest.config.tools.length > 0
    ) {
      throw new Error(
        'Enterprise Web Search tool cannot be used with other tools in Gemini 1.x.',
      );
    }

    llmRequest.config.tools.push({enterpriseWebSearch: {}});

    return;
  }

  throw new Error(
    `Enterprise Web Search tool is not supported for model ${llmRequest.model}`,
  );
}

/**
 * A Gemini 2+ built-in tool that grounds responses on public web data via
 * Vertex AI Search with Enterprise (Sec4) compliance.
 *
 * This tool operates internally within the model and does not require or
 * perform local code execution.
 */
export class EnterpriseWebSearchTool extends BaseTool {
  constructor() {
    super({
      name: 'enterprise_web_search',
      description: 'Enterprise Web Search Tool',
    });
  }

  runAsync(): Promise<unknown> {
    // This is a built-in tool on server side, it's triggered by setting the
    // corresponding request parameters.
    return Promise.resolve();
  }

  override async processLlmRequest({
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    applyEnterpriseWebSearch(llmRequest);
  }
}

/**
 * A global instance of {@link EnterpriseWebSearchTool}.
 */
export const ENTERPRISE_WEB_SEARCH = new EnterpriseWebSearchTool();
