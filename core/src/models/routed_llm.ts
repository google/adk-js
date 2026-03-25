/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/**
 * Type definition for a function that selects a model based on the request.
 */
export type LlmSelector = (
  models: ReadonlyMap<string, BaseLlm>,
  request: LlmRequest,
) => Promise<string> | string;

/**
 * A BaseLlm implementation that delegates to one of multiple models based on a selector function.
 */
export class RoutedLlm extends BaseLlm {
  private readonly models: Map<string, BaseLlm>;
  private readonly selector: LlmSelector;

  constructor({
    models,
    selector,
    modelName = 'routed-llm',
  }: {
    models: Map<string, BaseLlm> | BaseLlm[];
    selector: LlmSelector;
    modelName?: string;
  }) {
    super({model: modelName});
    if (Array.isArray(models)) {
      this.models = new Map(models.map((m) => [m.model, m]));
    } else {
      this.models = models;
    }
    this.selector = selector;
  }

  /**
   * Generates content by delegating to the selected model.
   */
  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    const selectedKey = await this.selector(this.models, llmRequest);
    const selectedModel = this.models.get(selectedKey);
    if (!selectedModel) {
      throw new Error(`Model not found for key: ${selectedKey}`);
    }
    yield* selectedModel.generateContentAsync(llmRequest, stream);
  }

  /**
   * Connects to the LLM by delegating to the selected model.
   */
  async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    const selectedKey = await this.selector(this.models, llmRequest);
    const selectedModel = this.models.get(selectedKey);
    if (!selectedModel) {
      throw new Error(`Model not found for key: ${selectedKey}`);
    }
    return selectedModel.connect(llmRequest);
  }
}
