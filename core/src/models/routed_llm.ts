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
export type LlmRouter = (
  models: ReadonlyMap<string, BaseLlm>,
  request: LlmRequest,
  errorContext?: {failedKeys: ReadonlySet<string>; lastError: unknown},
) => Promise<string | undefined> | string | undefined;

/**
 * A BaseLlm implementation that delegates to one of multiple models based on a router function.
 */
export class RoutedLlm extends BaseLlm {
  private readonly models: Map<string, BaseLlm>;
  private readonly router: LlmRouter;

  constructor({
    models,
    router,
    modelName = 'routed-llm',
  }: {
    models: Map<string, BaseLlm> | BaseLlm[];
    router: LlmRouter;
    modelName?: string;
  }) {
    super({model: modelName});
    if (Array.isArray(models)) {
      this.models = new Map(models.map((m) => [m.model, m]));
    } else {
      this.models = models;
    }
    this.router = router;
  }

  /**
   * Generates content by delegating to the selected model.
   */
  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    const initialKey = await this.router(this.models, llmRequest);
    if (!initialKey) {
      throw new Error('Initial routing failed, no model selected.');
    }

    let selectedKey = initialKey;
    let selectedModel = this.models.get(selectedKey);
    if (!selectedModel) {
      throw new Error(`Model not found for key: ${selectedKey}`);
    }

    const triedKeys = new Set<string>([selectedKey]);

    while (true) {
      const iterator = selectedModel.generateContentAsync(llmRequest, stream);
      let firstYielded = false;

      try {
        while (true) {
          const result = await iterator.next();
          if (result.done) break;
          yield result.value;
          firstYielded = true;
        }
        break; // Success!
      } catch (error) {
        if (!firstYielded) {
          const nextKey = await this.router(this.models, llmRequest, {
            failedKeys: triedKeys,
            lastError: error,
          });

          if (!nextKey) {
            throw error; // Router decided to bail out
          }

          if (triedKeys.has(nextKey)) {
            throw error; // Give up to avoid infinite loop
          }

          selectedKey = nextKey;
          selectedModel = this.models.get(selectedKey);
          if (!selectedModel) {
            throw new Error(`Model not found for key: ${selectedKey}`);
          }
          triedKeys.add(selectedKey);
        } else {
          throw error; // Re-throw if data was already yielded
        }
      }
    }
  }

  /**
   * Creates a live connection to the LLM by delegating to the selected model.
   * This live connection cannot be switched mid-stream, it is tied to the model
   * selected at the time of connection.
   */
  async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    const initialKey = await this.router(this.models, llmRequest);
    if (!initialKey) {
      throw new Error('Initial routing failed, no model selected.');
    }

    let selectedKey = initialKey;
    let selectedModel = this.models.get(selectedKey);
    if (!selectedModel) {
      throw new Error(`Model not found for key: ${selectedKey}`);
    }

    const triedKeys = new Set<string>([selectedKey]);

    while (true) {
      try {
        return await selectedModel.connect(llmRequest);
      } catch (error) {
        const nextKey = await this.router(this.models, llmRequest, {
          failedKeys: triedKeys,
          lastError: error,
        });

        if (!nextKey) {
          throw error; // Router decided to bail out
        }

        if (triedKeys.has(nextKey)) {
          throw error; // Give up to avoid infinite loop
        }

        selectedKey = nextKey;
        selectedModel = this.models.get(selectedKey);
        if (!selectedModel) {
          throw new Error(`Model not found for key: ${selectedKey}`);
        }
        triedKeys.add(selectedKey);
      }
    }
  }
}
