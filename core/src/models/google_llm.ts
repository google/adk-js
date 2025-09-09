/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob, createPartFromText, FileData, FinishReason, FunctionDeclaration, GenerateContentConfig, GenerateContentResponse, GoogleGenAI, Part} from '@google/genai';

import {deepClone} from '../utils/deep_clone.js';
import {isBrowser} from '../utils/env_aware_utils.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';
import {version} from '../version.js';

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {GeminiLlmConnection} from './gemini_llm_connection.js';
import {LlmRequest} from './llm_request.js';
import {createLlmResponse, LlmResponse} from './llm_response.js';

const AGENT_ENGINE_TELEMETRY_TAG = 'remote_reasoning_engine';
const AGENT_ENGINE_TELEMETRY_ENV_VARIABLE_NAME = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';

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
}

/**
 * Integration for Gemini models.
 */
export class Gemini extends BaseLlm {
  private readonly apiKey?: string;

  /**
   * @param params The parameters for creating a Gemini instance.
   */
  constructor({model = 'gemini-2.5-flash', apiKey}: GeminiParams = {}) {
    super(model);

    if (!apiKey && typeof process === 'object') {
      apiKey =
          process.env['GOOGLE_GENAI_API_KEY'] || process.env['GEMINI_API_KEY'];
    }
    this.apiKey = apiKey;

    if (!this.apiKey) {
      throw new Error(
          'API key is not set. Please set it in the constructor or as GOOGLE_GENAI_API_KEY or GEMINI_API_KEY environment variable.');
    }
  }

  /**
   * A list of model name patterns that are supported by this LLM.
   *
   * @returns A list of supported models.
   */
  static override readonly supportedModels: Array<string|RegExp> = [
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
  override async *
      generateContent(
          llmRequest: LlmRequest,
          stream = false,
          ): AsyncGenerator<LlmResponse, void> {
    this.preprocessRequest(llmRequest);
    this.maybeAppendUserContent(llmRequest);
    console.info(
        `Sending out request, model: ${llmRequest.model}, backend: ${
            this.apiBackend}, stream: ${stream}`,
    );
    console.info(buildRequestLog(llmRequest));

    if (llmRequest.config?.httpOptions) {
      llmRequest.config.httpOptions.headers = {
        ...llmRequest.config.httpOptions.headers,
        ...this.trackingHeaders,
      };
    }

    if (stream) {
      const streamResult = await this.apiClient.models.generateContentStream({
        model: llmRequest.model ?? this.model,
        contents: llmRequest.contents,
        config: llmRequest.config,
      });
      let thoughtText = '';
      let text = '';
      let usageMetadata;
      let lastResponse: GenerateContentResponse|undefined;

      // TODO - b/425992518: verify the type of streaming response is correct.
      for await (const response of streamResult) {
        lastResponse = response;
        console.info(buildResponseLog(response));
        const llmResponse = createLlmResponse(response);
        usageMetadata = llmResponse.usageMetadata;
        const firstPart = llmResponse.content?.parts?.[0];
        // Accumulates the text and thought text from the first part.
        if (firstPart?.text) {
          if ('thought' in firstPart && firstPart.thought) {
            thoughtText += firstPart.text;
          } else {
            text += firstPart.text;
          }
          llmResponse.partial = true;
        } else if (
            (thoughtText || text) && (!firstPart || !firstPart.inlineData)) {
          // Flushes the data if there's no more text.
          const parts: Part[] = [];
          if (thoughtText) {
            parts.push({text: thoughtText, thought: true});
          }
          if (text) {
            parts.push(createPartFromText(text));
          }
          yield {
            content: {
              role: 'model',
              parts,
            },
            usageMetadata: llmResponse.usageMetadata,
          };
          thoughtText = '';
          text = '';
        }
        yield llmResponse;
      }
      if ((text || thoughtText) &&
          lastResponse?.candidates?.[0]?.finishReason === FinishReason.STOP) {
        const parts: Part[] = [];
        if (thoughtText) {
          parts.push({text: thoughtText, thought: true} as Part);
        }
        if (text) {
          parts.push({text: text});
        }
        yield {
          content: {
            role: 'model',
            parts,
          },
          usageMetadata,
        };
      }
    } else {
      const response = await this.apiClient.models.generateContent({
        model: llmRequest.model ?? this.model,
        contents: llmRequest.contents,
        config: llmRequest.config,
      });
      console.info(buildResponseLog(response));
      yield createLlmResponse(response);
    }
  }

  get apiClient(): GoogleGenAI {
    if (!this._apiClient) {
      this._apiClient = new GoogleGenAI({
        apiKey: this.apiKey,
        httpOptions: {headers: this.trackingHeaders},
      });
    }
    return this._apiClient;
  }

  get apiBackend(): GoogleLLMVariant {
    if (!this._apiBackend) {
      this._apiBackend = this.apiClient.vertexai ? GoogleLLMVariant.VERTEX_AI :
                                                   GoogleLLMVariant.GEMINI_API;
    }
    return this._apiBackend;
  }

  get trackingHeaders(): Record<string, string> {
    if (!this._trackingHeaders) {
      let frameworkLabel = `google-adk/${version}`;
      if (!isBrowser() &&
          process.env[AGENT_ENGINE_TELEMETRY_ENV_VARIABLE_NAME]) {
        frameworkLabel = `${frameworkLabel}+${AGENT_ENGINE_TELEMETRY_TAG}`;
      }
      // TODO - b/425992518: this is node version, not js, verify.
      // TODO - b/425992518: For browser case we should extract the browser
      // name and version from userAgent string.
      const languageLabel = `gl-typescript/${
          isBrowser() ? window.navigator.userAgent : process.version}`;
      const versionHeaderValue = `${frameworkLabel} ${languageLabel}`;
      this._trackingHeaders = {
        'x-goog-api-client': versionHeaderValue,
        'user-agent': versionHeaderValue,
      };
    }
    return this._trackingHeaders;
  }

  get liveApiVersion(): string {
    if (!this._liveApiVersion) {
      this._liveApiVersion = this.apiBackend === GoogleLLMVariant.VERTEX_AI ?
          'v1beta1' :
          'v1alpha';
    }
    return this._liveApiVersion;
  }

  get liveApiClient(): GoogleGenAI {
    if (!this._liveApiClient) {
      this._liveApiClient = new GoogleGenAI({
        apiKey: this.apiKey,
        httpOptions: {
          headers: this.trackingHeaders,
          apiVersion: this.liveApiVersion,
        },
      });
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
        parts:
            [createPartFromText(llmRequest.config.systemInstruction as string)],
      };
    }

    llmRequest.liveConnectConfig.tools = llmRequest.config?.tools;

    const liveSession = await this.liveApiClient.live.connect({
      model: llmRequest.model ?? this.model,
      config: llmRequest.liveConnectConfig,
      callbacks: {
        // TODO - b/425992518: GenAI SDK inconsistent API, missing methods.
        onmessage: () => {},
      },
    });
    return new GeminiLlmConnection(liveSession);
  }

  private preprocessRequest(llmRequest: LlmRequest): void {
    if (this.apiBackend === GoogleLLMVariant.GEMINI_API) {
      if (llmRequest.config) {
        // Using API key from Google AI Studio to call model doesn't support
        // labels.
        (llmRequest.config as any).labels = undefined;
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

function buildFunctionDeclarationLog(funcDecl: FunctionDeclaration): string {
  const params = funcDecl.parameters?.properties ?
      JSON.stringify(
          Object.fromEntries(
              Object.entries(funcDecl.parameters.properties)
                  .map(([k, v]) => [k, v]),
              ),
          ) :
      '{}';
  const response =
      funcDecl.response ? '-> ' + JSON.stringify(funcDecl.response) : '';
  return `${funcDecl.name}: ${params} ${response}`;
}

function buildRequestLog(req: LlmRequest): string {
  const firstTool = req.config?.tools?.[0];
  const functionDecls = (firstTool as any)?.functionDeclarations ?? [];
  const functionLogs = functionDecls.map(buildFunctionDeclarationLog);

  const contentsLogs = req.contents.map((content) => {
    const modifiedContent = deepClone(content);
    if (modifiedContent && modifiedContent.parts) {
      for (const part of modifiedContent.parts) {
        if (part.inlineData?.data) {
          delete part.inlineData.data;
        }
      }
    }
    return JSON.stringify(modifiedContent);
  });

  return `
LLM Request:
-----------------------------------------------------------
System Instruction:
${req.config?.systemInstruction}
-----------------------------------------------------------
Contents:
${contentsLogs.join('\n')}
-----------------------------------------------------------
Functions:
${functionLogs.join('\n')}
-----------------------------------------------------------
`;
}

function buildResponseLog(resp: GenerateContentResponse): string {
  const functionCallsText = [];
  if (resp.functionCalls) {
    for (const funcCall of resp.functionCalls) {
      functionCallsText.push(
          `name: ${funcCall.name}, args: ${JSON.stringify(funcCall.args)}`);
    }
  }

  return `
LLM Response:
-----------------------------------------------------------
Text:
${resp.text}
-----------------------------------------------------------
Function calls:
${functionCallsText.join('\n')}
-----------------------------------------------------------
Raw response:
${JSON.stringify(resp)}
-----------------------------------------------------------
`;
}


function removeDisplayNameIfPresent(
    dataObj: Blob|FileData|undefined,
    ): void {
  // display_name is not supported for Gemini API (non-vertex)
  if (dataObj && (dataObj as FileData).displayName) {
    (dataObj as FileData).displayName = undefined;
  }
}
