/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  ContentUnion,
  GenerateContentConfig,
  Part,
  ToolUnion,
} from '@google/genai';
import type {AnyValue, AnyValueMap} from '@opentelemetry/api-logs';

import type {LlmRequest} from '../../../../models/llm_request.js';
import type {LlmResponse} from '../../../../models/llm_response.js';
import {toSnakeCaseName} from '../../../../utils/case_utils.js';
import {GenAiAttr} from './attributes.js';
import {toOutputMessageFinishReason} from './finish_reason.js';

const FUNCTION_TOOL_DEFINITION_TYPE = 'function';

/** Message content and tool definitions of one model call, by attribute key. */
export type OperationDetails = Partial<
  Record<
    | GenAiAttr.INPUT_MESSAGES
    | GenAiAttr.OUTPUT_MESSAGES
    | GenAiAttr.SYSTEM_INSTRUCTIONS
    | GenAiAttr.TOOL_DEFINITIONS,
    AnyValue[]
  >
>;

/**
 * Converts a value to OpenTelemetry's recursive log value type, replacing what
 * cannot be represented, and cycles, with `'<not serializable>'`.
 */
function toAnyValue(value: unknown, seen: ReadonlySet<object>): AnyValue {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value !== 'object' || seen.has(value)) {
    return '<not serializable>';
  }
  const nextSeen = new Set(seen).add(value);
  if (Array.isArray(value)) {
    return value.map((item) => toAnyValue(item, nextSeen));
  }
  const result: AnyValueMap = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = toAnyValue(item, nextSeen);
    }
  }
  return result;
}

function toOptionalMapping(value: unknown): AnyValue {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = toAnyValue(value, new Set());
  return typeof normalized === 'object' &&
    normalized !== null &&
    !Array.isArray(normalized) &&
    !(normalized instanceof Uint8Array)
    ? normalized
    : {value: normalized};
}

function toRole(role: string | undefined): string {
  if (role === 'user') {
    return 'user';
  }
  if (role === 'model') {
    return 'assistant';
  }
  return '';
}

function toMessagePart(part: Part, index: number): AnyValueMap | undefined {
  const fallbackId = (name: string | undefined) =>
    name ? `${name}_${index}` : `${index}`;

  if (part.text !== undefined) {
    return {content: part.text, type: 'text'};
  }
  if (part.inlineData) {
    // The payload bytes are not copied into telemetry.
    return {mime_type: part.inlineData.mimeType ?? '', type: 'blob'};
  }
  if (part.fileData) {
    return {
      mime_type: part.fileData.mimeType ?? '',
      uri: part.fileData.fileUri ?? '',
      type: 'file_data',
    };
  }
  if (part.functionCall) {
    const call = part.functionCall;
    return {
      id: call.id ?? fallbackId(call.name),
      name: call.name ?? '',
      arguments: toOptionalMapping(call.args),
      type: 'tool_call',
    };
  }
  if (part.functionResponse) {
    const response = part.functionResponse;
    return {
      id: response.id ?? fallbackId(response.name),
      response: toOptionalMapping(response.response),
      type: 'tool_call_response',
    };
  }
  return undefined;
}

function toMessageParts(parts: readonly Part[] | undefined): AnyValueMap[] {
  return (parts ?? []).flatMap((part, index) => {
    const converted = toMessagePart(part, index);
    return converted ? [converted] : [];
  });
}

function toInputMessage(content: Content): AnyValueMap {
  return {role: toRole(content.role), parts: toMessageParts(content.parts)};
}

function isContent(value: Content | Part): value is Content {
  return 'parts' in value || 'role' in value;
}

function toParts(instruction: ContentUnion): Part[] {
  if (typeof instruction === 'string') {
    return [{text: instruction}];
  }
  if (Array.isArray(instruction)) {
    return instruction.map((part) =>
      typeof part === 'string' ? {text: part} : part,
    );
  }
  return isContent(instruction) ? (instruction.parts ?? []) : [instruction];
}

function toSystemInstructions(
  config: GenerateContentConfig | undefined,
): AnyValueMap[] {
  if (!config?.systemInstruction) {
    return [];
  }
  return toMessageParts(toParts(config.systemInstruction));
}

function toToolDefinitions(tool: ToolUnion): AnyValueMap[] {
  if (!('functionDeclarations' in tool) && 'callTool' in tool) {
    return [{name: 'UnserializableTool', type: 'CallableTool'}];
  }
  const definitions: AnyValueMap[] = [];
  for (const declaration of tool.functionDeclarations ?? []) {
    const parameters =
      declaration.parameters ?? declaration.parametersJsonSchema;
    definitions.push({
      name: declaration.name ?? 'FunctionDeclaration',
      description: declaration.description,
      parameters:
        parameters === undefined ? null : toOptionalMapping(parameters),
      type: FUNCTION_TOOL_DEFINITION_TYPE,
    });
  }
  for (const [key, value] of Object.entries(tool)) {
    if (key !== 'functionDeclarations' && value !== undefined) {
      const toolType = toSnakeCaseName(key);
      definitions.push({name: toolType, type: toolType});
    }
  }
  return definitions;
}

/**
 * Builds the operation details a model request contributes: input messages,
 * system instructions and tool definitions.
 */
export function buildRequestOperationDetails(
  llmRequest: LlmRequest,
): OperationDetails {
  return {
    [GenAiAttr.INPUT_MESSAGES]: llmRequest.contents.map(toInputMessage),
    [GenAiAttr.SYSTEM_INSTRUCTIONS]: toSystemInstructions(llmRequest.config),
    [GenAiAttr.TOOL_DEFINITIONS]: (llmRequest.config?.tools ?? []).flatMap(
      toToolDefinitions,
    ),
  };
}

/**
 * Builds the output message for one model response, or `undefined` when it
 * carries no content.
 */
export function buildOutputMessage(
  llmResponse: LlmResponse,
): AnyValueMap | undefined {
  if (!llmResponse.content) {
    return undefined;
  }
  return {
    ...toInputMessage(llmResponse.content),
    finish_reason: toOutputMessageFinishReason(llmResponse.finishReason),
  };
}

/**
 * Returns the view of the operation details that carries no message content:
 * the tool definitions without their parameter schemas.
 */
export function withoutContent(details: OperationDetails): OperationDetails {
  const toolDefinitions = details[GenAiAttr.TOOL_DEFINITIONS];
  if (!toolDefinitions?.length) {
    return {};
  }
  return {
    [GenAiAttr.TOOL_DEFINITIONS]: toolDefinitions.map((definition) => {
      if (
        typeof definition !== 'object' ||
        definition === null ||
        Array.isArray(definition) ||
        definition instanceof Uint8Array ||
        !('parameters' in definition)
      ) {
        return definition;
      }
      const {parameters: _parameters, ...rest} = definition;
      return rest;
    }),
  };
}
