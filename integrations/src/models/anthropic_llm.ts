/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Claude support for ADK, over the Anthropic Messages API.
 *
 * Two models are exported, mirroring the two ways Claude is served:
 * `AnthropicLlm` calls the Anthropic API directly with an API key, and `Claude`
 * calls the copy served from Vertex AI Model Garden with Google Cloud
 * credentials.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type {
  MessageCreateParamsBase,
  MessageParam,
  RawMessageStreamEvent,
  StopReason,
  Tool,
} from '@anthropic-ai/sdk/resources/messages';
import type {AnthropicVertex} from '@anthropic-ai/vertex-sdk';
import type {BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';
import {BaseLlm, getClientLabels, getLogger, LLMRegistry} from '@google/adk';
import type {Part} from '@google/genai';

import type {AnthropicUsage} from './anthropic_converters.js';
import {
  contentsToMessageParams,
  extractSystemInstruction,
  messageToLlmResponse,
  toFinishReason,
  toolsToAnthropicTools,
  ToolUseIdSanitizer,
  toThinkingParam,
  toUsageMetadata,
} from './anthropic_converters.js';

/** Every Anthropic client shape this integration can drive. */
export type AnthropicClient = Anthropic | AnthropicVertex;

/** The default token ceiling, applied when the request sets none. */
const DEFAULT_MAX_TOKENS = 8192;

/**
 * The Vertex AI resource name a Claude model is published under, e.g.
 * `projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-4-1`.
 * The Anthropic SDK wants the bare model ID, so the prefix is stripped off.
 */
const VERTEX_MODEL_PATH =
  /^projects\/([^/]+)\/locations\/([^/]+)\/(?:publishers\/anthropic\/models|endpoints)\/([^/:]+)$/;

/** The parameters for creating an {@link AnthropicLlm}. */
export interface AnthropicLlmParams {
  /** The Claude model to call, e.g. `claude-sonnet-4-5-20250929`. */
  model: string;
  /**
   * The Anthropic API key. Defaults to the `ANTHROPIC_API_KEY` environment
   * variable; if that is unset too, the SDK's own credential resolution runs,
   * which also picks up a signed-in on-disk Anthropic profile.
   */
  apiKey?: string;
  /**
   * The token ceiling for a response, used when the request carries no
   * `maxOutputTokens`. Defaults to 8192.
   */
  maxTokens?: number;
  /** Overrides the API base URL. */
  baseURL?: string;
  /**
   * A pre-configured client, for a setup this class does not build itself: a
   * proxy, a custom retry policy, or Bedrock via `@anthropic-ai/bedrock-sdk`.
   */
  client?: AnthropicClient;
}

/** The parameters for creating a {@link Claude}. */
export interface ClaudeParams extends AnthropicLlmParams {
  /**
   * The Google Cloud project serving the model. Defaults to the
   * `GOOGLE_CLOUD_PROJECT` environment variable, or to the project named in a
   * fully qualified `projects/…` model name.
   */
  project?: string;
  /**
   * The region serving the model, e.g. `us-east5`. Defaults to the
   * `GOOGLE_CLOUD_LOCATION` environment variable, or to the region named in a
   * fully qualified `projects/…` model name.
   */
  location?: string;
}

/**
 * Calls Claude through the Anthropic API.
 *
 * Register it once to resolve a bare `claude-*` model name to this class, then
 * name the model as a string anywhere a model is accepted:
 *
 * ```ts
 * import {LLMRegistry} from '@google/adk';
 * import {AnthropicLlm} from '@google/adk-integrations';
 *
 * LLMRegistry.register(AnthropicLlm);
 * const agent = new LlmAgent({name: 'a', model: 'claude-sonnet-4-5-20250929'});
 * ```
 *
 * Importing `@google/adk-integrations` registers it for you, so the explicit
 * call is only needed when importing this module directly.
 *
 * Live (bidirectional streaming) connections are not supported; Claude has no
 * equivalent API.
 */
export class AnthropicLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    /claude-.*/,
  ];

  protected readonly apiKey?: string;
  protected readonly baseURL?: string;
  private readonly maxTokens: number;
  private readonly providedClient?: AnthropicClient;
  private cachedClient?: AnthropicClient;

  constructor({model, apiKey, maxTokens, baseURL, client}: AnthropicLlmParams) {
    super({model});
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.maxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
    this.providedClient = client;
  }

  /**
   * Sends a request to Claude.
   *
   * @param llmRequest The request to send.
   * @param stream Whether to stream the response. A streaming call yields a
   *     partial response per text or thinking delta, then one final aggregated
   *     response; a non-streaming call yields that final response only.
   * @param abortSignal Cancels the in-flight HTTP request.
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.maybeAppendUserContent(llmRequest);

    const params = this.buildCreateParams(llmRequest);
    const options = abortSignal ? {signal: abortSignal} : undefined;
    getLogger().info(
      `Sending out request, model: ${params.model}, stream: ${stream}`,
    );

    const client = await this.getClient();
    if (!stream) {
      const message = await client.messages.create(
        {...params, stream: false},
        options,
      );
      getLogger().debug(`Claude response: ${JSON.stringify(message)}`);
      yield messageToLlmResponse(message);
      return;
    }

    const events = await client.messages.create(
      {...params, stream: true},
      options,
    );
    yield* aggregateStream(events);
  }

  /** Claude has no live API, so a live connection cannot be established. */
  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connection is not supported for Claude models.');
  }

  /** Translates an ADK request into the Anthropic Messages API request. */
  protected buildCreateParams(llmRequest: LlmRequest): MessageCreateParamsBase {
    const config = llmRequest.config;
    const sanitizer = new ToolUseIdSanitizer();
    const messages: MessageParam[] = contentsToMessageParams(
      llmRequest.contents,
      sanitizer,
    );
    const tools: Tool[] = toolsToAnthropicTools(config);
    const system = extractSystemInstruction(config);
    const thinking = toThinkingParam(config);

    // Claude rejects the sampling parameters while it is reasoning.
    const sampling =
      thinking && thinking.type !== 'disabled'
        ? {}
        : {
            ...(config?.temperature != null
              ? {temperature: config.temperature}
              : {}),
            ...(config?.topP != null ? {top_p: config.topP} : {}),
            ...(config?.topK != null ? {top_k: Math.trunc(config.topK)} : {}),
          };

    return {
      model: this.resolveModelName(llmRequest.model ?? this.model),
      max_tokens: config?.maxOutputTokens ?? this.maxTokens,
      messages,
      ...(system ? {system} : {}),
      ...(tools.length ? {tools, tool_choice: {type: 'auto'}} : {}),
      ...(thinking ? {thinking} : {}),
      ...(config?.stopSequences?.length
        ? {stop_sequences: config.stopSequences}
        : {}),
      ...sampling,
    };
  }

  /**
   * Reduces a model name to what the Anthropic SDK expects: a bare model ID.
   */
  protected resolveModelName(model: string): string {
    return VERTEX_MODEL_PATH.exec(model)?.[3] ?? model;
  }

  /** Builds the client on first use, then reuses it. */
  protected async getClient(): Promise<AnthropicClient> {
    if (!this.cachedClient) {
      this.cachedClient = this.providedClient ?? (await this.createClient());
    }
    return this.cachedClient;
  }

  protected async createClient(): Promise<AnthropicClient> {
    const {default: AnthropicSdk} = await importAnthropic();
    return new AnthropicSdk({
      ...(this.apiKey ? {apiKey: this.apiKey} : {}),
      ...(this.baseURL ? {baseURL: this.baseURL} : {}),
    });
  }
}

/**
 * Calls Claude served from Vertex AI Model Garden.
 *
 * Authentication and quota come from Google Cloud rather than from an Anthropic
 * API key, so it needs a project and a region — from the constructor, from
 * `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, or from a fully qualified
 * model name. Note that Vertex spells the model version with an `@`
 * (`claude-sonnet-4-5@20250929`) where the Anthropic API uses a dash.
 *
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'a',
 *   model: new Claude({model: 'claude-sonnet-4-5@20250929'}),
 * });
 * ```
 *
 * Requires the optional `@anthropic-ai/vertex-sdk` peer dependency.
 */
export class Claude extends AnthropicLlm {
  /**
   * Only the fully qualified Vertex resource name resolves to this class. A
   * bare `claude-*` name is ambiguous between the two services, and resolves to
   * {@link AnthropicLlm}; to call Vertex with a bare name, construct this class
   * directly and pass the instance as the model.
   */
  static override readonly supportedModels: Array<string | RegExp> = [
    /projects\/.+\/locations\/.+\/publishers\/anthropic\/models\/claude-.+/,
  ];

  private readonly project?: string;
  private readonly location?: string;

  constructor(params: ClaudeParams) {
    super(params);
    const fromModelName = VERTEX_MODEL_PATH.exec(params.model);
    this.project =
      params.project ?? fromModelName?.[1] ?? readEnv('GOOGLE_CLOUD_PROJECT');
    this.location =
      params.location ?? fromModelName?.[2] ?? readEnv('GOOGLE_CLOUD_LOCATION');
  }

  protected override async createClient(): Promise<AnthropicClient> {
    if (!this.project || !this.location) {
      throw new Error(
        `Model '${this.model}' is served from Vertex AI, so a project and a ` +
          'region are required. Pass them to the Claude constructor, or set ' +
          'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION. To call the ' +
          'Anthropic API directly with an ANTHROPIC_API_KEY instead, use ' +
          'AnthropicLlm.',
      );
    }

    const {AnthropicVertex: AnthropicVertexSdk} = await importAnthropicVertex();
    return new AnthropicVertexSdk({
      projectId: this.project,
      region: this.location,
      ...(this.baseURL ? {baseURL: this.baseURL} : {}),
      defaultHeaders: trackingHeaders(),
    });
  }
}

/**
 * Folds an Anthropic event stream into ADK responses.
 *
 * Text and thinking deltas are yielded as they arrive, marked partial, so a
 * caller streaming to a UI has something to show. Tool call arguments are not:
 * they arrive as JSON fragments that only parse once complete. Everything is
 * accumulated by block index and yielded once more at the end as a single
 * complete response, which is the one ADK records in the session.
 */
async function* aggregateStream(
  events: AsyncIterable<RawMessageStreamEvent>,
): AsyncGenerator<LlmResponse, void> {
  const texts = new Map<number, string>();
  const thoughts = new Map<number, {text: string; signature: string}>();
  const toolCalls = new Map<number, {id: string; name: string; args: string}>();
  let usage: AnthropicUsage = {input_tokens: 0, output_tokens: 0};
  let stopReason: StopReason | null = null;
  let modelVersion: string | undefined;

  for await (const event of events) {
    switch (event.type) {
      case 'message_start':
        usage = event.message.usage;
        modelVersion = event.message.model;
        break;

      case 'content_block_start': {
        const block = event.content_block;
        if (block.type === 'text') {
          texts.set(event.index, block.text);
        } else if (block.type === 'thinking') {
          thoughts.set(event.index, {
            text: block.thinking,
            signature: block.signature,
          });
        } else if (block.type === 'redacted_thinking') {
          // Arrives whole; no deltas follow.
          thoughts.set(event.index, {text: '', signature: block.data});
        } else if (block.type === 'tool_use') {
          toolCalls.set(event.index, {
            id: block.id,
            name: block.name,
            args: '',
          });
        }
        break;
      }

      case 'content_block_delta': {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          texts.set(event.index, (texts.get(event.index) ?? '') + delta.text);
          yield {
            content: {role: 'model', parts: [{text: delta.text}]},
            partial: true,
            modelVersion,
          };
        } else if (delta.type === 'thinking_delta') {
          const thought = thoughts.get(event.index) ?? {
            text: '',
            signature: '',
          };
          thought.text += delta.thinking;
          thoughts.set(event.index, thought);
          yield {
            content: {
              role: 'model',
              parts: [{text: delta.thinking, thought: true}],
            },
            partial: true,
            modelVersion,
          };
        } else if (delta.type === 'signature_delta') {
          // The signature arrives near the end of a thinking block, separately
          // from its text. It has to be kept: replaying a reasoning block to
          // Claude on the next turn requires echoing it back signed, which
          // extended thinking combined with tool use depends on. Not surfaced
          // as a partial — it is an opaque blob, not text anyone can read.
          const thought = thoughts.get(event.index) ?? {
            text: '',
            signature: '',
          };
          thought.signature += delta.signature;
          thoughts.set(event.index, thought);
        } else if (delta.type === 'input_json_delta') {
          const call = toolCalls.get(event.index);
          if (call) {
            call.args += delta.partial_json;
          }
        }
        break;
      }

      case 'message_delta':
        // Carries the authoritative cumulative counts for the turn, so the
        // thinking detail is refreshed alongside the total it is nested in.
        usage = {
          ...usage,
          output_tokens: event.usage.output_tokens,
          output_tokens_details: event.usage.output_tokens_details,
        };
        stopReason = event.delta?.stop_reason ?? stopReason;
        break;

      default:
        break;
    }
  }

  const indices = [
    ...new Set([...texts.keys(), ...thoughts.keys(), ...toolCalls.keys()]),
  ].sort((a, b) => a - b);

  const parts: Part[] = [];
  for (const index of indices) {
    const thought = thoughts.get(index);
    if (thought) {
      parts.push({
        ...(thought.text ? {text: thought.text} : {}),
        thought: true,
        ...(thought.signature ? {thoughtSignature: thought.signature} : {}),
      });
    }
    const text = texts.get(index);
    if (text !== undefined) {
      parts.push({text});
    }
    const call = toolCalls.get(index);
    if (call) {
      parts.push({
        functionCall: {
          id: call.id,
          name: call.name,
          args: parseToolArgs(call.args, call.name),
        },
      });
    }
  }

  yield {
    content: {role: 'model', parts},
    usageMetadata: toUsageMetadata(usage),
    finishReason: toFinishReason(stopReason),
    modelVersion,
    partial: false,
  };
}

/**
 * Parses accumulated tool call arguments, tolerating a stream that ended early.
 *
 * A truncated fragment yields an empty argument object rather than throwing, so
 * the tool reports its own missing-argument error and the turn survives.
 */
function parseToolArgs(json: string, name: string): Record<string, unknown> {
  if (!json) {
    return {};
  }
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    getLogger().warn(
      `Claude streamed arguments for '${name}' that do not parse as JSON; ` +
        'calling it with no arguments.',
    );
    return {};
  }
}

/** Identifies ADK as the caller, the way the Gemini integration does. */
function trackingHeaders(): Record<string, string> {
  const labels = getClientLabels().join(' ');
  return {'x-goog-api-client': labels, 'user-agent': labels};
}

function readEnv(name: string): string | undefined {
  return typeof process === 'undefined' ? undefined : process.env?.[name];
}

/**
 * Loads the Anthropic SDK on demand.
 *
 * The import is dynamic so that importing this package does not pull the SDK
 * into a bundle that never calls Claude, and so that the missing-dependency
 * error names the package to install.
 */
async function importAnthropic(): Promise<typeof import('@anthropic-ai/sdk')> {
  try {
    return await import('@anthropic-ai/sdk');
  } catch (cause) {
    throw new Error(
      'Claude support requires the @anthropic-ai/sdk package. Install it with ' +
        '`npm install @anthropic-ai/sdk`.',
      {cause},
    );
  }
}

async function importAnthropicVertex(): Promise<
  typeof import('@anthropic-ai/vertex-sdk')
> {
  try {
    return await import('@anthropic-ai/vertex-sdk');
  } catch (cause) {
    throw new Error(
      'Claude on Vertex AI requires the @anthropic-ai/vertex-sdk package. ' +
        'Install it with `npm install @anthropic-ai/vertex-sdk`.',
      {cause},
    );
  }
}

// Registering here rather than in a barrel means the model names resolve
// wherever these classes are loaded from, including a deep import. Core does
// the same for Gemini and Apigee.
LLMRegistry.register(AnthropicLlm);
LLMRegistry.register(Claude);
