/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Anthropic} from '@anthropic-ai/sdk';
import type {AnthropicVertex} from '@anthropic-ai/vertex-sdk';
import {
  genaiSchemaToJsonSchema,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import {
  type Content,
  FinishReason,
  type FunctionDeclaration,
  type Part,
} from '@google/genai';

/**
 * Conversational role accepted in Anthropic message parameters.
 */
export enum ClaudeRole {
  USER = 'user',
  ASSISTANT = 'assistant',
}

/**
 * Union of Anthropic content block parameter types produced from ADK parts.
 */
export type ClaudeMessageBlockParam =
  | Anthropic.TextBlockParam
  | Anthropic.ImageBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeUnsupportedPartKind(part: Part): string {
  if (part.thought) {
    return 'thought';
  }
  if (part.inlineData) {
    return 'inlineData';
  }
  if (part.fileData) {
    return 'fileData';
  }
  if (part.executableCode) {
    return 'executableCode';
  }
  if (part.codeExecutionResult) {
    return 'codeExecutionResult';
  }
  if (part.videoMetadata) {
    return 'videoMetadata';
  }
  if (part.audioTranscription) {
    return 'audioTranscription';
  }
  if (part.toolCall) {
    return 'toolCall';
  }
  if (part.toolResponse) {
    return 'toolResponse';
  }
  if (part.text === '') {
    return 'empty text';
  }
  const keys = Object.keys(part);
  return keys.length > 0 ? keys.join(', ') : 'empty part';
}

function formatFunctionResponseContent(
  response: Record<string, unknown> | undefined,
): string {
  if (!response) {
    return '';
  }
  if ('result' in response) {
    const result = response['result'];
    if (result === null || result === undefined) {
      return '';
    }
    if (typeof result === 'string') {
      return result;
    }
    return JSON.stringify(result);
  }
  if (Object.keys(response).length > 0) {
    return JSON.stringify(response);
  }
  return '';
}

/**
 * Extracts the system instruction text from an {@link LlmRequest}.
 */
export function extractSystemInstructionText(
  llmRequest: LlmRequest,
): string | undefined {
  const systemInstruction = llmRequest.config?.systemInstruction;
  if (!systemInstruction) {
    return undefined;
  }
  if (typeof systemInstruction === 'string') {
    return systemInstruction;
  }
  if (
    typeof systemInstruction === 'object' &&
    'parts' in systemInstruction &&
    Array.isArray(systemInstruction.parts)
  ) {
    const texts: string[] = [];
    for (const part of systemInstruction.parts) {
      if (
        typeof part === 'object' &&
        part !== null &&
        'text' in part &&
        typeof part.text === 'string' &&
        part.text.length > 0
      ) {
        texts.push(part.text);
      }
    }
    return texts.length > 0 ? texts.join('\n') : undefined;
  }
  return undefined;
}

/**
 * Collects all `FunctionDeclaration` entries across `llmRequest.config.tools`.
 */
export function collectFunctionDeclarations(
  llmRequest: LlmRequest,
): FunctionDeclaration[] {
  const functionDeclarations: FunctionDeclaration[] = [];
  for (const toolEntry of llmRequest.config?.tools ?? []) {
    if (
      typeof toolEntry === 'object' &&
      toolEntry !== null &&
      'functionDeclarations' in toolEntry &&
      Array.isArray(toolEntry.functionDeclarations)
    ) {
      functionDeclarations.push(...toolEntry.functionDeclarations);
    }
  }
  return functionDeclarations;
}

/**
 * Maps an ADK content role to an Anthropic message role.
 */
export function toClaudeRole(role?: string): ClaudeRole {
  if (role === 'model' || role === 'assistant') {
    return ClaudeRole.ASSISTANT;
  }
  return ClaudeRole.USER;
}

const STOP_REASON_TO_FINISH_REASON = {
  end_turn: FinishReason.STOP,
  stop_sequence: FinishReason.STOP,
  tool_use: FinishReason.STOP,
  pause_turn: FinishReason.STOP,
  max_tokens: FinishReason.MAX_TOKENS,
  model_context_window_exceeded: FinishReason.MAX_TOKENS,
  refusal: FinishReason.SAFETY,
} satisfies Record<Anthropic.StopReason, FinishReason>;

function isAnthropicStopReason(value: string): value is Anthropic.StopReason {
  return Object.prototype.hasOwnProperty.call(
    STOP_REASON_TO_FINISH_REASON,
    value,
  );
}

/**
 * Maps an Anthropic stop reason to a `FinishReason` value.
 */
export function toGoogleGenaiFinishReason(
  anthropicStopReason?: Anthropic.StopReason | string | null,
): FinishReason {
  if (anthropicStopReason && isAnthropicStopReason(anthropicStopReason)) {
    return STOP_REASON_TO_FINISH_REASON[anthropicStopReason];
  }
  return FinishReason.FINISH_REASON_UNSPECIFIED;
}

const VALID_TOOL_USE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Ensures `tool_use` and `tool_result` IDs match Anthropic's pattern
 * (`^[a-zA-Z0-9_-]+$`), consistently mapping invalid or missing IDs within a
 * request.
 */
export class ToolUseIdSanitizer {
  private nextFallback = 0;
  private readonly mapping = new Map<string, string>();
  private readonly unpairedCallsByName = new Map<string, string[]>();
  private readonly unpairedCallsList: string[] = [];

  private getNextFallback(): string {
    return `toolu_fallback_${this.nextFallback++}`;
  }

  sanitize(
    toolId: string | null | undefined,
    toolName: string | null | undefined,
    isCall: boolean,
  ): string {
    if (toolId && VALID_TOOL_USE_ID_PATTERN.test(toolId)) {
      return toolId;
    }

    if (toolId) {
      const existing = this.mapping.get(toolId);
      if (existing !== undefined) {
        return existing;
      }
    }

    if (isCall || toolId) {
      const assignedId = this.getNextFallback();
      if (toolId) {
        this.mapping.set(toolId, assignedId);
      } else {
        if (toolName) {
          let queue = this.unpairedCallsByName.get(toolName);
          if (!queue) {
            queue = [];
            this.unpairedCallsByName.set(toolName, queue);
          }
          queue.push(assignedId);
        }
        this.unpairedCallsList.push(assignedId);
      }
      return assignedId;
    }

    if (toolName) {
      const queue = this.unpairedCallsByName.get(toolName);
      const assignedId = queue?.shift();
      if (assignedId !== undefined) {
        const listIndex = this.unpairedCallsList.indexOf(assignedId);
        if (listIndex !== -1) {
          this.unpairedCallsList.splice(listIndex, 1);
        }
        return assignedId;
      }
    }

    const assignedId = this.unpairedCallsList.shift();
    if (assignedId !== undefined) {
      for (const queue of this.unpairedCallsByName.values()) {
        const queueIndex = queue.indexOf(assignedId);
        if (queueIndex !== -1) {
          queue.splice(queueIndex, 1);
          break;
        }
      }
      return assignedId;
    }

    return this.getNextFallback();
  }
}

/**
 * Converts an ADK `Part` into an Anthropic content block parameter.
 *
 * A `thoughtSignature` on a text, function call or function response part is
 * dropped, because other models (such as Gemini) attach signatures to those
 * parts and Claude cannot verify them.
 */
export function partToMessageBlock(
  part: Part,
  sanitizer: ToolUseIdSanitizer = new ToolUseIdSanitizer(),
): ClaudeMessageBlockParam {
  if (part.thought) {
    throw new Error('Part kind "thought" is not supported by Claude.');
  }
  if (part.text) {
    return {
      type: 'text',
      text: part.text,
    };
  }
  if (part.functionCall) {
    if (!part.functionCall.name) {
      throw new Error('FunctionCall must have a name.');
    }
    return {
      type: 'tool_use',
      id: sanitizer.sanitize(
        part.functionCall.id,
        part.functionCall.name,
        true,
      ),
      name: part.functionCall.name,
      input: part.functionCall.args ?? {},
    };
  }
  if (part.functionResponse) {
    return {
      type: 'tool_result',
      tool_use_id: sanitizer.sanitize(
        part.functionResponse.id,
        part.functionResponse.name,
        false,
      ),
      content: formatFunctionResponseContent(part.functionResponse.response),
      is_error: false,
    };
  }
  throw new Error(
    `Part kind "${describeUnsupportedPartKind(part)}" is not supported by Claude.`,
  );
}

/**
 * Converts an ADK `Content` object into an Anthropic `MessageParam`.
 */
export function contentToMessageParam(
  content: Content,
  sanitizer: ToolUseIdSanitizer = new ToolUseIdSanitizer(),
): Anthropic.MessageParam {
  return {
    role: toClaudeRole(content.role),
    content: (content.parts ?? []).map((part) =>
      partToMessageBlock(part, sanitizer),
    ),
  };
}

/**
 * Converts an Anthropic response `ContentBlock` into an ADK `Part`.
 */
export function contentBlockToPart(contentBlock: Anthropic.ContentBlock): Part {
  if (contentBlock.type === 'text') {
    return {text: contentBlock.text};
  }
  if (contentBlock.type === 'tool_use') {
    if (!isPlainRecord(contentBlock.input)) {
      throw new Error(
        `ToolUseBlock input for "${contentBlock.name}" must be a JSON object.`,
      );
    }
    return {
      functionCall: {
        id: contentBlock.id,
        name: contentBlock.name,
        args: contentBlock.input,
      },
    };
  }
  throw new Error(
    `Content block type "${contentBlock.type}" is not supported by Claude.`,
  );
}

/**
 * Converts an Anthropic `Message` into an {@link LlmResponse}.
 */
export function messageToGenerateContentResponse(
  message: Anthropic.Message,
): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: message.content.map(contentBlockToPart),
    },
    finishReason: toGoogleGenaiFinishReason(message.stop_reason),
    usageMetadata: {
      promptTokenCount: message.usage.input_tokens,
      candidatesTokenCount: message.usage.output_tokens,
      totalTokenCount: message.usage.input_tokens + message.usage.output_tokens,
    },
  };
}

/**
 * Converts a `FunctionDeclaration` into an Anthropic `Tool` definition.
 */
export function functionDeclarationToToolParam(
  functionDeclaration: FunctionDeclaration,
): Anthropic.Tool {
  if (!functionDeclaration.name) {
    throw new Error('FunctionDeclaration must have a name.');
  }

  let inputSchema: Anthropic.Tool.InputSchema;
  if (isPlainRecord(functionDeclaration.parametersJsonSchema)) {
    const rawSchema = structuredClone(functionDeclaration.parametersJsonSchema);
    inputSchema = {
      ...rawSchema,
      type: 'object',
    };
  } else if (functionDeclaration.parameters) {
    const converted = genaiSchemaToJsonSchema(functionDeclaration.parameters);
    inputSchema = {
      properties: {},
      ...converted,
      type: 'object',
    };
  } else {
    inputSchema = {
      type: 'object',
      properties: {},
    };
  }

  return {
    name: functionDeclaration.name,
    description: functionDeclaration.description ?? '',
    input_schema: inputSchema,
  };
}

/**
 * Dynamically imports `@anthropic-ai/vertex-sdk` and constructs an
 * `AnthropicVertex` client configured from `GOOGLE_CLOUD_PROJECT` and
 * `GOOGLE_CLOUD_LOCATION`.
 */
export async function createAnthropicClient(): Promise<AnthropicVertex> {
  let AnthropicVertexClass: typeof AnthropicVertex;
  try {
    const vertexSdk = await import('@anthropic-ai/vertex-sdk');
    if (typeof vertexSdk.AnthropicVertex !== 'function') {
      throw new Error("Missing 'AnthropicVertex' export.");
    }
    AnthropicVertexClass = vertexSdk.AnthropicVertex;
  } catch (cause: unknown) {
    throw new Error(
      "Claude requires the optional '@anthropic-ai/vertex-sdk' package. " +
        'Install it with: npm install @anthropic-ai/sdk @anthropic-ai/vertex-sdk',
      {cause},
    );
  }

  const projectId = process.env['GOOGLE_CLOUD_PROJECT'];
  const region = process.env['GOOGLE_CLOUD_LOCATION'];
  if (!projectId || !region) {
    throw new Error(
      'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set for using Anthropic on Vertex.',
    );
  }

  return new AnthropicVertexClass({
    projectId,
    region,
  });
}
