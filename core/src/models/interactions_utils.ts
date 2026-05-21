/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  FinishReason,
  FunctionCall,
  FunctionResponse,
  GenerateContentConfig,
  GoogleGenAI,
  Outcome,
  Part,
} from '@google/genai';
import {base64Encode, isBrowser} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

// --- Helper Interfaces for Strong Typing ---

interface ExtendedPart extends Part {
  thoughtSignature?: string | Uint8Array | null;
  thought?: boolean;
}

interface ExtendedTool {
  functionDeclarations?: Array<{
    name: string;
    description?: string;
    parameters?: {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    parametersJsonSchema?: unknown;
  }>;
  googleSearch?: unknown;
  codeExecution?: unknown;
  urlContext?: unknown;
}

interface InteractionTextContent {
  type: 'text';
  text: string;
}

interface InteractionFunctionCall {
  type: 'function_call';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thought_signature?: string;
}

interface InteractionFunctionResult {
  type: 'function_result';
  name: string;
  call_id: string;
  result: unknown;
}

interface InteractionMediaContent {
  type: 'image' | 'audio' | 'video' | 'document';
  data?: string;
  uri?: string;
  mime_type: string;
}

interface InteractionThought {
  type: 'thought';
  signature?: string;
}

interface InteractionCodeExecutionCall {
  type: 'code_execution_call';
  id: string;
  arguments: {
    code: string;
    language: string;
  };
}

interface InteractionCodeExecutionResult {
  type: 'code_execution_result';
  call_id: string;
  result: string;
  is_error: boolean;
}

type InteractionContent =
  | InteractionTextContent
  | InteractionFunctionCall
  | InteractionFunctionResult
  | InteractionMediaContent
  | InteractionThought
  | InteractionCodeExecutionCall
  | InteractionCodeExecutionResult;

interface InteractionTurn {
  role: string;
  content: InteractionContent[];
}

interface InteractionTool {
  type: 'function' | 'google_search' | 'code_execution' | 'url_context';
  name?: string;
  description?: string;
  parameters?: unknown;
}

interface InteractionResponse {
  id: string;
  status: 'completed' | 'requires_action' | 'failed' | string;
  error?: {
    code: string;
    message: string;
  };
  outputs?: Record<string, unknown>[];
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
  };
}

interface InteractionSSEEvent {
  event_type?: string;
  eventType?: string;
  delta?: {
    type: string;
    text?: string;
    name?: string;
    id?: string;
    arguments?: Record<string, unknown>;
    thought_signature?: string;
    data?: string;
    uri?: string;
    mime_type: string;
  };
  status?: string;
  error?: {
    code: string;
    message: string;
  };
  code?: string;
  message?: string;
  interaction_id?: string;
  interactionId?: string;
  interaction?: {
    id: string;
  };
  id?: string;
}

interface GoogleGenAIWithInteractions extends GoogleGenAI {
  interactions: {
    create(params: {
      model?: string;
      input: InteractionTurn[];
      stream: boolean;
      systemInstruction?: string;
      tools?: InteractionTool[];
      generationConfig?: Record<string, unknown>;
      previousInteractionId?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }): Promise<any>; // We keep 'any' here as the SDK return type is complex (stream vs non-stream)
  };
}

// --- Helper Functions ---

/**
 * Helper to determine interaction media type from mimeType string.
 */
function getInteractionMediaType(
  mimeType: string,
): 'image' | 'audio' | 'video' | 'document' {
  if (mimeType.startsWith('image/')) {
    return 'image';
  } else if (mimeType.startsWith('audio/')) {
    return 'audio';
  } else if (mimeType.startsWith('video/')) {
    return 'video';
  } else {
    return 'document';
  }
}

/**
 * Extracts the latest turn contents for interactions API.
 */
export function getLatestUserContents(contents: Content[]): Content[] {
  if (!contents || contents.length === 0) {
    return [];
  }

  // Find the latest continuous user messages from the end
  const latestUserContents: Content[] = [];
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (content.role === 'user') {
      latestUserContents.unshift(content);
    } else {
      // Stop when we hit a non-user message
      break;
    }
  }

  // Check if the user contents contain a function_result
  let hasFunctionResult = false;
  for (const content of latestUserContents) {
    if (content.parts) {
      for (const part of content.parts) {
        if (
          part.functionResponse !== undefined &&
          part.functionResponse !== null
        ) {
          hasFunctionResult = true;
          break;
        }
      }
    }
    if (hasFunctionResult) {
      break;
    }
  }

  // If we have a function_result, we also need the preceding model content
  // with the function_call so the API can match the call_id
  if (hasFunctionResult && contents.length > latestUserContents.length) {
    const userStartIdx = contents.length - latestUserContents.length;
    if (userStartIdx > 0) {
      const precedingContent = contents[userStartIdx - 1];
      if (precedingContent.role === 'model' && precedingContent.parts) {
        for (const part of precedingContent.parts) {
          if (part.functionCall !== undefined && part.functionCall !== null) {
            return [precedingContent, ...latestUserContents];
          }
        }
      }
    }
  }

  return latestUserContents;
}

/**
 * Convert a Part to an interaction content object.
 */
export function convertPartToInteractionContent(
  part: Part,
): InteractionContent | null {
  const extPart = part as ExtendedPart;

  if (extPart.text !== undefined && extPart.text !== null) {
    return {type: 'text', text: extPart.text};
  }

  if (extPart.functionCall !== undefined && extPart.functionCall !== null) {
    const result: InteractionFunctionCall = {
      type: 'function_call',
      id: extPart.functionCall.id || '',
      name: extPart.functionCall.name,
      arguments: (extPart.functionCall.args as Record<string, unknown>) || {},
    };
    if (
      extPart.thoughtSignature !== undefined &&
      extPart.thoughtSignature !== null
    ) {
      result['thought_signature'] = base64Encode(extPart.thoughtSignature);
    }
    return result;
  }

  if (
    extPart.functionResponse !== undefined &&
    extPart.functionResponse !== null
  ) {
    let resultValue: unknown = extPart.functionResponse.response;
    if (
      typeof resultValue !== 'object' &&
      typeof resultValue !== 'string' &&
      !Array.isArray(resultValue)
    ) {
      resultValue = String(resultValue);
    }
    logger.debug(
      `Converting function_response: name=${extPart.functionResponse.name}, call_id=${extPart.functionResponse.id}`,
    );
    return {
      type: 'function_result',
      name: extPart.functionResponse.name || '',
      call_id: extPart.functionResponse.id || '',
      result: resultValue,
    };
  }

  if (extPart.inlineData !== undefined && extPart.inlineData !== null) {
    const mimeType = extPart.inlineData.mimeType || '';
    return {
      type: getInteractionMediaType(mimeType),
      data: extPart.inlineData.data,
      mime_type: mimeType,
    };
  }

  if (extPart.fileData !== undefined && extPart.fileData !== null) {
    const mimeType = extPart.fileData.mimeType || '';
    return {
      type: getInteractionMediaType(mimeType),
      uri: extPart.fileData.fileUri,
      mime_type: mimeType,
    };
  }

  if (extPart.thought) {
    const result: InteractionThought = {type: 'thought'};
    if (
      extPart.thoughtSignature !== undefined &&
      extPart.thoughtSignature !== null
    ) {
      result['signature'] = base64Encode(extPart.thoughtSignature);
    }
    return result;
  }

  if (
    extPart.codeExecutionResult !== undefined &&
    extPart.codeExecutionResult !== null
  ) {
    const isError =
      extPart.codeExecutionResult.outcome === Outcome.OUTCOME_FAILED ||
      extPart.codeExecutionResult.outcome === Outcome.OUTCOME_DEADLINE_EXCEEDED;
    return {
      type: 'code_execution_result',
      call_id: '',
      result: extPart.codeExecutionResult.output || '',
      is_error: isError,
    };
  }

  if (extPart.executableCode !== undefined && extPart.executableCode !== null) {
    return {
      type: 'code_execution_call',
      id: '',
      arguments: {
        code: extPart.executableCode.code,
        language: extPart.executableCode.language,
      },
    };
  }

  return null;
}

/**
 * Convert a Content to a TurnParam object.
 */
export function convertContentToTurn(content: Content): InteractionTurn {
  const contents: InteractionContent[] = [];
  if (content.parts) {
    for (const part of content.parts) {
      const interactionContent = convertPartToInteractionContent(part);
      if (interactionContent) {
        contents.push(interactionContent);
      }
    }
  }

  return {
    role: content.role || 'user',
    content: contents,
  };
}

/**
 * Convert a list of Content objects to turns.
 */
export function convertContentsToTurns(contents: Content[]): InteractionTurn[] {
  const turns: InteractionTurn[] = [];
  for (const content of contents) {
    const turn = convertContentToTurn(content);
    if (turn.content && turn.content.length > 0) {
      turns.push(turn);
    }
  }
  return turns;
}

/**
 * Convert tools config to interactions format.
 */
export function convertToolsConfigToInteractionsFormat(
  config: GenerateContentConfig,
): InteractionTool[] {
  if (!config.tools) {
    return [];
  }

  const interactionTools: InteractionTool[] = [];
  for (const tool of config.tools) {
    const t = tool as ExtendedTool;
    if (t.functionDeclarations) {
      for (const funcDecl of t.functionDeclarations) {
        const funcTool: InteractionTool = {
          type: 'function',
          name: funcDecl.name,
        };
        if (funcDecl.description) {
          funcTool['description'] = funcDecl.description;
        }
        if (funcDecl.parameters) {
          if (funcDecl.parameters.properties) {
            const props: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(
              funcDecl.parameters.properties,
            )) {
              props[k] = JSON.parse(JSON.stringify(v));
            }
            funcTool['parameters'] = {
              type: 'object',
              properties: props,
              required: funcDecl.parameters.required
                ? [...funcDecl.parameters.required]
                : undefined,
            };
          }
        } else if (funcDecl.parametersJsonSchema) {
          funcTool['parameters'] = funcDecl.parametersJsonSchema;
        }
        interactionTools.push(funcTool);
      }
    }

    if (t.googleSearch) {
      interactionTools.push({type: 'google_search'});
    }

    if (t.codeExecution) {
      interactionTools.push({type: 'code_execution'});
    }

    if (t.urlContext) {
      interactionTools.push({type: 'url_context'});
    }
  }

  return interactionTools;
}

/**
 * Convert interaction output to a Part.
 */
export function convertInteractionOutputToPart(
  output: Record<string, unknown>,
): Part | null {
  if (!output || !output.type) {
    return null;
  }

  const outputType = output.type as string;

  if (outputType === 'text') {
    return {text: (output.text as string) || ''};
  }

  if (outputType === 'function_call') {
    logger.debug(
      `Converting function_call output: name=${output.name}, id=${output.id}`,
    );
    let thoughtSignature: Uint8Array | undefined = undefined;
    const thoughtSigValue = output.thought_signature;
    if (thoughtSigValue && typeof thoughtSigValue === 'string') {
      if (isBrowser()) {
        // eslint-disable-next-line no-undef
        const binaryString = window.atob(thoughtSigValue);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        thoughtSignature = bytes;
      } else {
        thoughtSignature = Buffer.from(thoughtSigValue, 'base64');
      }
    }
    return {
      functionCall: {
        id: output.id as string,
        name: output.name as string,
        args: (output.arguments as Record<string, unknown>) || {},
      } as FunctionCall,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      thoughtSignature: thoughtSignature as any, // Keep any here if Part thoughtSignature is strict
    };
  }

  if (outputType === 'function_result') {
    const result = output.result;
    return {
      functionResponse: {
        id: output.call_id as string,
        response: result,
      } as FunctionResponse,
    };
  }

  if (outputType === 'image') {
    if (output.data) {
      return {
        inlineData: {
          data: output.data as string,
          mimeType: output.mime_type as string,
        },
      };
    } else if (output.uri) {
      return {
        fileData: {
          fileUri: output.uri as string,
          mimeType: output.mime_type as string,
        },
      };
    }
  }

  if (outputType === 'audio') {
    if (output.data) {
      return {
        inlineData: {
          data: output.data as string,
          mimeType: output.mime_type as string,
        },
      };
    } else if (output.uri) {
      return {
        fileData: {
          fileUri: output.uri as string,
          mimeType: output.mime_type as string,
        },
      };
    }
  }

  if (outputType === 'thought') {
    return null;
  }

  if (outputType === 'code_execution_result') {
    return {
      codeExecutionResult: {
        output: (output.result as string) || '',
        outcome: output.is_error ? Outcome.OUTCOME_FAILED : Outcome.OUTCOME_OK,
      },
    };
  }

  if (outputType === 'code_execution_call') {
    const args = (output.arguments as Record<string, string>) || {};
    return {
      executableCode: {
        code: args.code || '',
        language: args.language || 'PYTHON',
      },
    };
  }

  if (outputType === 'google_search_result') {
    if (output.result && Array.isArray(output.result)) {
      const resultsText = output.result
        .filter((r) => r)
        .map((r) => (typeof r === 'object' ? JSON.stringify(r) : String(r)))
        .join('\n');
      return {text: resultsText};
    }
  }

  return null;
}

/**
 * Convert Interaction response to an LlmResponse.
 */
export function convertInteractionToLlmResponse(
  interaction: InteractionResponse,
): LlmResponse {
  if (interaction.status === 'failed') {
    let errorMsg = 'Unknown error';
    let errorCode = 'UNKNOWN_ERROR';
    if (interaction.error) {
      errorMsg = interaction.error.message || errorMsg;
      errorCode = interaction.error.code || errorCode;
    }
    return {
      errorCode: errorCode,
      errorMessage: errorMsg,
      interactionId: interaction.id,
    };
  }

  const parts: Part[] = [];
  if (interaction.outputs) {
    for (const output of interaction.outputs) {
      const part = convertInteractionOutputToPart(output);
      if (part) {
        parts.push(part);
      }
    }
  }

  let content: Content | undefined = undefined;
  if (parts.length > 0) {
    content = {role: 'model', parts: parts};
  }

  let usageMetadata: LlmResponse['usageMetadata'] = undefined;
  if (interaction.usage) {
    const inputTokens = interaction.usage.total_input_tokens || 0;
    const outputTokens = interaction.usage.total_output_tokens || 0;
    usageMetadata = {
      promptTokenCount: inputTokens,
      candidatesTokenCount: outputTokens,
      totalTokenCount: inputTokens + outputTokens,
    };
  }

  let finishReason: FinishReason | undefined = undefined;
  if (
    interaction.status === 'completed' ||
    interaction.status === 'requires_action'
  ) {
    finishReason = 'STOP' as FinishReason;
  }

  return {
    content: content,
    usageMetadata: usageMetadata,
    finishReason: finishReason,
    turnComplete:
      interaction.status === 'completed' ||
      interaction.status === 'requires_action',
    interactionId: interaction.id,
  };
}

/**
 * Convert InteractionSSEEvent to LlmResponse.
 */
export function convertInteractionEventToLlmResponse(
  event: InteractionSSEEvent,
  aggregatedParts: Part[],
  interactionId?: string,
): LlmResponse | null {
  const eventType = event.event_type || event.eventType;

  if (eventType === 'content.delta') {
    const delta = event.delta;
    if (!delta) {
      return null;
    }

    const deltaType = delta.type;

    if (deltaType === 'text') {
      const text = delta.text || '';
      if (text) {
        const part: Part = {text: text};
        aggregatedParts.push(part);
        return {
          content: {role: 'model', parts: [part]},
          partial: true,
          turnComplete: false,
          interactionId: interactionId,
        };
      }
    } else if (deltaType === 'function_call') {
      if (delta.name) {
        let thoughtSignature: Uint8Array | undefined = undefined;
        const thoughtSigValue = delta.thought_signature;
        if (thoughtSigValue && typeof thoughtSigValue === 'string') {
          if (isBrowser()) {
            // eslint-disable-next-line no-undef
            const binaryString = window.atob(thoughtSigValue);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            thoughtSignature = bytes;
          } else {
            thoughtSignature = Buffer.from(thoughtSigValue, 'base64');
          }
        }
        const part: Part = {
          functionCall: {
            id: delta.id || '',
            name: delta.name,
            args: delta.arguments || {},
          } as FunctionCall,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          thoughtSignature: thoughtSignature as any,
        };
        aggregatedParts.push(part);
        return null;
      }
    } else if (deltaType === 'image') {
      if (delta.data || delta.uri) {
        let part: Part;
        if (delta.data) {
          part = {
            inlineData: {
              data: delta.data,
              mimeType: delta.mime_type,
            },
          };
        } else {
          part = {
            fileData: {
              fileUri: delta.uri,
              mimeType: delta.mime_type,
            },
          };
        }
        aggregatedParts.push(part);
        return {
          content: {role: 'model', parts: [part]},
          partial: false,
          turnComplete: false,
          interactionId: interactionId,
        };
      }
    }
  } else if (eventType === 'content.stop') {
    if (aggregatedParts.length > 0) {
      return {
        content: {role: 'model', parts: [...aggregatedParts]},
        partial: false,
        turnComplete: false,
        interactionId: interactionId,
      };
    }
  } else if (eventType === 'interaction') {
    return convertInteractionToLlmResponse(
      event as unknown as InteractionResponse,
    );
  } else if (eventType === 'interaction.status_update') {
    const status = event.status;
    if (status === 'completed' || status === 'requires_action') {
      return {
        content:
          aggregatedParts.length > 0
            ? {role: 'model', parts: [...aggregatedParts]}
            : undefined,
        partial: false,
        turnComplete: true,
        finishReason: 'STOP' as FinishReason,
        interactionId: interactionId,
      };
    } else if (status === 'failed') {
      const error = event.error;
      return {
        errorCode: error ? error.code : 'UNKNOWN_ERROR',
        errorMessage: error ? error.message : 'Unknown error',
        turnComplete: true,
        interactionId: interactionId,
      };
    }
  } else if (eventType === 'error') {
    return {
      errorCode: event.code || 'UNKNOWN_ERROR',
      errorMessage: event.message || 'Unknown error',
      turnComplete: true,
      interactionId: interactionId,
    };
  }

  return null;
}

/**
 * Build generation config.
 */
export function buildGenerationConfig(
  config: GenerateContentConfig,
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {};
  if (config.temperature !== undefined && config.temperature !== null) {
    generationConfig['temperature'] = config.temperature;
  }
  if (config.topP !== undefined && config.topP !== null) {
    generationConfig['top_p'] = config.topP;
  }
  if (config.topK !== undefined && config.topK !== null) {
    generationConfig['top_k'] = config.topK;
  }
  if (config.maxOutputTokens !== undefined && config.maxOutputTokens !== null) {
    generationConfig['max_output_tokens'] = config.maxOutputTokens;
  }
  if (config.stopSequences) {
    generationConfig['stop_sequences'] = config.stopSequences;
  }
  if (config.presencePenalty !== undefined && config.presencePenalty !== null) {
    generationConfig['presence_penalty'] = config.presencePenalty;
  }
  if (
    config.frequencyPenalty !== undefined &&
    config.frequencyPenalty !== null
  ) {
    generationConfig['frequency_penalty'] = config.frequencyPenalty;
  }
  return generationConfig;
}

/**
 * Extract system instruction.
 */
export function extractSystemInstruction(
  config: GenerateContentConfig,
): string | undefined {
  const systemInstruction = config.systemInstruction;
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
      const p = part as Part;
      if (p.text) {
        texts.push(p.text);
      }
    }
    return texts.length > 0 ? texts.join('\n') : undefined;
  }

  return undefined;
}

/**
 * Extract stream interaction ID helper.
 */
function extractStreamInteractionId(
  event: InteractionSSEEvent,
): string | undefined {
  if (event.interaction_id || event.interactionId) {
    return event.interaction_id || event.interactionId;
  }

  if (event.interaction && event.interaction.id) {
    return event.interaction.id;
  }

  if (event.event_type === 'interaction' || event.eventType === 'interaction') {
    return event.id;
  }

  return undefined;
}

/**
 * Generate content using the interactions API.
 */
export async function* generateContentViaInteractions(
  apiClient: GoogleGenAI,
  llmRequest: LlmRequest,
  stream: boolean,
): AsyncGenerator<LlmResponse, void, void> {
  let contents = llmRequest.contents;
  if (llmRequest.previousInteractionId && contents) {
    contents = getLatestUserContents(contents);
  }

  const inputTurns = convertContentsToTurns(contents);
  const interactionTools = convertToolsConfigToInteractionsFormat(
    llmRequest.config || {},
  );
  const systemInstruction = extractSystemInstruction(llmRequest.config || {});
  const generationConfig = buildGenerationConfig(llmRequest.config || {});
  const previousInteractionId = llmRequest.previousInteractionId;

  logger.info(
    `Sending request via interactions API, model: ${llmRequest.model}, stream: ${stream}, previous_interaction_id: ${previousInteractionId}`,
  );

  let currentInteractionId = previousInteractionId;
  const clientWithInteractions = apiClient as GoogleGenAIWithInteractions;

  if (stream) {
    const responses = await clientWithInteractions.interactions.create({
      model: llmRequest.model,
      input: inputTurns,
      stream: true,
      systemInstruction: systemInstruction,
      tools: interactionTools.length > 0 ? interactionTools : undefined,
      generationConfig:
        Object.keys(generationConfig).length > 0 ? generationConfig : undefined,
      previousInteractionId: previousInteractionId,
    });

    const aggregatedParts: Part[] = [];
    for await (const event of responses) {
      const sseEvent = event as InteractionSSEEvent;
      const interactionId = extractStreamInteractionId(sseEvent);
      if (interactionId) {
        currentInteractionId = interactionId;
      }
      const llmResponse = convertInteractionEventToLlmResponse(
        sseEvent,
        aggregatedParts,
        currentInteractionId,
      );
      if (llmResponse) {
        yield llmResponse;
      }
    }

    if (aggregatedParts.length > 0) {
      yield {
        content: {role: 'model', parts: aggregatedParts},
        partial: false,
        turnComplete: true,
        finishReason: 'STOP' as FinishReason,
        interactionId: currentInteractionId,
      };
    }
  } else {
    const interaction = await clientWithInteractions.interactions.create({
      model: llmRequest.model,
      input: inputTurns,
      stream: false,
      systemInstruction: systemInstruction,
      tools: interactionTools.length > 0 ? interactionTools : undefined,
      generationConfig:
        Object.keys(generationConfig).length > 0 ? generationConfig : undefined,
      previousInteractionId: previousInteractionId,
    });

    logger.info('Interaction response received from the model.');
    yield convertInteractionToLlmResponse(interaction as InteractionResponse);
  }
}
