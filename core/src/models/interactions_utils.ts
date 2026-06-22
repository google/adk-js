/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  Content,
  FinishReason,
  GenerateContentConfig,
  GoogleGenAI,
  Interactions,
  Language,
  Outcome,
  Part,
  Tool,
} from '@google/genai';
import {logger} from '../utils/logger.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

// --- Helper Interfaces for Strong Typing ---

export interface ExtendedInteraction extends Interactions.Interaction {
  error?: {
    code: string;
    message: string;
  };
}

export interface ExtendedInteractionStatusUpdate extends Omit<
  Interactions.InteractionStatusUpdate,
  'error'
> {
  error?: {
    code: string;
    message: string;
  };
}

export interface ExtendedFunctionCallStep
  extends Interactions.FunctionCallStep {
  signature?: string;
}

// Runtime event types can be more relaxed than compile-time
export interface ExtendedInteractionSSEEvent extends Omit<
  Interactions.InteractionSSEEvent,
  'error' | 'interaction_id' | 'status' | 'event_type'
> {
  event_type?: string;
  eventType?: string;
  delta?: {
    type: string;
    text?: string;
    name?: string;
    id?: string;
    arguments?: Record<string, unknown>;
    thought_signature?: string;
    signature?: string;
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

// --- Helper Functions ---

/**
 * Helper to determine interaction media type from mimeType string.
 */
function getInteractionMediaType(
  mimeType: string,
): 'image' | 'audio' | 'video' | 'document' {
  switch (mimeType.split('/')[0]) {
    case 'image':
      return 'image';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    default:
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
 * Convert a Part to a media content object (Interactions.Content).
 */
function convertPartToMediaContent(part: Part): Interactions.Content | null {
  if (part.text !== undefined && part.text !== null) {
    return {type: 'text', text: part.text};
  }

  if (part.inlineData !== undefined && part.inlineData !== null) {
    const mimeType = part.inlineData.mimeType || '';
    return {
      type: getInteractionMediaType(mimeType),
      data: part.inlineData.data,
      mime_type: mimeType,
    } as Interactions.Content;
  }

  if (part.fileData !== undefined && part.fileData !== null) {
    const mimeType = part.fileData.mimeType || '';
    return {
      type: getInteractionMediaType(mimeType),
      uri: part.fileData.fileUri,
      mime_type: mimeType,
    } as Interactions.Content;
  }

  return null;
}

/**
 * Convert a Content to a list of Steps.
 */
export function convertContentToSteps(content: Content): Interactions.Step[] {
  const steps: Interactions.Step[] = [];
  const role = content.role || 'user';

  if (role === 'user') {
    const mediaContents: Interactions.Content[] = [];
    if (content.parts) {
      for (const part of content.parts) {
        if (part.functionResponse) {
          steps.push({
            type: 'function_result',
            call_id: part.functionResponse.id || '',
            name: part.functionResponse.name || '',
            result: part.functionResponse.response,
          } as Interactions.FunctionResultStep);
        } else if (part.codeExecutionResult) {
          const isError =
            part.codeExecutionResult.outcome === Outcome.OUTCOME_FAILED ||
            part.codeExecutionResult.outcome ===
              Outcome.OUTCOME_DEADLINE_EXCEEDED;
          steps.push({
            type: 'code_execution_result',
            call_id: '',
            result: part.codeExecutionResult.output || '',
            is_error: isError,
          } as Interactions.CodeExecutionResultStep);
        } else {
          const mediaContent = convertPartToMediaContent(part);
          if (mediaContent) {
            mediaContents.push(mediaContent);
          }
        }
      }
    }
    if (mediaContents.length > 0) {
      steps.push({
        type: 'user_input',
        content: mediaContents,
      } as Interactions.UserInputStep);
    }
  } else if (role === 'model') {
    const mediaContents: Interactions.Content[] = [];
    if (content.parts) {
      for (const part of content.parts) {
        if (part.functionCall) {
          const step: ExtendedFunctionCallStep = {
            type: 'function_call',
            id: part.functionCall.id || '',
            name: part.functionCall.name || '',
            arguments:
              (part.functionCall.args as Record<string, unknown>) || {},
          };
          if (part.thoughtSignature) {
            step.signature = part.thoughtSignature;
          }
          steps.push(step);
        } else if (part.executableCode) {
          steps.push({
            type: 'code_execution_call',
            id: '',
            arguments: {
              code: part.executableCode.code || '',
              language: 'python',
            },
          } as Interactions.CodeExecutionCallStep);
        } else if (part.thought) {
          const step: Interactions.ThoughtStep = {
            type: 'thought',
          };
          if (part.thoughtSignature) {
            step.signature = part.thoughtSignature;
          }
          steps.push(step);
        } else {
          const mediaContent = convertPartToMediaContent(part);
          if (mediaContent) {
            mediaContents.push(mediaContent);
          }
        }
      }
    }
    if (mediaContents.length > 0) {
      steps.push({
        type: 'model_output',
        content: mediaContents,
      } as Interactions.ModelOutputStep);
    }
  }

  return steps;
}

/**
 * Convert a media content (Interactions.Content) to a Part.
 */
function convertMediaContentToPart(content: Interactions.Content): Part | null {
  if (content.type === 'text') {
    return {text: content.text || ''};
  }

  if (
    content.type === 'image' ||
    content.type === 'audio' ||
    content.type === 'video' ||
    content.type === 'document'
  ) {
    const media = content as {
      data?: string;
      uri?: string;
      mime_type?: string;
    };
    if (media.data) {
      return {
        inlineData: {
          data: media.data,
          mimeType: media.mime_type || '',
        },
      };
    } else if (media.uri) {
      return {
        fileData: {
          fileUri: media.uri,
          mimeType: media.mime_type || '',
        },
      };
    }
  }
  return null;
}

/**
 * Convert a Step to a list of Parts.
 */
export function convertStepToParts(step: Interactions.Step): Part[] {
  if (!step || !step.type) {
    return [];
  }

  switch (step.type) {
    case 'model_output': {
      const modelOutputStep = step as Interactions.ModelOutputStep;
      const parts: Part[] = [];
      if (modelOutputStep.content) {
        for (const content of modelOutputStep.content) {
          const part = convertMediaContentToPart(content);
          if (part) {
            parts.push(part);
          }
        }
      }
      return parts;
    }
    case 'user_input': {
      const userInputStep = step as Interactions.UserInputStep;
      const parts: Part[] = [];
      if (userInputStep.content) {
        for (const content of userInputStep.content) {
          const part = convertMediaContentToPart(content);
          if (part) {
            parts.push(part);
          }
        }
      }
      return parts;
    }
    case 'function_call': {
      const functionCallStep = step as ExtendedFunctionCallStep;
      const part: Part = {
        functionCall: {
          id: functionCallStep.id,
          name: functionCallStep.name,
          args: functionCallStep.arguments || {},
        },
      };
      if (functionCallStep.signature) {
        part.thoughtSignature = functionCallStep.signature;
      }
      return [part];
    }
    case 'function_result': {
      const functionResultStep = step as Interactions.FunctionResultStep;
      const result = functionResultStep.result;
      return [
        {
          functionResponse: {
            id: functionResultStep.call_id,
            name: functionResultStep.name || '',
            response:
              typeof result === 'object' && result !== null
                ? (result as Record<string, unknown>)
                : {output: result},
          },
        },
      ];
    }
    case 'code_execution_call': {
      const codeExecutionCallStep = step as Interactions.CodeExecutionCallStep;
      const args = codeExecutionCallStep.arguments || {};
      return [
        {
          executableCode: {
            code: args.code || '',
            language: (args.language || 'PYTHON').toUpperCase() as Language,
          },
        },
      ];
    }
    case 'code_execution_result': {
      const codeExecutionResultStep =
        step as Interactions.CodeExecutionResultStep;
      return [
        {
          codeExecutionResult: {
            output: codeExecutionResultStep.result || '',
            outcome: codeExecutionResultStep.is_error
              ? Outcome.OUTCOME_FAILED
              : Outcome.OUTCOME_OK,
          },
        },
      ];
    }
    case 'thought': {
      const thoughtStep = step as Interactions.ThoughtStep;
      const part: Part = {
        thought: true,
      };
      if (thoughtStep.signature) {
        part.thoughtSignature = thoughtStep.signature;
      }
      return [part];
    }
    default:
      return [];
  }
}

/**
 * Convert tools config to interactions format.
 */
export function convertToolsConfigToInteractionsFormat(
  config: GenerateContentConfig,
): Interactions.Tool[] {
  if (!config.tools) {
    return [];
  }

  const interactionTools: Interactions.Tool[] = [];
  for (const tool of config.tools) {
    const t = tool as Tool;
    if (t.functionDeclarations) {
      for (const funcDecl of t.functionDeclarations) {
        const funcTool: {
          type: 'function';
          name: string;
          description?: string;
          parameters?: unknown;
        } = {
          type: 'function',
          name: funcDecl.name!,
        };
        if (funcDecl.description) {
          funcTool.description = funcDecl.description;
        }
        if (funcDecl.parameters) {
          if (funcDecl.parameters.properties) {
            const props: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(
              funcDecl.parameters.properties,
            )) {
              props[k] = JSON.parse(JSON.stringify(v));
            }
            funcTool.parameters = {
              type: 'object',
              properties: props,
              required: funcDecl.parameters.required
                ? [...funcDecl.parameters.required]
                : undefined,
            };
          }
        } else if (funcDecl.parametersJsonSchema) {
          funcTool.parameters = funcDecl.parametersJsonSchema;
        }
        interactionTools.push(funcTool as Interactions.Tool);
      }
    }

    if (t.googleSearch) {
      interactionTools.push({type: 'google_search'} as Interactions.Tool);
    }

    if (t.codeExecution) {
      interactionTools.push({type: 'code_execution'} as Interactions.Tool);
    }

    if (t.urlContext) {
      interactionTools.push({type: 'url_context'} as Interactions.Tool);
    }
  }

  return interactionTools;
}

/**
 * Helper to find the last element in an array matching a predicate.
 */
function findLastPart(
  parts: Part[],
  predicate: (p: Part) => boolean,
): Part | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (predicate(parts[i])) {
      return parts[i];
    }
  }
  return undefined;
}

/**
 * Extract the latest model generated parts from a list of steps.
 */
export function getLatestModelParts(steps: Interactions.Step[]): Part[] {
  if (!steps || steps.length === 0) {
    return [];
  }

  const latestParts: Part[] = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (
      step.type === 'user_input' ||
      step.type === 'function_result' ||
      step.type === 'code_execution_result'
    ) {
      break;
    }
    const parts = convertStepToParts(step);
    latestParts.unshift(...parts);
  }
  return latestParts;
}

/**
 * Convert Interaction response to an LlmResponse.
 */
export function convertInteractionToLlmResponse(
  interaction: ExtendedInteraction,
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

  const parts = getLatestModelParts(interaction.steps || []);

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
  event: ExtendedInteractionSSEEvent,
  aggregatedParts: Part[],
  interactionId?: string,
): LlmResponse | null {
  const eventType = event.event_type || event.eventType;

  if (eventType === 'step.start') {
    const stepStart = event as unknown as Interactions.StepStart;
    const step = stepStart.step;
    if (step.type === 'function_call') {
      const fcStep = step as ExtendedFunctionCallStep;
      const part: Part = {
        functionCall: {
          id: fcStep.id,
          name: fcStep.name,
          args: {},
        },
        partMetadata: {
          accumulatedArgs: '',
          isComplete: false,
        },
      };
      if (fcStep.signature) {
        part.thoughtSignature = fcStep.signature;
      }
      aggregatedParts.push(part);
      return null;
    }
    if (step.type === 'thought') {
      const part: Part = {
        thought: true,
        partMetadata: {
          isComplete: false,
        },
      };
      if (step.signature) {
        part.thoughtSignature = step.signature;
      }
      aggregatedParts.push(part);
      return null;
    }
  } else if (eventType === 'step.delta') {
    const stepDelta = event as unknown as Interactions.StepDelta;
    const delta = stepDelta.delta;
    if (!delta) {
      return null;
    }

    if (delta.type === 'text') {
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
    } else if (delta.type === 'arguments_delta') {
      const activePart = findLastPart(
        aggregatedParts,
        (p) =>
          !!(p.functionCall && p.partMetadata && !p.partMetadata.isComplete),
      );
      if (activePart && activePart.partMetadata && delta.arguments) {
        activePart.partMetadata.accumulatedArgs =
          (activePart.partMetadata.accumulatedArgs as string) + delta.arguments;
      }
      return null;
    } else if (delta.type === 'thought_signature') {
      const activePart = findLastPart(
        aggregatedParts,
        (p) =>
          !!(
            (p.thought || p.functionCall) &&
            p.partMetadata &&
            !p.partMetadata.isComplete
          ),
      );
      if (activePart && delta.signature) {
        activePart.thoughtSignature = delta.signature;
      }
      return null;
    } else if (
      delta.type === 'image' ||
      delta.type === 'audio' ||
      delta.type === 'video' ||
      delta.type === 'document'
    ) {
      const part = convertMediaContentToPart(delta as Interactions.Content);
      if (part) {
        aggregatedParts.push(part);
        return {
          content: {role: 'model', parts: [part]},
          partial: false,
          turnComplete: false,
          interactionId: interactionId,
        };
      }
    }
  } else if (eventType === 'step.stop') {
    const activePart = findLastPart(
      aggregatedParts,
      (p) => !!(p.partMetadata && !p.partMetadata.isComplete),
    );
    if (activePart && activePart.partMetadata) {
      activePart.partMetadata.isComplete = true;
      if (activePart.functionCall) {
        const accumulatedArgs = activePart.partMetadata
          .accumulatedArgs as string;
        try {
          activePart.functionCall.args = accumulatedArgs
            ? JSON.parse(accumulatedArgs)
            : {};
        } catch (e) {
          logger.error(
            `Failed to parse accumulated arguments: ${accumulatedArgs}`,
            e,
          );
          activePart.functionCall.args = {};
        }
        delete activePart.partMetadata;

        return {
          content: {role: 'model', parts: [activePart]},
          partial: false,
          turnComplete: false,
          interactionId: interactionId,
        };
      }
      if (activePart.thought) {
        delete activePart.partMetadata;
        return null;
      }
    }
  } else if (eventType === 'interaction.completed') {
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
  } else if (eventType === 'interaction.status_update') {
    const statusUpdate = event as unknown as ExtendedInteractionStatusUpdate;
    const status = statusUpdate.status;
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
      const error = statusUpdate.error;
      return {
        errorCode: error ? error.code : 'UNKNOWN_ERROR',
        errorMessage: error ? error.message : 'Unknown error',
        turnComplete: true,
        interactionId: interactionId,
      };
    }
  } else if (eventType === 'error') {
    return {
      errorCode: event.error?.code || event.code || 'UNKNOWN_ERROR',
      errorMessage: event.error?.message || event.message || 'Unknown error',
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
  event: ExtendedInteractionSSEEvent,
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

  const inputSteps: Interactions.Step[] = [];
  if (contents) {
    for (const content of contents) {
      inputSteps.push(...convertContentToSteps(content));
    }
  }
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

  if (stream) {
    const responses = (await apiClient.interactions.create({
      model: (llmRequest.model || 'gemini-2.5-flash') as 'gemini-2.5-flash',
      input: inputSteps,
      stream: true,
      system_instruction: systemInstruction,
      tools: interactionTools.length > 0 ? interactionTools : undefined,
      generation_config:
        Object.keys(generationConfig).length > 0 ? generationConfig : undefined,
      previous_interaction_id: previousInteractionId,
    })) as AsyncIterable<ExtendedInteractionSSEEvent>;

    const aggregatedParts: Part[] = [];
    for await (const event of responses) {
      const sseEvent = event as ExtendedInteractionSSEEvent;
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
    const interaction = (await apiClient.interactions.create({
      model: (llmRequest.model || 'gemini-2.5-flash') as 'gemini-2.5-flash',
      input: inputSteps,
      stream: false,
      system_instruction: systemInstruction,
      tools: interactionTools.length > 0 ? interactionTools : undefined,
      generation_config:
        Object.keys(generationConfig).length > 0 ? generationConfig : undefined,
      previous_interaction_id: previousInteractionId,
    })) as ExtendedInteraction;

    logger.info('Interaction response received from the model.');
    yield convertInteractionToLlmResponse(interaction);
  }
}
