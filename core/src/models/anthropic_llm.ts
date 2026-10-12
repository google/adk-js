/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  createPartFromFunctionCall,
  createPartFromText,
  FinishReason,
  FunctionDeclaration,
  Part,
  Schema,
} from '@google/genai';

import {logger} from '../utils/logger.js';

import {BaseLlm} from './base_llm.js';
import type {BaseLlmConnection} from './base_llm_connection.js';
import type {LlmRequest} from './llm_request.js';
import type {LlmResponse} from './llm_response.js';

/**
 * Default maximum number of output tokens requested for {@link Claude} completions.
 */
export const MAX_TOKEN = 1024;

const DEFAULT_CLAUDE_MODEL = 'claude-3-5-sonnet-v2@20241022';
const ANTHROPIC_VERTEX_MODULE = '@anthropic-ai/vertex-sdk';
const CLAUDE_MODEL_SYMBOL = Symbol.for('google.adk.claudeModel');

/**
 * Role accepted by Anthropic conversation messages.
 */
export type ClaudeRole = 'user' | 'assistant';

/**
 * Text content block parameter for an {@link AnthropicMessageParam}.
 */
export interface AnthropicTextBlockParam {
  type: 'text';
  text: string;
}

/**
 * Source payload for an {@link AnthropicImageBlockParam}.
 */
export interface AnthropicImageBlockSource {
  type: 'base64' | 'url';
  media_type?: string;
  data?: string;
  url?: string;
}

/**
 * Image content block parameter for an {@link AnthropicMessageParam}.
 */
export interface AnthropicImageBlockParam {
  type: 'image';
  source: AnthropicImageBlockSource;
}

/**
 * Tool invocation block parameter for an {@link AnthropicMessageParam}.
 */
export interface AnthropicToolUseBlockParam {
  id: string;
  name: string;
  input: unknown;
  type: 'tool_use';
}

/**
 * Tool execution result block parameter for an {@link AnthropicMessageParam}.
 */
export interface AnthropicToolResultBlockParam {
  tool_use_id: string;
  type: 'tool_result';
  content: string;
  is_error: boolean;
}

/**
 * Union of content block parameters supported in an {@link AnthropicMessageParam}.
 */
export type AnthropicMessageBlockParam =
  | AnthropicTextBlockParam
  | AnthropicImageBlockParam
  | AnthropicToolUseBlockParam
  | AnthropicToolResultBlockParam;

/**
 * Single message turn sent to the Anthropic messages endpoint.
 */
export interface AnthropicMessageParam {
  role: ClaudeRole;
  content: AnthropicMessageBlockParam[];
}

/**
 * JSON Schema definition describing the input object of an {@link AnthropicToolParam}.
 */
export interface AnthropicInputSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

/**
 * Tool definition sent to the Anthropic messages endpoint.
 */
export interface AnthropicToolParam {
  name: string;
  description: string;
  input_schema: AnthropicInputSchema;
}

/**
 * Automatic tool-selection configuration for an Anthropic message request.
 */
export interface AnthropicToolChoiceAutoParam {
  type: 'auto';
  disable_parallel_tool_use?: boolean;
}

/**
 * Text block returned in an {@link AnthropicMessage} response.
 */
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

/**
 * Tool-use block returned in an {@link AnthropicMessage} response.
 */
export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

/**
 * Reasoning block returned in an {@link AnthropicMessage} response.
 */
export interface AnthropicThinkingBlock {
  type: 'thinking' | 'redacted_thinking';
  thinking?: string;
  data?: string;
  signature?: string;
}

/**
 * Content block returned in an {@link AnthropicMessage} response.
 */
export type AnthropicContentBlock =
  AnthropicTextBlock | AnthropicToolUseBlock | AnthropicThinkingBlock;

/**
 * Token usage statistics returned in an {@link AnthropicMessage} response.
 */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * Response message returned by the Anthropic messages endpoint.
 */
export interface AnthropicMessage {
  id?: string;
  type?: 'message';
  role?: 'assistant';
  content: AnthropicContentBlock[];
  model?: string;
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: AnthropicUsage;
}

/**
 * Request parameters passed to {@link AnthropicVertexClient} `messages.create`.
 */
export interface AnthropicMessageCreateParams {
  model: string;
  system?: string;
  messages: AnthropicMessageParam[];
  tools?: AnthropicToolParam[];
  tool_choice?: AnthropicToolChoiceAutoParam;
  max_tokens: number;
}

/**
 * Request options passed to {@link AnthropicVertexClient} `messages.create`.
 */
export interface AnthropicRequestOptions {
  signal?: AbortSignal;
}

/**
 * Structural interface for the `@anthropic-ai/vertex-sdk` client used by {@link Claude}.
 */
export interface AnthropicVertexClient {
  messages: {
    create(
      params: AnthropicMessageCreateParams,
      options?: AnthropicRequestOptions,
    ): Promise<AnthropicMessage> | AnthropicMessage;
  };
}

/**
 * Request payload containing the system instruction, messages, and tools for {@link Claude}.
 */
export interface ClaudeRequest {
  systemInstruction: string;
  messages: Iterable<AnthropicMessageParam>;
  tools: AnthropicToolParam[];
}

/**
 * Parameters for creating a {@link Claude} model instance.
 */
export interface ClaudeParams {
  /**
   * The name of the Claude model. Defaults to `'claude-3-5-sonnet-v2@20241022'`.
   */
  model?: string;
  /**
   * The Google Cloud project ID for Vertex AI. Defaults to `GOOGLE_CLOUD_PROJECT`.
   */
  project?: string;
  /**
   * The Google Cloud location for Vertex AI. Defaults to `GOOGLE_CLOUD_LOCATION`.
   */
  location?: string;
  /**
   * An optional pre-configured {@link AnthropicVertexClient} instance.
   */
  client?: AnthropicVertexClient;
}

interface AnthropicVertexModule {
  AnthropicVertex: new (options: {
    projectId: string;
    region: string;
  }) => AnthropicVertexClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTruthyFunctionResult(result: unknown): boolean {
  if (!result) {
    return false;
  }
  if (Array.isArray(result)) {
    return result.length > 0;
  }
  if (isRecord(result)) {
    return Object.keys(result).length > 0;
  }
  return true;
}

function formatFunctionResponseResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (typeof result === 'object' && result !== null) {
    return JSON.stringify(result);
  }
  return String(result);
}

function serializeSchemaProperty(schema: Schema): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (value !== undefined && value !== null) {
      result[key] =
        key === 'type' && typeof value === 'string'
          ? value.toLowerCase()
          : value;
    }
  }
  return result;
}

function systemInstructionToString(
  systemInstruction: unknown,
): string | undefined {
  if (systemInstruction === undefined || systemInstruction === null) {
    return undefined;
  }
  if (typeof systemInstruction === 'string') {
    return systemInstruction;
  }
  if (Array.isArray(systemInstruction)) {
    return systemInstruction
      .map((entry) =>
        typeof entry === 'string'
          ? entry
          : isRecord(entry) && typeof entry['text'] === 'string'
            ? entry['text']
            : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  if (
    isRecord(systemInstruction) &&
    Array.isArray(systemInstruction['parts'])
  ) {
    return systemInstruction['parts']
      .map((part) =>
        isRecord(part) && typeof part['text'] === 'string' ? part['text'] : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  if (
    isRecord(systemInstruction) &&
    typeof systemInstruction['text'] === 'string'
  ) {
    return systemInstruction['text'];
  }
  return String(systemInstruction);
}

async function importOptional<T>(specifier: string): Promise<T> {
  try {
    // Dynamic import with a non-literal specifier resolves to an untyped module
    // namespace at the optional peer SDK boundary.
    return (await import(specifier)) as T;
  } catch (cause) {
    throw new Error(
      `Claude needs the optional package '${specifier}', which is not installed. Install '${ANTHROPIC_VERTEX_MODULE}', or pass a pre-configured client to Claude.`,
      {cause},
    );
  }
}

/**
 * Type guard to check if an object is an instance of {@link Claude}.
 *
 * @param obj The object to check.
 * @returns True if the object is an instance of {@link Claude}, false otherwise.
 */
export function isClaude(obj: unknown): obj is Claude {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    CLAUDE_MODEL_SYMBOL in obj &&
    obj[CLAUDE_MODEL_SYMBOL] === true
  );
}

/**
 * Maps a content role string to the corresponding {@link ClaudeRole}.
 *
 * @param role The role from a `Content` object.
 * @returns `'assistant'` for `'model'` or `'assistant'`, and `'user'` otherwise.
 */
export function toClaudeRole(role?: string | null): ClaudeRole {
  if (role === 'model' || role === 'assistant') {
    return 'assistant';
  }
  return 'user';
}

/**
 * Converts an Anthropic stop reason to a `@google/genai` `FinishReason`.
 *
 * @param anthropicStopReason The stop reason reported by Anthropic.
 * @returns The mapped `FinishReason`.
 */
export function toGoogleGenaiFinishReason(
  anthropicStopReason?: string | null,
): FinishReason {
  if (
    anthropicStopReason === 'end_turn' ||
    anthropicStopReason === 'stop_sequence' ||
    anthropicStopReason === 'tool_use'
  ) {
    return FinishReason.STOP;
  }
  if (anthropicStopReason === 'max_tokens') {
    return FinishReason.MAX_TOKENS;
  }
  return FinishReason.FINISH_REASON_UNSPECIFIED;
}

/**
 * Converts a `@google/genai` `Part` into an {@link AnthropicMessageBlockParam}.
 *
 * @param part The content part to convert.
 * @returns The corresponding Anthropic message block parameter.
 */
export function partToMessageBlock(part: Part): AnthropicMessageBlockParam {
  if (part.text) {
    return {
      text: part.text,
      type: 'text',
    };
  }
  if (part.functionCall) {
    if (!part.functionCall.name) {
      throw new Error('Function call must have a name.');
    }
    return {
      id: part.functionCall.id ?? '',
      name: part.functionCall.name,
      input: part.functionCall.args,
      type: 'tool_use',
    };
  }
  if (part.functionResponse) {
    let content = '';
    const response = part.functionResponse.response;
    if (
      response &&
      'result' in response &&
      isTruthyFunctionResult(response['result'])
    ) {
      content = formatFunctionResponseResult(response['result']);
    }
    return {
      tool_use_id: part.functionResponse.id ?? '',
      type: 'tool_result',
      content,
      is_error: false,
    };
  }
  throw new Error('Not supported yet.');
}

/**
 * Converts a `@google/genai` `Content` object into an {@link AnthropicMessageParam}.
 *
 * @param content The content object to convert.
 * @returns The corresponding Anthropic message parameter.
 */
export function contentToMessageParam(content: Content): AnthropicMessageParam {
  return {
    role: toClaudeRole(content.role),
    content: (content.parts ?? []).map((part) => partToMessageBlock(part)),
  };
}

/**
 * Converts an {@link AnthropicContentBlock} into a `@google/genai` `Part`.
 *
 * @param contentBlock The Anthropic content block to convert.
 * @returns The converted `Part`.
 */
export function contentBlockToPart(contentBlock: AnthropicContentBlock): Part {
  if (contentBlock.type === 'text') {
    return createPartFromText(contentBlock.text);
  }
  if (contentBlock.type === 'tool_use') {
    if (!isRecord(contentBlock.input)) {
      throw new Error('Tool use block input must be an object.');
    }
    const part = createPartFromFunctionCall(
      contentBlock.name,
      contentBlock.input,
    );
    if (part.functionCall) {
      part.functionCall.id = contentBlock.id;
    }
    return part;
  }
  throw new Error('Not supported yet.');
}

/**
 * Converts an {@link AnthropicMessage} into an {@link LlmResponse}.
 *
 * @param message The Anthropic response message to convert.
 * @returns The converted {@link LlmResponse}.
 */
export function messageToGenerateContentResponse(
  message: AnthropicMessage,
): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: message.content.map((cb) => contentBlockToPart(cb)),
    },
  };
}

/**
 * Converts a `@google/genai` `FunctionDeclaration` into an {@link AnthropicToolParam}.
 *
 * @param functionDeclaration The function declaration to convert.
 * @returns The corresponding Anthropic tool parameter.
 */
export function functionDeclarationToToolParam(
  functionDeclaration: FunctionDeclaration,
): AnthropicToolParam {
  if (!functionDeclaration.name) {
    throw new Error('Function declaration must have a name.');
  }

  const properties: Record<string, Record<string, unknown>> = {};
  if (functionDeclaration.parameters?.properties) {
    for (const [key, value] of Object.entries(
      functionDeclaration.parameters.properties,
    )) {
      properties[key] = serializeSchemaProperty(value);
    }
  }

  return {
    name: functionDeclaration.name,
    description: functionDeclaration.description ?? '',
    input_schema: {
      type: 'object',
      properties,
    },
  };
}

/**
 * Integration for Anthropic Claude models on Vertex AI.
 */
export class Claude extends BaseLlm {
  readonly [CLAUDE_MODEL_SYMBOL] = true;
  private readonly project?: string;
  private readonly location?: string;
  private anthropicClient?: AnthropicVertexClient;

  /**
   * Creates an instance of {@link Claude}.
   *
   * @param params Optional parameters for configuring the Claude model and Vertex AI client.
   */
  constructor({
    model = DEFAULT_CLAUDE_MODEL,
    project,
    location,
    client,
  }: ClaudeParams = {}) {
    super({model});
    this.project = project;
    this.location = location;
    this.anthropicClient = client;
  }

  /**
   * List of model name patterns supported by {@link Claude} for {@link LLMRegistry}.
   */
  static override readonly supportedModels: Array<string | RegExp> = [
    /claude-3-.*/,
  ];

  /**
   * Generates a response from the Claude model on Vertex AI.
   *
   * @param llmRequest The request to send to the model.
   * @param _stream Whether to stream the response.
   * @param abortSignal Optional abort signal.
   * @yields The {@link LlmResponse} converted from the Anthropic message.
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    abortSignal?.throwIfAborted();
    const messages = (llmRequest.contents ?? []).map((content) =>
      contentToMessageParam(content),
    );

    const firstTool = llmRequest.config?.tools?.[0];
    const functionDeclarations =
      firstTool && 'functionDeclarations' in firstTool
        ? firstTool.functionDeclarations
        : undefined;
    const tools =
      functionDeclarations && functionDeclarations.length > 0
        ? functionDeclarations.map((tool) =>
            functionDeclarationToToolParam(tool),
          )
        : undefined;

    const hasToolsDict = Object.keys(llmRequest.toolsDict ?? {}).length > 0;
    const toolChoice: AnthropicToolChoiceAutoParam | undefined = hasToolsDict
      ? {
          type: 'auto',
          disable_parallel_tool_use: true,
        }
      : undefined;

    const client = await this.getAnthropicClient();
    abortSignal?.throwIfAborted();
    const createParams: AnthropicMessageCreateParams = {
      model: llmRequest.model ?? this.model,
      system: systemInstructionToString(llmRequest.config?.systemInstruction),
      messages,
      tools,
      tool_choice: toolChoice,
      max_tokens: MAX_TOKEN,
    };
    const message = abortSignal
      ? await client.messages.create(createParams, {signal: abortSignal})
      : await client.messages.create(createParams);
    logger.debug(`Claude response: ${JSON.stringify(message, null, 2)}`);
    yield messageToGenerateContentResponse(message);
  }

  /**
   * Live connections are not supported for {@link Claude} models.
   *
   * @param _llmRequest The request to send to the model.
   * @returns Rejects with an unsupported error.
   */
  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(`Live connection is not supported for ${this.model}.`);
  }

  private async getAnthropicClient(): Promise<AnthropicVertexClient> {
    if (this.anthropicClient) {
      return this.anthropicClient;
    }

    const projectId = this.project ?? process.env['GOOGLE_CLOUD_PROJECT'];
    const region = this.location ?? process.env['GOOGLE_CLOUD_LOCATION'];
    if (!projectId || !region) {
      throw new Error(
        'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set for using Anthropic on Vertex.',
      );
    }

    const {AnthropicVertex} = await importOptional<AnthropicVertexModule>(
      ANTHROPIC_VERTEX_MODULE,
    );
    this.anthropicClient = new AnthropicVertex({
      projectId,
      region,
    });
    return this.anthropicClient;
  }
}
