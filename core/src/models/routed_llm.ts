/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

import {runWithRouting} from '../utils/failover_utils.js';
import {logger} from '../utils/logger.js';

/**
 * Type definition for a function that selects a model based on the request.
 */
export type LlmRouter = (
  models: Readonly<Record<string, BaseLlm>>,
  request: LlmRequest,
  errorContext?: {failedKeys: ReadonlySet<string>; lastError: unknown},
) => Promise<string | undefined> | string | undefined;

/**
 * A BaseLlm implementation that delegates to one of multiple models based on a router function.
 */
export class RoutedLlm extends BaseLlm {
  private readonly models: Readonly<Record<string, BaseLlm>>;
  private readonly router: LlmRouter;

  constructor({
    models,
    router,
    modelName = 'routed-llm',
  }: {
    models: Readonly<Record<string, BaseLlm>> | BaseLlm[];
    router: LlmRouter;
    modelName?: string;
  }) {
    const modelsMap = Array.isArray(models)
      ? Object.fromEntries(models.map((m) => [m.model, m]))
      : models;

    const modelNames = Object.entries(modelsMap).map(
      ([name, model]) => `${name} (${model.model})`,
    );
    const computedName = `RoutedLlm[${modelNames.join(', ')}]`;

    super({model: modelName === 'routed-llm' ? computedName : modelName});
    this.models = modelsMap;
    this.router = router;
  }

  /**
   * Generates content by delegating to the selected model.
   */
  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    logger.info(`Routing request via ${this.model}`);
    yield* runWithRouting(this.models, llmRequest, this.router, (model) =>
      model.generateContentAsync(llmRequest, stream),
    );
  }

  /**
   * Creates a live connection to the LLM by delegating to the selected model.
   * This live connection cannot be switched mid-stream, it is tied to the model
   * selected at the time of connection.
   */
  async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    const generator = runWithRouting(
      this.models,
      llmRequest,
      this.router,
      (model) => model.connect(llmRequest),
    );
    const result = await generator.next();
    if (result.done || result.value === undefined) {
      throw new Error('Failed to establish connection: No connection yielded.');
    }
    return result.value;
  }
}
