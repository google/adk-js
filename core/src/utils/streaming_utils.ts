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
import {generateClientFunctionCallId} from '../events/event.js';
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
  private currentTextThoughtSignature?: string;

  // For streaming function call arguments
  private currentFcName?: string;
  private currentFcArgs: Record<string, unknown> = {};
  private currentFcId?: string;
  private currentThoughtSignature?: string | Uint8Array;

  private flushTextBufferToSequence(): void {
    if (!this.currentTextBuffer) {
      return;
    }

    const mergedPart: Part = this.currentTextIsThought
      ? {
          text: this.currentTextBuffer,
          thought: true,
        }
      : {
          text: this.currentTextBuffer,
        };

    if (this.currentTextThoughtSignature) {
      mergedPart.thoughtSignature = this.currentTextThoughtSignature;
    }

    this.partsSequence.push(mergedPart);

    this.currentTextBuffer = '';
    this.currentTextIsThought = undefined;
    this.currentTextThoughtSignature = undefined;
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
    const parts = llmResponse.content?.parts;
    if (parts) {
      for (const part of parts) {
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
          if (part.thoughtSignature && !this.currentTextThoughtSignature) {
            this.currentTextThoughtSignature = part.thoughtSignature;
          }
        } else if (part.functionCall) {
          this.processFunctionCallPart(part);
        } else if (!isEmptyContentPart(part)) {
          this.flushTextBufferToSequence();
          this.partsSequence.push(part);
        }
      }
    }

    // Do not yield spurious empty partial events for chunks that carry only
    // thoughtSignature (and empty or no text).
    if (
      parts?.length &&
      parts.some(isSignatureOnlyPart) &&
      parts.every(
        (part) => isSignatureOnlyPart(part) || isEmptyContentPart(part),
      )
    ) {
      return;
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
  private textThoughtSignature?: string;
  private thoughtTextSignature?: string;
  private signatureParts: Part[] = [];

  private hasBufferedParts(): boolean {
    return (
      Boolean(this.thoughtText) ||
      Boolean(this.text) ||
      this.signatureParts.length > 0
    );
  }

  private buildBufferedParts(): Part[] {
    const parts: Part[] = [];
    if (this.thoughtText) {
      const thoughtPart: Part = {text: this.thoughtText, thought: true};
      if (this.thoughtTextSignature) {
        thoughtPart.thoughtSignature = this.thoughtTextSignature;
      }
      parts.push(thoughtPart);
    }
    if (this.text) {
      const textPart: Part = {text: this.text};
      if (this.textThoughtSignature) {
        textPart.thoughtSignature = this.textThoughtSignature;
      }
      parts.push(textPart);
    }
    if (this.signatureParts.length > 0) {
      parts.push(...this.signatureParts);
    }
    return parts;
  }

  private clearBuffers(): void {
    this.thoughtText = '';
    this.text = '';
    this.thoughtTextSignature = undefined;
    this.textThoughtSignature = undefined;
    this.signatureParts = [];
  }

  async *processResponse(
    llmResponse: LlmResponse,
  ): AsyncGenerator<LlmResponse, void, void> {
    if (llmResponse.content?.parts) {
      const nonTextParts: Part[] = [];
      let sawTextPart = false;
      let sawNonEmptyTextPart = false;
      let sawSignatureOnlyPart = false;

      for (const part of llmResponse.content.parts) {
        if (isSignatureOnlyPart(part)) {
          sawSignatureOnlyPart = true;
          if (nonTextParts.length > 0) {
            nonTextParts.push(part);
          } else {
            this.signatureParts.push(part);
          }
          continue;
        }

        if (typeof part.text === 'string') {
          sawTextPart = true;
          if (part.text) {
            sawNonEmptyTextPart = true;
          }
          if (part.thought) {
            this.thoughtText += part.text;
            if (part.thoughtSignature && !this.thoughtTextSignature) {
              this.thoughtTextSignature = part.thoughtSignature;
            }
          } else {
            this.text += part.text;
            if (part.thoughtSignature && !this.textThoughtSignature) {
              this.textThoughtSignature = part.thoughtSignature;
            }
          }
          continue;
        }

        if (part.functionCall && !part.functionCall.id) {
          part.functionCall.id = generateClientFunctionCallId();
        }
        nonTextParts.push(part);
      }

      if (nonTextParts.length > 0) {
        // Audio interleaved with text keeps the text buffered, so the text is
        // delivered once in the final aggregate instead of being split around
        // each audio chunk.
        const startsWithInlineData = !!llmResponse.content.parts[0]?.inlineData;
        if (!startsWithInlineData && this.hasBufferedParts()) {
          yield {
            content: {
              role: 'model',
              parts: this.buildBufferedParts(),
            },
            usageMetadata: llmResponse.usageMetadata,
            partial: false,
          };
          this.clearBuffers();
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

      if (sawSignatureOnlyPart && !sawNonEmptyTextPart) {
        return;
      }

      if (sawTextPart) {
        llmResponse.partial = true;
      }
    }
    yield llmResponse;
  }

  close(): Part[] | undefined {
    if (this.hasBufferedParts()) {
      return this.buildBufferedParts();
    }
    return undefined;
  }
}

/** Options for {@link GeminiStreamingResponseAggregator}. */
export interface GeminiStreamingResponseAggregatorOptions {
  /**
   * Whether to flush parts as they arrive. Defaults to the
   * PROGRESSIVE_SSE_STREAMING feature flag.
   */
  isProgressiveMode?: boolean;
}

/**
 * Aggregates partial Gemini streaming responses.
 *
 * It aggregates content from partial responses, and generates LlmResponses for
 * individual (partial) model responses, as well as for aggregated content.
 */
export class GeminiStreamingResponseAggregator {
  private usageMetadata?: GenerateContentResponseUsageMetadata;
  private groundingMetadata?: GroundingMetadata;
  private citationMetadata?: CitationMetadata;
  private response?: GenerateContentResponse;
  private finishReason?: FinishReason;

  private lastThoughtSignature: {value?: string | Uint8Array} = {};
  private readonly strategy: StreamingStrategy;

  constructor({
    isProgressiveMode = isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING),
  }: GeminiStreamingResponseAggregatorOptions = {}) {
    this.strategy = isProgressiveMode
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
      // Only attach a model `content` when there are actual parts to emit. When
      // the turn accumulated no parts (e.g. a function call that was already
      // flushed, followed by a trailing STOP chunk that carries only usage
      // metadata) we still surface that trailing metadata, but MUST NOT emit
      // `content: { parts: [] }`. An empty-parts model turn corrupts the session
      // history: on the next request the Vertex AI backend rejects the whole
      // call with HTTP 400 "Unable to submit request because it must include at
      // least one parts field", which breaks multi-turn tool-using sessions
      // right after the first tool call (google/adk-js#21, #22).
      content: finalParts ? {role: 'model', parts: finalParts} : undefined,
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
 * Checks if a response part carries only a thoughtSignature without any other
 * content payload (such as `{text: '', thoughtSignature: '...'}` or
 * `{thoughtSignature: '...'}`).
 */
function isSignatureOnlyPart(part: Part): boolean {
  return (
    Boolean(part.thoughtSignature?.length) &&
    !part.functionCall &&
    !part.functionResponse &&
    !part.fileData &&
    !part.inlineData &&
    !part.executableCode &&
    !part.codeExecutionResult &&
    (!part.text || part.text === '')
  );
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
    !part.thoughtSignature?.length &&
    (!part.text || part.text === '')
  );
}
