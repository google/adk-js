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
 * Applies Google Maps grounding to the LLM request if supported.
 */
export function applyGoogleMapsGrounding(llmRequest: LlmRequest): void {
  if (!llmRequest.model) {
    return;
  }

  const modelCheckDisabled = isGeminiModelIdCheckDisabled();
  llmRequest.config = llmRequest.config || ({} as GenerateContentConfig);
  llmRequest.config.tools = llmRequest.config.tools || [];

  if (isGemini1Model(llmRequest.model)) {
    throw new Error(
      'Google Maps grounding tool cannot be used with Gemini 1.x models.',
    );
  }

  if (isGeminiModel(llmRequest.model) || modelCheckDisabled) {
    llmRequest.config.tools.push({
      googleMaps: {},
    });

    return;
  }

  throw new Error(
    `Google maps tool is not supported for model ${llmRequest.model}`,
  );
}

/**
 * A built-in tool that is automatically invoked by Gemini 2 models to ground
 * query results with Google Maps.
 *
 * This tool operates internally within the model and does not require or
 * perform local code execution.
 */
export class GoogleMapsGroundingTool extends BaseTool {
  constructor() {
    super({name: 'google_maps', description: 'Google Maps Grounding Tool'});
  }

  runAsync(): Promise<unknown> {
    // This is a built-in tool on server side, it's triggered by setting the
    // corresponding request parameters.
    return Promise.resolve();
  }

  override async processLlmRequest({
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    applyGoogleMapsGrounding(llmRequest);
  }
}

/**
 * A global instance of {@link GoogleMapsGroundingTool}.
 */
export const GOOGLE_MAPS_GROUNDING = new GoogleMapsGroundingTool();
