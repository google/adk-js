/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  MessageParam,
  RawContentBlockDeltaEvent,
  RawContentBlockStartEvent,
  TextBlockParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  Part,
  Schema,
} from '@google/genai';

import {isBrowser} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/**
 * The parameters for creating an AnthropicLlm instance.
 */
export interface AnthropicLlmParams {
  /**
   * The model name. Defaults to 'claude-sonnet-4-5-20250514'.
   */
  model?: string;
  /**
   * The API key. If not provided, it will look for the ANTHROPIC_API_KEY
   * environment variable.
   */
  apiKey?: string;
  /**
   * The maximum number of tokens to generate. Defaults to 8192.
   */
  maxTokens?: number;
  /**
   * Custom base URL for the Anthropic API.
   */
  baseURL?: string;
}

/**
 * Integration for Anthropic Claude models.
 */
export class AnthropicLlm extends BaseLlm {
  /**
   * A list of model name patterns that are supported by this LLM.
   */
  static override readonly supportedModels: Array<string | RegExp> = [
    /claude-.*/,
  ];

  private readonly apiKey?: string;
  private readonly maxTokens: number;
  private readonly baseURL?: string;
  private _client?: Anthropic;

  constructor({model, apiKey, maxTokens, baseURL}: AnthropicLlmParams) {
    if (!model) {
      model = 'claude-sonnet-4-5-20250514';
    }
    super({model});

    if (!apiKey && !isBrowser()) {
      apiKey = process.env['ANTHROPIC_API_KEY'];
    }
    if (!apiKey) {
      throw new Error(
        'Anthropic API key must be provided via constructor or ANTHROPIC_API_KEY environment variable.',
      );
    }

    this.apiKey = apiKey;
    this.maxTokens = maxTokens ?? 8192;
    this.baseURL = baseURL;
  }

  private async getClient(): Promise<Anthropic> {
    if (!this._client) {
      const {default: AnthropicSDK} = await import('@anthropic-ai/sdk');
      this._client = new AnthropicSDK({
        apiKey: this.apiKey,
        ...(this.baseURL ? {baseURL: this.baseURL} : {}),
      }) as Anthropic;
    }
    return this._client;
  }

  /**
   * Generates content from the Anthropic model.
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
  ): AsyncGenerator<LlmResponse, void> {
    this.maybeAppendUserContent(llmRequest);

    const {messages, system} = this.convertRequest(llmRequest);
    const tools = this.convertTools(llmRequest.config);

    logger.info(
      `Sending out request, model: ${llmRequest.model ?? this.model}, stream: ${stream}`,
    );

    const createParams: MessageCreateParamsNonStreaming = {
      model: llmRequest.model ?? this.model,
      max_tokens: this.maxTokens,
      messages,
      ...(system ? {system} : {}),
      ...(tools.length
        ? {
            tools,
            tool_choice: {
              type: 'auto' as const,
              disable_parallel_tool_use: true,
            },
          }
        : {}),
      ...(llmRequest.config?.temperature != null
        ? {temperature: llmRequest.config.temperature}
        : {}),
      ...(llmRequest.config?.topP != null
        ? {top_p: llmRequest.config.topP}
        : {}),
      ...(llmRequest.config?.topK != null
        ? {top_k: llmRequest.config.topK}
        : {}),
      ...(llmRequest.config?.stopSequences?.length
        ? {stop_sequences: llmRequest.config.stopSequences}
        : {}),
    };

    if (stream) {
      yield* this.generateStreaming(createParams);
    } else {
      yield* this.generateNonStreaming(createParams);
    }
  }

  /**
   * Live connection is not supported for Claude models.
   */
  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connection is not supported for Claude models.');
  }

  // ---------------------------------------------------------------------------
  // Non-streaming
  // ---------------------------------------------------------------------------

  private async *generateNonStreaming(
    params: MessageCreateParamsNonStreaming,
  ): AsyncGenerator<LlmResponse, void> {
    const client = await this.getClient();
    const message = await client.messages.create(params);
    yield this.convertResponse(message);
  }

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  private async *generateStreaming(
    params: MessageCreateParamsNonStreaming,
  ): AsyncGenerator<LlmResponse, void> {
    const client = await this.getClient();
    const stream = client.messages.stream({...params});

    // Track content blocks being built during streaming
    const contentBlocks: Map<
      number,
      {type: string; id?: string; name?: string; text: string; input: string}
    > = new Map();

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const startEvent = event as RawContentBlockStartEvent;
        const block = startEvent.content_block;
        if (block.type === 'text') {
          contentBlocks.set(startEvent.index, {
            type: 'text',
            text: '',
            input: '',
          });
        } else if (block.type === 'tool_use') {
          contentBlocks.set(startEvent.index, {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            text: '',
            input: '',
          });
        }
      } else if (event.type === 'content_block_delta') {
        const deltaEvent = event as RawContentBlockDeltaEvent;
        const tracked = contentBlocks.get(deltaEvent.index);
        if (!tracked) continue;

        if (deltaEvent.delta.type === 'text_delta') {
          tracked.text += deltaEvent.delta.text;
          // Yield partial text
          yield {
            content: {
              role: 'model',
              parts: [{text: deltaEvent.delta.text}],
            },
            partial: true,
          };
        } else if (deltaEvent.delta.type === 'input_json_delta') {
          tracked.input +=
            (deltaEvent.delta as {partial_json?: string}).partial_json ?? '';
        }
      } else if (event.type === 'content_block_stop') {
        // Block complete — nothing to emit here; final message handles it
      }
    }

    // Yield the final complete message
    const finalMessage = await stream.finalMessage();
    yield this.convertResponse(finalMessage);
  }

  // ---------------------------------------------------------------------------
  // Request conversion: LlmRequest → Anthropic format
  // ---------------------------------------------------------------------------

  private convertRequest(llmRequest: LlmRequest): {
    messages: MessageParam[];
    system: string | undefined;
  } {
    // Extract system instruction
    const system = this.extractSystemInstruction(llmRequest.config);

    // Convert contents to Anthropic messages
    const rawMessages: MessageParam[] = [];
    for (const content of llmRequest.contents) {
      const msg = this.contentToMessageParam(content);
      if (msg) {
        rawMessages.push(msg);
      }
    }

    // Anthropic requires alternating user/assistant messages
    const messages = mergeConsecutiveSameRoleMessages(rawMessages);

    // Anthropic requires the first message to be from user
    if (messages.length > 0 && messages[0].role !== 'user') {
      messages.unshift({
        role: 'user',
        content: [{type: 'text', text: 'Continue.'}],
      });
    }

    return {messages, system};
  }

  private extractSystemInstruction(
    config?: GenerateContentConfig,
  ): string | undefined {
    if (!config?.systemInstruction) {
      return undefined;
    }

    const si = config.systemInstruction;
    if (typeof si === 'string') {
      return si;
    }

    // ContentUnion can be Content | Part | PartUnion[]
    // Check if it's a Content object with parts
    if (
      typeof si === 'object' &&
      si !== null &&
      'parts' in si &&
      Array.isArray((si as Content).parts)
    ) {
      return (si as Content)
        .parts!.map((part: Part) => part.text ?? '')
        .filter((t: string) => t.length > 0)
        .join('\n');
    }

    // Single Part with text
    if (typeof si === 'object' && si !== null && 'text' in si) {
      return (si as Part).text ?? undefined;
    }

    // Array of PartUnion
    if (Array.isArray(si)) {
      return si
        .map((part) => {
          if (typeof part === 'string') return part;
          if (typeof part === 'object' && part !== null && 'text' in part) {
            return (part as Part).text ?? '';
          }
          return '';
        })
        .filter((t: string) => t.length > 0)
        .join('\n');
    }

    return undefined;
  }

  private contentToMessageParam(content: Content): MessageParam | undefined {
    if (!content.parts?.length) {
      return undefined;
    }

    const role = toAnthropicRole(content.role ?? 'user');
    const blocks: ContentBlockParam[] = [];

    for (const part of content.parts) {
      if (part.functionCall) {
        blocks.push({
          type: 'tool_use',
          id: part.functionCall.id ?? `fc_${Date.now()}`,
          name: part.functionCall.name ?? '',
          input: part.functionCall.args ?? {},
        } as ToolUseBlockParam);
      } else if (part.functionResponse) {
        const responseContent = part.functionResponse.response
          ? extractResultString(part.functionResponse.response)
          : '';
        blocks.push({
          type: 'tool_result',
          tool_use_id: part.functionResponse.id ?? '',
          content: responseContent,
          is_error: false,
        } as ToolResultBlockParam);
      } else if (part.text != null) {
        // Skip thought parts — Anthropic doesn't accept them in input
        if ('thought' in part && part.thought) {
          continue;
        }
        if (part.text.length > 0) {
          blocks.push({type: 'text', text: part.text} as TextBlockParam);
        }
      }
      // Other part types (inlineData, fileData, etc.) are not yet supported
    }

    if (blocks.length === 0) {
      return undefined;
    }

    return {role, content: blocks};
  }

  // ---------------------------------------------------------------------------
  // Tool conversion: FunctionDeclaration → Anthropic Tool
  // ---------------------------------------------------------------------------

  private convertTools(config?: GenerateContentConfig): Tool[] {
    if (!config?.tools?.length) {
      return [];
    }

    const anthropicTools: Tool[] = [];
    for (const toolGroup of config.tools) {
      // ToolUnion = Tool | CallableTool. Only Tool has functionDeclarations.
      const fds = (toolGroup as {functionDeclarations?: FunctionDeclaration[]})
        .functionDeclarations;
      if (!fds?.length) {
        continue;
      }
      for (const fd of fds) {
        anthropicTools.push(this.functionDeclarationToTool(fd));
      }
    }
    return anthropicTools;
  }

  private functionDeclarationToTool(fd: FunctionDeclaration): Tool {
    const inputSchema: Tool.InputSchema = {
      type: 'object' as const,
      properties: fd.parameters
        ? (normalizeSchemaTypes(schemaToJsonSchema(fd.parameters as Schema))
            .properties ?? {})
        : {},
    };

    return {
      name: fd.name ?? '',
      description: fd.description ?? '',
      input_schema: inputSchema,
    };
  }

  // ---------------------------------------------------------------------------
  // Response conversion: Anthropic Message → LlmResponse
  // ---------------------------------------------------------------------------

  private convertResponse(message: Anthropic.Messages.Message): LlmResponse {
    const parts: Part[] = [];

    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push({text: block.text});
      } else if (block.type === 'tool_use') {
        parts.push({
          functionCall: {
            id: block.id,
            name: block.name,
            args: block.input as Record<string, unknown>,
          },
        });
      }
      // Other block types (thinking, etc.) are ignored for now
    }

    return {
      content: {
        role: 'model',
        parts,
      },
      usageMetadata: {
        promptTokenCount: message.usage.input_tokens,
        candidatesTokenCount: message.usage.output_tokens,
        totalTokenCount:
          message.usage.input_tokens + message.usage.output_tokens,
      },
      turnComplete: true,
    };
  }
}

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Maps Google GenAI roles to Anthropic roles.
 */
function toAnthropicRole(role: string): 'user' | 'assistant' {
  if (role === 'model' || role === 'assistant') {
    return 'assistant';
  }
  return 'user';
}

/**
 * Merges consecutive messages with the same role.
 * Anthropic API requires alternating user/assistant messages.
 */
function mergeConsecutiveSameRoleMessages(
  messages: MessageParam[],
): MessageParam[] {
  if (messages.length === 0) return [];

  const merged: MessageParam[] = [];
  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      // Merge content arrays
      const lastContent = Array.isArray(last.content)
        ? last.content
        : [{type: 'text' as const, text: last.content}];
      const msgContent = Array.isArray(msg.content)
        ? msg.content
        : [{type: 'text' as const, text: msg.content}];
      last.content = [...lastContent, ...msgContent];
    } else {
      merged.push({
        role: msg.role,
        content: Array.isArray(msg.content) ? [...msg.content] : msg.content,
      });
    }
  }
  return merged;
}

/**
 * Extracts a result string from a function response object.
 */
function extractResultString(response: Record<string, unknown>): string {
  if ('result' in response) {
    const result = response['result'];
    return typeof result === 'string' ? result : JSON.stringify(result);
  }
  return JSON.stringify(response);
}

/**
 * Converts a Google GenAI Schema to a plain JSON Schema object.
 */
function schemaToJsonSchema(schema: Schema): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (schema.type) {
    result.type = schema.type;
  }
  if (schema.description) {
    result.description = schema.description;
  }
  if (schema.enum) {
    result.enum = schema.enum;
  }
  if (schema.format) {
    result.format = schema.format;
  }
  if (schema.items) {
    result.items = schemaToJsonSchema(schema.items as Schema);
  }
  if (schema.properties) {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      props[key] = schemaToJsonSchema(value as Schema);
    }
    result.properties = props;
  }
  if (schema.required) {
    result.required = schema.required;
  }

  return result;
}

/**
 * Recursively normalizes type strings to lowercase.
 * Google GenAI uses uppercase types ("STRING", "OBJECT") but
 * Anthropic expects lowercase ("string", "object").
 */
function normalizeSchemaTypes(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result = {...schema};

  if (typeof result.type === 'string') {
    result.type = result.type.toLowerCase();
  }

  if (result.properties && typeof result.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      result.properties as Record<string, unknown>,
    )) {
      if (value && typeof value === 'object') {
        props[key] = normalizeSchemaTypes(value as Record<string, unknown>);
      } else {
        props[key] = value;
      }
    }
    result.properties = props;
  }

  if (result.items && typeof result.items === 'object') {
    result.items = normalizeSchemaTypes(
      result.items as Record<string, unknown>,
    );
  }

  return result;
}
