/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conversions between the `@google/genai` shapes ADK speaks internally and the
 * Anthropic Messages API shapes Claude speaks.
 *
 * Everything here is a pure function of its arguments, so the round trips can
 * be tested without an API key or a client.
 */

import type {
  ContentBlock,
  ContentBlockParam,
  DocumentBlockParam,
  ImageBlockParam,
  Message,
  MessageParam,
  StopReason,
  TextBlockParam,
  ThinkingConfigParam,
  Tool,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import type {LlmResponse} from '@google/adk';
import {getLogger} from '@google/adk';
import type {
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
  Part,
  Schema,
} from '@google/genai';
import {FinishReason} from '@google/genai';

/** The image MIME types Claude accepts in an image block. */
type ImageMediaType = 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';

const IMAGE_MEDIA_TYPES = new Set<string>([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/**
 * Anthropic accepts only these block types inside a tool result, so media a
 * tool attaches to its response has to be narrowed to them.
 */
type ToolResultContentBlockParam = TextBlockParam | ImageBlockParam;

/**
 * Schema keywords `@google/genai` carries that JSON Schema 2020-12 has no place
 * for. Anthropic validates the tool input schema against that draft, so they
 * are dropped rather than passed through.
 */
const NON_JSON_SCHEMA_KEYS = new Set([
  'example',
  'nullable',
  'propertyOrdering',
]);

/**
 * Schema keywords `@google/genai` types as `string` (they are int64 on the
 * wire) but JSON Schema requires to be numbers.
 */
const NUMERIC_SCHEMA_KEYS = new Set([
  'maxItems',
  'maxLength',
  'maxProperties',
  'minItems',
  'minLength',
  'minProperties',
]);

/** Anthropic's stop reasons, mapped onto the GenAI finish reasons ADK reports. */
const STOP_REASONS: Record<string, FinishReason> = {
  'end_turn': FinishReason.STOP,
  'stop_sequence': FinishReason.STOP,
  'tool_use': FinishReason.STOP,
  'pause_turn': FinishReason.STOP,
  'max_tokens': FinishReason.MAX_TOKENS,
  'refusal': FinishReason.SAFETY,
};

/**
 * The token counters this integration reads, in the shape shared by the two
 * places Anthropic reports them: `Usage` on a complete message and
 * `MessageDeltaUsage` on a stream. Structural rather than a union of the two so
 * that a stream can accumulate into it as events arrive.
 */
export interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens_details?: {thinking_tokens: number} | null;
}

/** Maps a GenAI content role onto the two roles Anthropic accepts. */
export function toClaudeRole(role?: string): 'user' | 'assistant' {
  return role === 'model' || role === 'assistant' ? 'assistant' : 'user';
}

/** Maps an Anthropic stop reason onto a GenAI finish reason. */
export function toFinishReason(
  stopReason?: StopReason | null,
): FinishReason | undefined {
  if (!stopReason) {
    return undefined;
  }
  return STOP_REASONS[stopReason] ?? FinishReason.FINISH_REASON_UNSPECIFIED;
}

/**
 * Hands out tool-use IDs Anthropic will accept, and remembers what it handed
 * out.
 *
 * Anthropic pairs a `tool_use` block with its `tool_result` by an ID matching
 * `[a-zA-Z0-9_-]+`, and rejects anything else — including the empty string. Two
 * things in ADK produce an ID Anthropic would reject: a function call the
 * framework itself synthesized carries an `adk-` prefixed ID that the content
 * processor strips before the request is built, leaving none at all; and a
 * session may carry calls minted by another provider entirely.
 *
 * Reuse one sanitizer for a whole request so that a call and its response,
 * which arrive as separate parts, are handed the same replacement.
 */
export class ToolUseIdSanitizer {
  private readonly assigned = new Map<string, string>();

  sanitize(id?: string): string {
    if (id && /^[a-zA-Z0-9_-]+$/.test(id)) {
      return id;
    }
    const key = id ?? '';
    let replacement = this.assigned.get(key);
    if (!replacement) {
      replacement = `toolu_fallback_${this.assigned.size}`;
      this.assigned.set(key, replacement);
    }
    return replacement;
  }
}

/**
 * Converts one GenAI part to an Anthropic content block.
 *
 * Returns undefined for a part Claude has no block for. Throwing instead would
 * wedge the session for good: the offending part stays in the history, so every
 * later turn would fail on it too.
 */
export function partToMessageBlock(
  part: Part,
  sanitizer: ToolUseIdSanitizer,
): ContentBlockParam | undefined {
  if (part.thought && part.text) {
    return {
      type: 'thinking',
      thinking: part.text,
      signature: part.thoughtSignature ?? '',
    };
  }

  // Redacted thinking: no plaintext, only the encrypted blob that
  // contentBlockToPart stashed so it can round-trip back to Claude.
  if (part.thought && part.thoughtSignature) {
    return {type: 'redacted_thinking', data: part.thoughtSignature};
  }

  if (part.text) {
    return {type: 'text', text: part.text};
  }

  if (part.functionCall) {
    return {
      type: 'tool_use',
      id: sanitizer.sanitize(part.functionCall.id),
      name: part.functionCall.name ?? '',
      input: part.functionCall.args ?? {},
    };
  }

  if (part.functionResponse) {
    const text = functionResponseToText(part.functionResponse.response);
    const media = functionResponseMediaBlocks(part.functionResponse);
    const content: ToolResultBlockParam['content'] = media.length
      ? [...(text ? [{type: 'text' as const, text}] : []), ...media]
      : text;
    return {
      type: 'tool_result',
      tool_use_id: sanitizer.sanitize(part.functionResponse.id),
      content,
      is_error: false,
    };
  }

  const inlineData = part.inlineData;
  if (inlineData?.data && inlineData.mimeType) {
    const mediaType = baseMimeType(inlineData.mimeType);
    if (isImageMediaType(mediaType)) {
      return {
        type: 'image',
        source: {type: 'base64', media_type: mediaType, data: inlineData.data},
      };
    }
    if (mediaType === 'application/pdf') {
      return {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: inlineData.data,
        },
      } satisfies DocumentBlockParam;
    }
  }

  if (part.executableCode) {
    return {
      type: 'text',
      text: `Code:\`\`\`python\n${part.executableCode.code ?? ''}\n\`\`\``,
    };
  }

  if (part.codeExecutionResult) {
    return {
      type: 'text',
      text: `Execution Result:\`\`\`code_output\n${
        part.codeExecutionResult.output ?? ''
      }\n\`\`\``,
    };
  }

  getLogger().warn(
    `Dropping a part Claude cannot receive: ${Object.keys(part).join(', ')}.`,
  );
  return undefined;
}

/**
 * Converts one GenAI content to an Anthropic message.
 *
 * Returns undefined when every part was dropped: Anthropic rejects a message
 * with empty content, so the whole message has to go rather than be sent empty.
 */
export function contentToMessageParam(
  content: Content,
  sanitizer: ToolUseIdSanitizer,
): MessageParam | undefined {
  const role = toClaudeRole(content.role);
  const blocks: ContentBlockParam[] = [];

  for (const part of content.parts ?? []) {
    // Claude accepts media only on a user turn.
    if (role === 'assistant' && part.inlineData) {
      getLogger().warn(
        'Dropping media from an assistant turn, which Claude rejects.',
      );
      continue;
    }
    const block = partToMessageBlock(part, sanitizer);
    if (block) {
      blocks.push(block);
    }
  }

  return blocks.length ? {role, content: blocks} : undefined;
}

/**
 * Converts a whole conversation into a message list Anthropic will accept.
 *
 * Beyond converting each turn, this enforces three shape rules the API has and
 * ADK's history does not. Turns left with nothing to send are dropped, because
 * Anthropic rejects a message with empty content. Consecutive turns in the same
 * role are merged: the Anthropic API merges them itself, but Vertex AI and
 * proxies in front of either can insist on strict alternation. And a history
 * that opens on the model — which a sub-agent sees when the branch filter cuts
 * the user turn that started it — gets a placeholder user turn in front, since
 * Anthropic requires `messages[0]` to be the user's.
 */
export function contentsToMessageParams(
  contents: Content[],
  sanitizer: ToolUseIdSanitizer,
): MessageParam[] {
  const messages: MessageParam[] = [];

  for (const content of contents) {
    const message = contentToMessageParam(content, sanitizer);
    if (!message) {
      continue;
    }
    const previous = messages[messages.length - 1];
    if (previous?.role === message.role) {
      previous.content = [
        ...toBlockArray(previous.content),
        ...toBlockArray(message.content),
      ];
    } else {
      messages.push(message);
    }
  }

  if (messages.length && messages[0].role !== 'user') {
    messages.unshift({
      role: 'user',
      content: [{type: 'text', text: 'Continue the conversation below.'}],
    });
  }

  return messages;
}

function toBlockArray(content: MessageParam['content']): ContentBlockParam[] {
  return typeof content === 'string'
    ? [{type: 'text', text: content}]
    : content;
}

/** Converts one Anthropic content block back to a GenAI part. */
export function contentBlockToPart(block: ContentBlock): Part | undefined {
  switch (block.type) {
    case 'text':
      return {text: block.text};
    case 'thinking':
      return {
        text: block.thinking,
        thought: true,
        ...(block.signature ? {thoughtSignature: block.signature} : {}),
      };
    case 'redacted_thinking':
      // Kept so the reasoning chain can be replayed to Claude next turn.
      return {thought: true, thoughtSignature: block.data};
    case 'tool_use':
      return {
        functionCall: {
          id: block.id,
          name: block.name,
          args: (block.input ?? {}) as Record<string, unknown>,
        },
      };
    default:
      getLogger().warn(
        `Ignoring an unsupported Claude content block: ${block.type}.`,
      );
      return undefined;
  }
}

/** Converts a complete Anthropic message to an ADK response. */
export function messageToLlmResponse(message: Message): LlmResponse {
  const parts: Part[] = [];
  for (const block of message.content) {
    const part = contentBlockToPart(block);
    if (part) {
      parts.push(part);
    }
  }

  return {
    content: {role: 'model', parts},
    usageMetadata: toUsageMetadata(message.usage),
    finishReason: toFinishReason(message.stop_reason),
    modelVersion: message.model,
  };
}

/**
 * Maps Anthropic token accounting onto the GenAI shape.
 *
 * The two disagree in two places. Anthropic reports tokens served from, and
 * written to, the prompt cache in their own fields, disjoint from
 * `input_tokens`; GenAI expects a single prompt count with the cached portion
 * folded in, `cachedContentTokenCount` being a breakdown of it rather than an
 * addition. And Anthropic counts extended-thinking tokens inside
 * `output_tokens`, whereas GenAI keeps the candidate and thought counts
 * disjoint, so the thinking tokens are subtracted back out.
 */
export function toUsageMetadata(
  usage: AnthropicUsage,
): GenerateContentResponseUsageMetadata {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const promptTokens = (usage.input_tokens ?? 0) + cacheRead + cacheCreation;
  const outputTokens = usage.output_tokens ?? 0;
  const thinkingTokens = thinkingTokenCount(usage);

  return {
    promptTokenCount: promptTokens,
    candidatesTokenCount: outputTokens - (thinkingTokens ?? 0),
    totalTokenCount: promptTokens + outputTokens,
    ...(usage.cache_read_input_tokens != null
      ? {cachedContentTokenCount: cacheRead}
      : {}),
    ...(thinkingTokens != null ? {thoughtsTokenCount: thinkingTokens} : {}),
  };
}

/** Converts an ADK function declaration to an Anthropic tool definition. */
export function functionDeclarationToTool(
  declaration: FunctionDeclaration,
): Tool {
  let inputSchema: Tool.InputSchema;

  if (isRecord(declaration.parametersJsonSchema)) {
    inputSchema = {
      ...(toJsonSchema(declaration.parametersJsonSchema) as Record<
        string,
        unknown
      >),
      type: 'object',
    };
  } else {
    const parameters = declaration.parameters;
    inputSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(parameters?.properties ?? {}).map(([name, schema]) => [
          name,
          toJsonSchema(schema as Schema),
        ]),
      ),
      ...(parameters?.required?.length ? {required: parameters.required} : {}),
    };
  }

  return {
    name: declaration.name ?? '',
    description: declaration.description ?? '',
    input_schema: inputSchema,
  };
}

/** Collects every function declaration configured on the request. */
export function toolsToAnthropicTools(config?: GenerateContentConfig): Tool[] {
  const tools: Tool[] = [];
  for (const configured of config?.tools ?? []) {
    const declarations = (
      configured as {functionDeclarations?: FunctionDeclaration[]}
    ).functionDeclarations;
    for (const declaration of declarations ?? []) {
      tools.push(functionDeclarationToTool(declaration));
    }
  }
  return tools;
}

/**
 * Flattens a system instruction to the single string Anthropic's `system`
 * parameter takes.
 */
export function extractSystemInstruction(
  config?: GenerateContentConfig,
): string | undefined {
  const instruction = config?.systemInstruction;
  if (!instruction) {
    return undefined;
  }
  if (typeof instruction === 'string') {
    return instruction;
  }

  const parts = Array.isArray(instruction)
    ? instruction
    : ((instruction as Content).parts ?? [instruction as Part]);

  const texts: string[] = [];
  for (const part of parts) {
    const text = typeof part === 'string' ? part : (part as Part).text;
    if (text) {
      texts.push(text);
    }
  }
  return texts.length ? texts.join('\n') : undefined;
}

/**
 * Maps the GenAI thinking config onto Anthropic's `thinking` parameter.
 *
 * `thinkingBudget` carries the intent: 0 disables thinking, a negative value
 * (GenAI's AUTOMATIC is -1) asks the model to pick its own depth, and a
 * positive value is a manual token budget. Anthropic requires an explicit
 * choice whenever thinking is configured at all, so a config with no budget is
 * an error rather than a silent default.
 */
export function toThinkingParam(
  config?: GenerateContentConfig,
): ThinkingConfigParam | undefined {
  const thinkingConfig = config?.thinkingConfig;
  if (!thinkingConfig) {
    return undefined;
  }
  const budget = thinkingConfig.thinkingBudget;
  if (budget == null) {
    throw new Error(
      'thinkingBudget must be set explicitly when thinkingConfig is provided ' +
        'for Claude models. Use 0 to disable thinking, -1 to let the model ' +
        'choose its own depth, or a positive integer (>= 1024) to set a ' +
        'manual budget.',
    );
  }
  if (budget === 0) {
    return {type: 'disabled'};
  }
  if (budget < 0) {
    return {type: 'adaptive'};
  }
  return {type: 'enabled', budget_tokens: budget};
}

/**
 * Rewrites a GenAI schema as JSON Schema 2020-12, which is what Anthropic
 * validates a tool's `input_schema` against.
 *
 * Three things differ: GenAI spells its types in upper case (`STRING`), it
 * types the int64 bounds as strings, and it carries OpenAPI keywords JSON
 * Schema has no place for.
 */
function toJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(toJsonSchema);
  }
  if (!isRecord(schema)) {
    return schema;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (value === undefined || NON_JSON_SCHEMA_KEYS.has(key)) {
      continue;
    }
    if (key === 'type' && typeof value === 'string') {
      result[key] = value.toLowerCase();
    } else if (NUMERIC_SCHEMA_KEYS.has(key) && typeof value === 'string') {
      const numeric = Number(value);
      result[key] = Number.isNaN(numeric) ? value : numeric;
    } else if (key === 'properties' && isRecord(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, property]) => [
          name,
          toJsonSchema(property),
        ]),
      );
    } else {
      result[key] = toJsonSchema(value);
    }
  }
  return result;
}

/**
 * Serializes a tool's return value for a `tool_result` block, which carries
 * text rather than structured data.
 */
function functionResponseToText(response?: Record<string, unknown>): string {
  if (!response || Object.keys(response).length === 0) {
    return '';
  }

  const content = response['content'];
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        isRecord(item) && item['type'] === 'text' && 'text' in item
          ? String(item['text'])
          : stringify(item),
      )
      .join('\n');
  }
  if (typeof content === 'string' && content) {
    return content;
  }

  // Exactly {result: value} is ADK's own wrapper around a non-object tool
  // return, so it is unwrapped rather than sent as a one-key object.
  const keys = Object.keys(response);
  if (keys.length === 1 && keys[0] === 'result' && response['result'] != null) {
    return stringify(response['result']);
  }

  return JSON.stringify(response);
}

/**
 * Converts media a tool attached to its response into tool result blocks.
 *
 * Media Claude cannot carry in a tool result is dropped with a warning rather
 * than raised on: the tool that produced it is often third-party code the
 * caller cannot change, and losing one image beats losing the conversation.
 */
function functionResponseMediaBlocks(functionResponse: {
  parts?: Array<{inlineData?: {data?: string; mimeType?: string}}>;
}): ToolResultContentBlockParam[] {
  const blocks: ToolResultContentBlockParam[] = [];
  for (const part of functionResponse.parts ?? []) {
    const data = part.inlineData?.data;
    const mimeType = part.inlineData?.mimeType;
    if (!data || !mimeType) {
      continue;
    }
    const mediaType = baseMimeType(mimeType);
    if (isImageMediaType(mediaType)) {
      blocks.push({
        type: 'image',
        source: {type: 'base64', media_type: mediaType, data},
      });
    } else {
      getLogger().warn(
        `Dropping tool result media of type ${mediaType}, which Claude cannot ` +
          'receive in a tool result.',
      );
    }
  }
  return blocks;
}

/** Strips any parameters from a MIME type: `image/png; charset=x` → `image/png`. */
function baseMimeType(mimeType: string): string {
  return mimeType.split(';', 1)[0].trim().toLowerCase();
}

function isImageMediaType(mediaType: string): mediaType is ImageMediaType {
  return IMAGE_MEDIA_TYPES.has(mediaType);
}

function thinkingTokenCount(usage: AnthropicUsage): number | undefined {
  const thinking = usage.output_tokens_details?.thinking_tokens;
  if (typeof thinking !== 'number') {
    return undefined;
  }
  // Clamped so that subtracting it from output_tokens stays non-negative even
  // if the two counters ever disagree.
  return Math.min(thinking, usage.output_tokens ?? thinking);
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
