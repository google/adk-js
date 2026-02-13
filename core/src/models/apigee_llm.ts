/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {HttpOptions} from '@google/genai';

import {isBrowser} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';

import {BaseLlmConnection} from './base_llm_connection.js';
import {Gemini, geminiInitParams, GeminiParams} from './google_llm.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

const APIGEE_PROXY_URL_ENV_VARIABLE_NAME = 'APIGEE_PROXY_URL';

export interface ApigeeLlmParams extends GeminiParams {
  /**
   * The name of the model to use. The model string specifies the LLM provider
   * (e.g., Vertex AI, Gemini), API version, and the model ID. Supported format:
   *     `apigee/[<provider>/][<version>/]<model_id>`
   *     Components:
   *       `provider` (optional): `vertex_ai` or `gemini`.
   *       `version` (optional): The API version (e.g., `v1`, `v1beta`). If not
   *         provided, a default version will selected based on the provider.
   *       `model_id` (required): The model identifier (e.g.,
   *         `gemini-2.5-flash`).
   *     Examples:
   *       - `apigee/gemini-2.5-flash`
   *       - `apigee/v1/gemini-2.5-flash`
   *       - `apigee/vertex_ai/gemini-2.5-flash`
   *       - `apigee/gemini/v1/gemini-2.5-flash`
   *       - `apigee/vertex_ai/v1beta/gemini-2.5-flash`
   */
  model: string;
  /**
   * The proxy URL for the provider API. If not provided, it will look for
   * the APIGEE_PROXY_URL environment variable.
   */
  proxyUrl?: string;
  /**
   * API key to use. If not provided, it will look for
   * the GOOGLE_GENAI_API_KEY or GEMINI_API_KEY environment variable. If gemini
   * provider is selected and no key is provided, the fake key "-" will be
   * used for the "x-goog-api-key" header.
   */
  apiKey?: string;
}

export class ApigeeLlm extends Gemini {
  private readonly proxyUrl: string;

  /**
   * A list of model name patterns that are supported by this LLM.
   *
   * @returns A list of supported models.
   */
  static override readonly supportedModels: Array<string | RegExp> = [
    /apigee\/.*/,
  ];

  constructor({
    model,
    proxyUrl,
    apiKey,
    vertexai,
    location,
    project,
    headers,
  }: ApigeeLlmParams) {
    if (!validateModel(model)) {
      throw new Error(
        `Model ${
          model
        } is not a valid Apigee model, expected apigee/[<provider>/][<version>/]<model_id>`,
      );
    }

    super({
      ...apigeeToGeminiInitParams({model, vertexai, project, location, apiKey}),
      headers,
    });

    this.proxyUrl = proxyUrl ?? '';
    if (!isBrowser() && !this.proxyUrl) {
      this.proxyUrl = process.env[APIGEE_PROXY_URL_ENV_VARIABLE_NAME] ?? '';
    }
    if (!this.proxyUrl) {
      throw new Error(
        `Proxy URL must be provided via the constructor or ${
          APIGEE_PROXY_URL_ENV_VARIABLE_NAME
        } environment variable.`,
      );
    }
  }

  protected override getHttpOptions(): HttpOptions {
    const opts = super.getHttpOptions();
    opts.baseUrl = this.proxyUrl;
    return opts;
  }

  protected override getLiveHttpOptions(): HttpOptions {
    const opts = super.getLiveHttpOptions();
    opts.baseUrl = this.proxyUrl;
    return opts;
  }

  private identifyApiVersion(): string {
    const modelTrimmed = this.model.startsWith('apigee/')
      ? this.model.substring('apigee/'.length)
      : this.model;
    const components = modelTrimmed.split('/');
    if (components.length === 3) {
      // Format: <provider>/<version>/<model_id>
      return components[1];
    }
    if (components.length === 2) {
      // Format: <version>/<model_id> but not <provider>/<model_id>
      if (
        components[0] != 'vertex_ai' &&
        components[0] != 'gemini' &&
        components[0].startsWith('v')
      ) {
        return components[0];
      }
    }
    // Default to v1beta1 for vertex AI and v1alpha for Gemini.
    return this.vertexai ? 'v1beta1' : 'v1alpha';
  }

  private _apigeeLiveApiVersion?: string;

  override get liveApiVersion(): string {
    if (!this._apigeeLiveApiVersion) {
      this._apigeeLiveApiVersion = this.identifyApiVersion();
    }
    return this._apigeeLiveApiVersion;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
  ): AsyncGenerator<LlmResponse, void> {
    const modelToUse = llmRequest.model ?? this.model;
    llmRequest.model = getModelId(modelToUse);
    yield* super.generateContentAsync(llmRequest, stream);
  }

  override async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    const modelToUse = llmRequest.model ?? this.model;
    llmRequest.model = getModelId(modelToUse);
    return super.connect(llmRequest);
  }
}

function apigeeToGeminiInitParams({
  model,
  vertexai,
  project,
  location,
  apiKey,
}: GeminiParams) {
  const params = geminiInitParams({model, vertexai, project, location, apiKey});
  params.vertexai =
    params.vertexai || params.model?.startsWith('apigee/vertex_ai/');
  if (params.vertexai) {
    return params;
  }
  if (!params.apiKey) {
    logger.warn(
      `No API key provided when using a Gemini model, using a fake key "-".`,
    );
    params.apiKey = '-';
  }
  return params;
}

/**
 * Extracts the model ID from the model string.
 *
 * @param model - The model string (e.g. "apigee/gemini-2.5-flash")
 * @returns The the model id (e.g. "gemini-2.5-flash")
 */
function getModelId(model: string): string {
  if (!validateModel(model)) {
    throw new Error(
      `Model ${
        model
      } is not a valid Apigee model, expected apigee/[<provider>/][<version>/]<model_id>`,
    );
  }
  const components = model.split('/');
  return components[components.length - 1];
}

/**
 * Validates the Apigee model string format.
 *
 * @param model - The model string.
 * @returns True if the model string is valid, false otherwise.
 */
function validateModel(model: string): boolean {
  const validProviders = ['vertex_ai', 'gemini'];
  if (!model.startsWith('apigee/')) {
    return false;
  }
  const modelPart = model.substring('apigee/'.length);
  if (modelPart.length === 0) {
    return false;
  }
  const components = modelPart.split('/', -1);
  if (components[components.length - 1].length === 0) {
    return false;
  }
  // If the model string has exactly 1 component, it means only the model_id
  // is present. This is a valid format (e.g. "apigee/my-model").
  if (components.length == 1) {
    return true;
  }
  if (components.length == 2) {
    // allowed format: apigee/<provider>/<model_id>
    // (e.g. apigee/vertex_ai/my-model)
    if (validProviders.includes(components[0])) {
      return true;
    }
    // allowed format: apigee/<version>/<model_id>
    // (e.g.apigee/v1beta1/my-model)
    return components[0].startsWith('v');
  }
  if (components.length == 3) {
    // allowed format: apigee/<provider>/<version>/<model_id>
    // (e.g. apigee/vertex_ai/v1beta1/my-model)
    if (!validProviders.includes(components[0])) {
      return false;
    }
    return components[1].startsWith('v');
  }
  return false;
}
