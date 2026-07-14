/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Blob,
  createPartFromText,
  FileData,
  GoogleGenAI,
  HttpOptions,
  LiveServerMessage,
} from '@google/genai';

import {getBooleanEnvVar, isBrowser} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';

import {AsyncQueue} from '../utils/async_queue.js';
import {StreamingResponseAggregator} from '../utils/streaming_utils.js';
import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {GeminiLlmConnection} from './gemini_llm_connection.js';
import {generateContentViaInteractions} from './interactions_utils.js';
import {LlmRequest} from './llm_request.js';
import {createLlmResponse, LlmResponse} from './llm_response.js';

/**
 * The parameters for creating a Gemini instance.
 */
export interface GeminiParams {
  /**
   * The name of the model to use. Defaults to 'gemini-2.5-flash'.
   */
  model?: string;
  /**
   * The API key to use for the Gemini API. If not provided, it will look for
   * the GOOGLE_GENAI_API_KEY or GEMINI_API_KEY environment variable.
   */
  apiKey?: string;
  /**
   * Whether to use Vertex AI. If true, `project`, `location`
   * should be provided.
   */
  vertexai?: boolean;
  /**
   * The Vertex AI project ID. Required if `vertexai` is true.
   */
  project?: string;
  /**
   * The Vertex AI location. Required if `vertexai` is true.
   */
  location?: string;
  /**
   * Headers to merge with internally crafted headers.
   */
  headers?: Record<string, string>;
  /**
   * Whether to use the Interactions API for stateful conversations.
   */
  useInteractionsApi?: boolean;
}

const GEMINI_MODEL_SYMBOL = Symbol.for('google.adk.geminiModel');

/**
 * Type guard to check if an object is an instance of Gemini.
 * @param obj The object to check.
 * @returns True if the object is an instance of Gemini, false otherwise.
 */
export function isGemini(obj: unknown): obj is Gemini {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    GEMINI_MODEL_SYMBOL in obj &&
    obj[GEMINI_MODEL_SYMBOL] === true
  );
}

/**
 * Integration for Gemini models.
 */
export class Gemini extends BaseLlm {
  readonly [GEMINI_MODEL_SYMBOL] = true;
  private readonly apiKey?: string;
  protected readonly vertexai: boolean;
  private readonly project?: string;
  private readonly location?: string;
  private readonly headers?: Record<string, string>;
  readonly useInteractionsApi: boolean;

  /**
   * @param params The parameters for creating a Gemini instance.
   */
  constructor({
    model,
    apiKey,
    vertexai,
    project,
    location,
    headers,
    useInteractionsApi,
  }: GeminiParams) {
    if (!model) {
      model = 'gemini-2.5-flash';
    }

    super({model});

    const params = geminiInitParams({
      model,
      vertexai,
      project,
      location,
      apiKey,
    });
    if (!params.vertexai && !params.apiKey) {
      throw new Error(
        'API key must be provided via constructor or GOOGLE_GENAI_API_KEY or GEMINI_API_KEY environment variable.',
      );
    }
    this.project = params.project;
    this.location = params.location;
    this.apiKey = params.apiKey;
    this.headers = headers;
    this.vertexai = !!params.vertexai;
    this.useInteractionsApi = !!useInteractionsApi;
  }

  /**
   * A list of model name patterns that are supported by this LLM.
   *
   * @returns A list of supported models.
   */
  static override readonly supportedModels: Array<string | RegExp> = [
    /gemini-.*/,
    // fine-tuned vertex endpoint pattern
    /projects\/.+\/locations\/.+\/endpoints\/.+/,
    // vertex gemini long name
    /projects\/.+\/locations\/.+\/publishers\/google\/models\/gemini.+/,
  ];

  private _apiClient?: GoogleGenAI;
  private _apiBackend?: GoogleLLMVariant;
  private _trackingHeaders?: Record<string, string>;
  private _liveApiVersion?: string;
  private _liveApiClient?: GoogleGenAI;

  /**
   * Sends a request to the Gemini model.
   *
   * @param llmRequest LlmRequest, the request to send to the Gemini model.
   * @param stream bool = false, whether to do streaming call.
   * @yields LlmResponse: The model response.
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    if (this.useInteractionsApi) {
      yield* generateContentViaInteractions(this.apiClient, llmRequest, stream);
      return;
    }
    this.preprocessRequest(llmRequest);
    this.maybeAppendUserContent(llmRequest);
    logger.info(
      `Sending out request, model: ${llmRequest.model ?? this.model}, backend: ${this.apiBackend}, stream: ${stream}`,
    );

    if (!llmRequest.config) {
      llmRequest.config = {};
    }

    if (llmRequest.config.httpOptions) {
      llmRequest.config.httpOptions.headers = {
        ...llmRequest.config.httpOptions.headers,
        ...this.trackingHeaders,
      };
    }

    if (abortSignal) {
      llmRequest.config.abortSignal = abortSignal;
    }

    if (stream) {
      const streamResult = await this.apiClient.models.generateContentStream({
        model: llmRequest.model ?? this.model,
        contents: llmRequest.contents,
        config: llmRequest.config,
      });

      const aggregator = new StreamingResponseAggregator();
      for await (const response of streamResult) {
        for await (const llmResponse of aggregator.processResponse(response)) {
          yield llmResponse;
        }
      }
      const finalResponse = aggregator.close();
      if (finalResponse) {
        yield finalResponse;
      }
    } else {
      const response = await this.apiClient.models.generateContent({
        model: llmRequest.model ?? this.model,
        contents: llmRequest.contents,
        config: llmRequest.config,
      });
      yield createLlmResponse(response);
    }
  }

  protected getHttpOptions(): HttpOptions {
    return {headers: {...this.trackingHeaders, ...this.headers}};
  }

  get apiClient(): GoogleGenAI {
    if (this._apiClient) {
      return this._apiClient;
    }

    if (this.vertexai) {
      this._apiClient = new GoogleGenAI({
        vertexai: this.vertexai,
        project: this.project,
        location: this.location,
        httpOptions: this.getHttpOptions(),
      });
    } else {
      this._apiClient = new GoogleGenAI({
        apiKey: this.apiKey,
        httpOptions: this.getHttpOptions(),
      });
    }
    return this._apiClient;
  }

  get apiBackend(): GoogleLLMVariant {
    if (!this._apiBackend) {
      this._apiBackend = this.apiClient.vertexai
        ? GoogleLLMVariant.VERTEX_AI
        : GoogleLLMVariant.GEMINI_API;
    }
    return this._apiBackend;
  }

  get liveApiVersion(): string {
    if (!this._liveApiVersion) {
      this._liveApiVersion =
        this.apiBackend === GoogleLLMVariant.VERTEX_AI ? 'v1beta1' : 'v1alpha';
    }
    return this._liveApiVersion;
  }

  protected getLiveHttpOptions(): HttpOptions {
    return {
      headers: this.trackingHeaders,
      apiVersion: this.liveApiVersion,
    };
  }

  get liveApiClient(): GoogleGenAI {
    if (!this._liveApiClient) {
      if (this.vertexai) {
        this._liveApiClient = new GoogleGenAI({
          vertexai: this.vertexai,
          project: this.project,
          location: this.location || 'global',
          httpOptions: this.getLiveHttpOptions(),
        });
      } else {
        this._liveApiClient = new GoogleGenAI({
          apiKey: this.apiKey,
          httpOptions: this.getLiveHttpOptions(),
        });
      }
    }
    return this._liveApiClient;
  }

  /**
   * Connects to the Gemini model and returns an llm connection.
   *
   * @param llmRequest LlmRequest, the request to send to the Gemini model.
   * @returns BaseLlmConnection, the connection to the Gemini model.
   */
  override async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    // add tracking headers to custom headers and set api_version given
    // the customized http options will override the one set in the api client
    // constructor
    if (llmRequest.liveConnectConfig?.httpOptions) {
      if (!llmRequest.liveConnectConfig.httpOptions.headers) {
        llmRequest.liveConnectConfig.httpOptions.headers = {};
      }
      Object.assign(
        llmRequest.liveConnectConfig.httpOptions.headers,
        this.trackingHeaders,
      );
      llmRequest.liveConnectConfig.httpOptions.apiVersion = this.liveApiVersion;
    }

    if (llmRequest.config?.systemInstruction) {
      llmRequest.liveConnectConfig.systemInstruction = {
        role: 'system',
        // TODO - b/425992518: validate type casting works well.
        parts: [
          createPartFromText(llmRequest.config.systemInstruction as string),
        ],
      };
    }

    llmRequest.liveConnectConfig.tools = llmRequest.config?.tools;

    const modelVersion = llmRequest.model ?? this.model;
    const messageQueue = new AsyncQueue<LiveServerMessage>();

    const liveSession = await this.liveApiClient.live.connect({
      model: modelVersion,
      config: llmRequest.liveConnectConfig,
      callbacks: {
        onmessage: (message) => {
          messageQueue.push(message);
        },
        onerror: (error) => {
          messageQueue.error(error);
        },
        onclose: () => {
          messageQueue.close();
        },
      },
    });
    return new GeminiLlmConnection(liveSession, modelVersion, messageQueue);
  }

  private preprocessRequest(llmRequest: LlmRequest): void {
    if (this.apiBackend === GoogleLLMVariant.GEMINI_API) {
      if (llmRequest.config) {
        // Using API key from Google AI Studio to call model doesn't support
        // labels.
        (llmRequest.config as {labels?: unknown}).labels = undefined;
      }
      if (llmRequest.contents) {
        for (const content of llmRequest.contents) {
          if (!content.parts) continue;
          for (const part of content.parts) {
            removeDisplayNameIfPresent(part.inlineData);
            removeDisplayNameIfPresent(part.fileData);
          }
        }
      }
    }
  }
}

function removeDisplayNameIfPresent(
  dataObj: Blob | FileData | undefined,
): void {
  // display_name is not supported for Gemini API (non-vertex)
  if (dataObj && (dataObj as FileData).displayName) {
    (dataObj as FileData).displayName = undefined;
  }
}

export function geminiInitParams({
  model,
  vertexai,
  project,
  location,
  apiKey,
}: GeminiParams) {
  const params: GeminiParams = {model, vertexai, project, location, apiKey};

  params.vertexai = !!vertexai;
  if (!params.vertexai && !isBrowser()) {
    params.vertexai = getBooleanEnvVar('GOOGLE_GENAI_USE_VERTEXAI');
  }

  if (params.vertexai) {
    if (!isBrowser() && !params.project) {
      params.project = process.env['GOOGLE_CLOUD_PROJECT'];
    }
    if (!isBrowser() && !params.location) {
      params.location = process.env['GOOGLE_CLOUD_LOCATION'];
    }
    if (!params.project) {
      throw new Error(
        'VertexAI project must be provided via constructor or GOOGLE_CLOUD_PROJECT environment variable.',
      );
    }
    if (!params.location) {
      throw new Error(
        'VertexAI location must be provided via constructor or GOOGLE_CLOUD_LOCATION environment variable.',
      );
    }
  } else {
    if (!params.apiKey && !isBrowser()) {
      params.apiKey =
        process.env['GOOGLE_GENAI_API_KEY'] || process.env['GEMINI_API_KEY'];
    }
  }
  return params;
}
