/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CitationMetadata,
  FinishReason,
  FunctionCall,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
  Part,
  PartialArg,
} from '@google/genai';
import {JSONPath} from 'jsonpath-plus';
import {generateClientFunctionCallId} from '../agents/functions.js';
import {FeatureName, isFeatureEnabled} from '../features/feature_registry.js';
import {createLlmResponse, LlmResponse} from '../models/llm_response.js';

interface StreamingStrategy {
  processResponse(
    llmResponse: LlmResponse,
  ): AsyncGenerator<LlmResponse, void, void>;
  close(): Part[] | undefined;
}

/**
 * Property keys that must never be written through a model-controlled JSON
 * path, to prevent prototype pollution of `Object.prototype`.
 */
const UNSAFE_PROPERTY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Progressive strategy for SSE streaming mode: flushes parts as they arrive.
 */
class ProgressiveStrategy implements StreamingStrategy {
  private partsSequence: Part[] = [];
  private currentTextBuffer = '';
  private currentTextIsThought?: boolean;

  // For streaming function call arguments
  private currentFcName?: string;
  private currentFcArgs: Record<string, unknown> = {};
  private currentFcId?: string;
  private currentThoughtSignature?: string | Uint8Array;

  private flushTextBufferToSequence(): void {
    if (!this.currentTextBuffer) {
      return;
    }

    if (this.currentTextIsThought) {
      this.partsSequence.push({
        text: this.currentTextBuffer,
        thought: true,
      });
    } else {
      this.partsSequence.push({
        text: this.currentTextBuffer,
      });
    }

    this.currentTextBuffer = '';
    this.currentTextIsThought = undefined;
  }

  private getValueFromPartialArg(
    partialArg: PartialArg,
    jsonPath: string,
  ): [unknown, boolean] {
    let value: unknown = null;
    let hasValue = false;

    const stringValue = partialArg.stringValue;
    const numberValue = partialArg.numberValue;
    const boolValue = partialArg.boolValue;
    const nullValue = partialArg.nullValue;

    if (stringValue !== undefined) {
      const stringChunk = stringValue;
      hasValue = true;

      const pathParts = JSONPath.toPathArray(jsonPath).filter(
        (p) => p !== '$' && p !== '$[',
      );

      let existingValue: unknown = this.currentFcArgs;
      for (const part of pathParts) {
        if (
          existingValue &&
          typeof existingValue === 'object' &&
          part in existingValue
        ) {
          existingValue = (existingValue as Record<string, unknown>)[part];
        } else {
          existingValue = undefined;
          break;
        }
      }

      if (typeof existingValue === 'string') {
        value = existingValue + stringChunk;
      } else {
        value = stringChunk;
      }
    } else if (numberValue !== undefined) {
      value = numberValue;
      hasValue = true;
    } else if (boolValue !== undefined) {
      value = boolValue;
      hasValue = true;
    } else if (nullValue !== undefined) {
      value = null;
      hasValue = true;
    }

    return [value, hasValue];
  }

  private setValueByJsonPath(jsonPath: string, value: unknown): void {
    const pathParts = JSONPath.toPathArray(jsonPath).filter(
      (p) => p !== '$' && p !== '$[',
    );

    // Reject model-controlled paths that target prototype-chain properties,
    // which would otherwise pollute `Object.prototype` (e.g.
    // `$.__proto__.polluted`).
    if (pathParts.some((part) => UNSAFE_PROPERTY_KEYS.has(String(part)))) {
      return;
    }

    let current = this.currentFcArgs;
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (!Object.prototype.hasOwnProperty.call(current, part)) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    if (pathParts.length > 0) {
      current[pathParts[pathParts.length - 1]] = value;
    }
  }

  private flushFunctionCallToSequence(): void {
    if (this.currentFcName) {
      const fcPart: Part = {
        functionCall: {
          name: this.currentFcName,
          args: JSON.parse(JSON.stringify(this.currentFcArgs)),
          id: this.currentFcId ?? generateClientFunctionCallId(),
        } as FunctionCall,
      };

      if (this.currentThoughtSignature) {
        fcPart.thoughtSignature = this.currentThoughtSignature.toString();
      }

      this.partsSequence.push(fcPart);

      this.currentFcName = undefined;
      this.currentFcArgs = {};
      this.currentFcId = undefined;
      this.currentThoughtSignature = undefined;
    }
  }

  private processStreamingFunctionCall(fc: FunctionCall): void {
    if (fc.name) {
      this.currentFcName = fc.name;
    }
    if (fc.id) {
      this.currentFcId = fc.id;
    }

    for (const partialArg of fc.partialArgs || []) {
      const jsonPath = partialArg.jsonPath;
      if (!jsonPath) {
        continue;
      }

      const [value, hasValue] = this.getValueFromPartialArg(
        partialArg,
        jsonPath,
      );

      if (hasValue) {
        this.setValueByJsonPath(jsonPath, value);
      }
    }

    if (!fc.willContinue) {
      this.flushTextBufferToSequence();
      this.flushFunctionCallToSequence();
    }
  }

  private processFunctionCallPart(part: Part): void {
    const fc = part.functionCall as FunctionCall;
    if (!fc) {
      return;
    }

    if (fc.partialArgs || fc.willContinue) {
      if (!fc.id && !this.currentFcId) {
        fc.id = generateClientFunctionCallId();
      }

      if (part.thoughtSignature && !this.currentThoughtSignature) {
        this.currentThoughtSignature = part.thoughtSignature;
      }
      this.processStreamingFunctionCall(fc);
    } else {
      if (fc.name) {
        if (!fc.id) {
          fc.id = generateClientFunctionCallId();
        }
        this.flushTextBufferToSequence();
        this.partsSequence.push(part);
      }
    }
  }

  async *processResponse(
    llmResponse: LlmResponse,
  ): AsyncGenerator<LlmResponse, void, void> {
    if (llmResponse.content && llmResponse.content.parts) {
      for (const part of llmResponse.content.parts) {
        if (part.text) {
          const isThought = part.thought ?? false;
          if (
            this.currentTextBuffer &&
            isThought !== this.currentTextIsThought
          ) {
            this.flushTextBufferToSequence();
          }

          if (!this.currentTextBuffer) {
            this.currentTextIsThought = isThought;
          }
          this.currentTextBuffer += part.text;
        } else if (part.functionCall) {
          this.processFunctionCallPart(part);
        } else {
          this.flushTextBufferToSequence();
          this.partsSequence.push(part);
        }
      }
    }

    llmResponse.partial = true;
    yield llmResponse;
  }

  close(): Part[] | undefined {
    this.flushTextBufferToSequence();
    this.flushFunctionCallToSequence();

    const finalParts = this.partsSequence;
    if (finalParts.length === 0) {
      return undefined;
    }
    return finalParts;
  }
}

/**
 * Non-progressive strategy for SSE streaming mode: accumulates parts and flushes at boundaries.
 */
class NonProgressiveStrategy implements StreamingStrategy {
  private text = '';
  private thoughtText = '';

  async *processResponse(
    llmResponse: LlmResponse,
  ): AsyncGenerator<LlmResponse, void, void> {
    if (llmResponse.content?.parts) {
      const nonTextParts: Part[] = [];
      let sawTextPart = false;

      for (const part of llmResponse.content.parts) {
        if (typeof part.text === 'string') {
          sawTextPart = true;
          if (part.thought) {
            this.thoughtText += part.text;
          } else {
            this.text += part.text;
          }
          continue;
        }

        if (part.functionCall && !part.functionCall.id) {
          part.functionCall.id = generateClientFunctionCallId();
        }
        nonTextParts.push(part);
      }

      if (nonTextParts.length > 0) {
        if (this.thoughtText || this.text) {
          const parts: Part[] = [];
          if (this.thoughtText) {
            parts.push({text: this.thoughtText, thought: true});
          }
          if (this.text) {
            parts.push({text: this.text});
          }
          yield {
            content: {
              role: 'model',
              parts: parts,
            },
            usageMetadata: llmResponse.usageMetadata,
            partial: false,
          };
          this.thoughtText = '';
          this.text = '';
        }
        yield {
          ...llmResponse,
          content: {
            role: llmResponse.content.role,
            parts: nonTextParts,
          },
          partial: false,
        };
        return;
      }

      if (sawTextPart) {
        llmResponse.partial = true;
      }
    }
    yield llmResponse;
  }

  close(): Part[] | undefined {
    if (this.text || this.thoughtText) {
      const parts: Part[] = [];
      if (this.thoughtText) {
        parts.push({text: this.thoughtText, thought: true});
      }
      if (this.text) {
        parts.push({text: this.text});
      }
      return parts;
    }
    return undefined;
  }
}

/**
 * Aggregates partial streaming responses.
 *
 * It aggregates content from partial responses, and generates LlmResponses for
 * individual (partial) model responses, as well as for aggregated content.
 */
export class StreamingResponseAggregator {
  private usageMetadata?: GenerateContentResponseUsageMetadata;
  private groundingMetadata?: GroundingMetadata;
  private citationMetadata?: CitationMetadata;
  private response?: GenerateContentResponse;
  private finishReason?: FinishReason;

  private lastThoughtSignature: {value?: string | Uint8Array} = {};
  private readonly strategy: StreamingStrategy;

  constructor(
    private readonly isProgressiveMode: boolean = isFeatureEnabled(
      FeatureName.PROGRESSIVE_SSE_STREAMING,
    ),
  ) {
    this.strategy = this.isProgressiveMode
      ? new ProgressiveStrategy()
      : new NonProgressiveStrategy();
  }

  async *processResponse(
    response: GenerateContentResponse,
  ): AsyncGenerator<LlmResponse, void, void> {
    const llmResponse = createLlmResponse(response);
    const parts = llmResponse.content?.parts ?? [];

    // Suppress empty chunks that carry no meaningful content (e.g. trailing empty
    // STOP chunks or intermediate empty chunks) to avoid yielding empty events
    // that cause empty bubbles in UI, and to prevent premature agent termination
    // after tool calls. We only do this if it's not an error finish reason.
    if (
      parts.every(isEmptyContentPart) &&
      (llmResponse.finishReason === undefined ||
        llmResponse.finishReason === FinishReason.STOP)
    ) {
      if (llmResponse.usageMetadata) {
        this.usageMetadata = llmResponse.usageMetadata;
      }
      if (llmResponse.groundingMetadata) {
        this.groundingMetadata = llmResponse.groundingMetadata;
      }
      if (llmResponse.citationMetadata) {
        this.citationMetadata = llmResponse.citationMetadata;
      }
      if (llmResponse.finishReason) {
        this.finishReason = llmResponse.finishReason;
      }
      return;
    }

    this.response = response;
    this.usageMetadata = llmResponse.usageMetadata;
    if (llmResponse.groundingMetadata) {
      this.groundingMetadata = llmResponse.groundingMetadata;
    }
    if (llmResponse.citationMetadata) {
      this.citationMetadata = llmResponse.citationMetadata;
    }

    if (llmResponse.finishReason) {
      this.finishReason = llmResponse.finishReason;
    }
    if (llmResponse.content && llmResponse.content.parts) {
      for (const part of llmResponse.content.parts) {
        if (part.thoughtSignature) {
          this.lastThoughtSignature.value = part.thoughtSignature;
        } else if (part.functionCall && this.lastThoughtSignature.value) {
          part.thoughtSignature = this.lastThoughtSignature.value.toString();
        }
      }
    }

    yield* this.strategy.processResponse(llmResponse);
  }

  close(): LlmResponse | undefined {
    const finalParts = this.strategy.close();
    const hasMetadata =
      this.usageMetadata !== undefined ||
      this.groundingMetadata !== undefined ||
      this.citationMetadata !== undefined;

    if (!finalParts && !hasMetadata) {
      return undefined;
    }

    // Use the candidate from the last response that carried one. Gemini may
    // send a trailing empty chunk (no candidates) to signal stream end; we
    // must not discard accumulated parts in that case.
    const candidate = this.response?.candidates?.[0];
    const finishReason = this.finishReason ?? candidate?.finishReason;

    return {
      content: {
        role: 'model',
        parts: finalParts ?? [],
      },
      groundingMetadata: this.groundingMetadata,
      citationMetadata: this.citationMetadata,
      errorCode: finishReason === FinishReason.STOP ? undefined : finishReason,
      errorMessage:
        finishReason === FinishReason.STOP
          ? undefined
          : candidate?.finishMessage,
      usageMetadata: this.usageMetadata,
      finishReason: finishReason,
      partial: false,
    };
  }
}

/**
 * Checks if a response part has no meaningful content (empty text, no tool calls, etc.)
 */
export function isEmptyContentPart(part: Part): boolean {
  return (
    !part.functionCall &&
    !part.functionResponse &&
    !part.fileData &&
    !part.inlineData &&
    !part.executableCode &&
    !part.codeExecutionResult &&
    (!part.text || part.text === '')
  );
}
