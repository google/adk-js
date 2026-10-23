/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Anthropic} from '@anthropic-ai/sdk';
import type {AnthropicVertex} from '@anthropic-ai/vertex-sdk';
import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
  logger,
} from '@google/adk';

import {
  collectFunctionDeclarations,
  contentToMessageParam,
  createAnthropicClient,
  createDirectAnthropicClient,
  extractSystemInstructionText,
  functionDeclarationToToolParam,
  messageToGenerateContentResponse,
  ToolUseIdSanitizer,
} from './anthropic_utils.js';

/**
 * Legacy default maximum number of output tokens requested from Claude.
 *
 * @deprecated Configure {@link ClaudeParams.maxTokens} or
 *     `llmRequest.config.maxOutputTokens` instead. `Claude` defaults to `8192`
 *     output tokens.
 */
export const MAX_TOKEN = 1024;

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6@default';

/**
 * Configuration parameters for creating an {@link AnthropicLlm} model instance.
 */
export interface AnthropicLlmParams {
  /**
   * The name of the Claude model on the Anthropic API. Defaults to
   * `'claude-sonnet-5-5'`.
   */
  model?: string;
  /**
   * The default maximum number of tokens to generate per request when
   * `llmRequest.config?.maxOutputTokens` is not set. Defaults to `8192`.
   */
  maxTokens?: number;
}

const ANTHROPIC_LLM_SYMBOL = Symbol.for('google.adk.anthropicLlm');

/**
 * Type guard that checks whether an object is an {@link AnthropicLlm} instance.
 */
export function isAnthropicLlm(obj: unknown): obj is AnthropicLlm {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    ANTHROPIC_LLM_SYMBOL in obj &&
    obj[ANTHROPIC_LLM_SYMBOL] === true
  );
}

/**
 * Configuration parameters for creating a {@link Claude} model instance.
 */
export interface ClaudeParams {
  /**
   * The name of the Claude model on Vertex AI. Defaults to
   * `'claude-sonnet-4-6@default'`.
   */
  model?: string;
  /**
   * The default maximum number of tokens to generate per request when
   * `llmRequest.config?.maxOutputTokens` is not set. Defaults to `8192`.
   */
  maxTokens?: number;
}

const CLAUDE_MODEL_SYMBOL = Symbol.for('google.adk.claudeModel');

/**
 * Type guard that checks whether an object is a {@link Claude} instance.
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
 * Integration with Anthropic Claude models via the direct Anthropic API.
 */
export class AnthropicLlm extends BaseLlm {
  readonly [ANTHROPIC_LLM_SYMBOL] = true;

  /**
   * Model name patterns matched by `LLMRegistry` when registered.
   */
  static override readonly supportedModels: Array<string | RegExp> = [
    /claude-.*/,
  ];

  readonly maxTokens: number;
  private anthropicClientPromise?: Promise<Anthropic | AnthropicVertex>;

  /**
   * Creates an {@link AnthropicLlm} model instance for the direct Anthropic API
   * (`ANTHROPIC_API_KEY`).
   */
  constructor(params: AnthropicLlmParams = {}) {
    super({model: params.model ?? DEFAULT_ANTHROPIC_MODEL});
    this.maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  /**
   * Generates a response from Claude for the given request.
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const sanitizer = new ToolUseIdSanitizer();
    const messages = (llmRequest.contents ?? []).map((content) =>
      contentToMessageParam(content, sanitizer),
    );
    const functionDeclarations = collectFunctionDeclarations(llmRequest);
    const tools: Anthropic.Tool[] | undefined =
      functionDeclarations.length > 0
        ? functionDeclarations.map(functionDeclarationToToolParam)
        : undefined;

    const hasTools = Object.keys(llmRequest.toolsDict ?? {}).length > 0;
    const toolChoice: Anthropic.ToolChoiceAuto | undefined = hasTools
      ? {
          type: 'auto',
          disable_parallel_tool_use: true,
        }
      : undefined;

    const client = await this.getAnthropicClient();
    const message = await client.messages.create(
      {
        model: llmRequest.model ?? this.model,
        system: extractSystemInstructionText(llmRequest),
        messages,
        tools,
        tool_choice: toolChoice,
        max_tokens: llmRequest.config?.maxOutputTokens ?? this.maxTokens,
      },
      abortSignal ? {signal: abortSignal} : undefined,
    );
    logger.debug('Claude response:', JSON.stringify(message, null, 2));
    yield messageToGenerateContentResponse(message);
  }

  /**
   * Rejects live connections, which are not supported for Claude models.
   */
  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(`Live connection is not supported for ${this.model}.`);
  }

  /**
   * Creates the underlying Anthropic SDK client for this model instance.
   */
  protected createClient(): Promise<Anthropic | AnthropicVertex> {
    return createDirectAnthropicClient();
  }

  private getAnthropicClient(): Promise<Anthropic | AnthropicVertex> {
    this.anthropicClientPromise ??= this.createClient().catch(
      (err: unknown) => {
        this.anthropicClientPromise = undefined;
        throw err;
      },
    );
    return this.anthropicClientPromise;
  }
}

/**
 * Integration with Anthropic Claude models served on Vertex AI.
 */
export class Claude extends AnthropicLlm {
  readonly [CLAUDE_MODEL_SYMBOL] = true;

  /**
   * Creates a {@link Claude} model instance served on Vertex AI
   * (`GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`).
   */
  constructor(params: ClaudeParams = {}) {
    super({
      model: params.model ?? DEFAULT_CLAUDE_MODEL,
      maxTokens: params.maxTokens,
    });
  }

  /**
   * Creates the Vertex AI `AnthropicVertex` client for this model instance.
   */
  protected override createClient(): Promise<AnthropicVertex> {
    return createAnthropicClient();
  }
}
