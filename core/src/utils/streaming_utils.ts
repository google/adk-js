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
const MAX_ARRAY_INDEX = 10_000;
// Bound model-controlled paths and cumulative padding before JSON snapshotting.
const MAX_ARGUMENT_PATH_DEPTH = 256;
const MAX_ARGUMENT_ARRAY_ELEMENTS = 100_000;

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
  private currentFcArrayElements = 0;
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

  private getArgumentPath(jsonPath: string): Array<string | number> {
    const path = jsonPath.startsWith('$.')
      ? jsonPath.slice(2)
      : jsonPath.startsWith('$')
        ? jsonPath.slice(1)
        : jsonPath;
    const tokens =
      /\[\s*(\d+)\s*\]|\['((?:[^'\\]|\\.)*)'\]|\["((?:[^"\\]|\\.)*)"\]|\.?((?:[^.[\]\\]|\\.)+)/g;
    const unescape = (value: string) =>
      value.replace(
        /\\u([0-9a-fA-F]{4})|\\(.)/g,
        (_, unicode: string | undefined, char: string) => {
          if (unicode !== undefined) {
            return String.fromCharCode(parseInt(unicode, 16));
          }
          const escapes: Record<string, string> = {
            n: '\n',
            r: '\r',
            t: '\t',
            b: '\b',
            f: '\f',
          };
          return escapes[char] ?? char;
        },
      );
    const parts: Array<string | number> = [];
    for (const match of path.matchAll(tokens)) {
      if (parts.length === MAX_ARGUMENT_PATH_DEPTH) return [];
      parts.push(
        match[1] !== undefined
          ? Number(match[1])
          : unescape(match[2] ?? match[3] ?? match[4]),
      );
    }
    return parts;
  }

  private getValueFromPartialArg(
    partialArg: PartialArg,
    pathParts: Array<string | number>,
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

      let existingValue: unknown = this.currentFcArgs;
      for (const part of pathParts) {
        if (
          existingValue !== null &&
          typeof existingValue === 'object' &&
          (typeof part === 'number'
            ? Array.isArray(existingValue) && part < existingValue.length
            : !Array.isArray(existingValue) &&
              Object.hasOwn(existingValue, part))
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

  private extendArray(array: unknown[], index: number): boolean {
    const additional = index + 1 - array.length;
    if (additional <= 0) return true;
    if (
      this.currentFcArrayElements + additional >
      MAX_ARGUMENT_ARRAY_ELEMENTS
    ) {
      return false;
    }
    this.currentFcArrayElements += additional;
    while (array.length <= index) array.push(null);
    return true;
  }

  private setValueByPath(
    pathParts: Array<string | number>,
    value: unknown,
  ): void {
    // Reject model-controlled paths that target prototype-chain properties,
    // which would otherwise pollute `Object.prototype` (e.g.
    // `$.__proto__.polluted`).
    if (pathParts.some((part) => UNSAFE_PROPERTY_KEYS.has(String(part)))) {
      return;
    }

    let current: unknown = this.currentFcArgs;
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      const nextIsIndex = typeof pathParts[i + 1] === 'number';
      if (typeof part === 'string') {
        if (
          current === null ||
          typeof current !== 'object' ||
          Array.isArray(current)
        ) {
          return;
        }
        const record = current as Record<string, unknown>;
        if (!Object.hasOwn(record, part)) {
          record[part] = nextIsIndex ? [] : {};
        }
        current = record[part];
      } else {
        if (!Array.isArray(current) || part > MAX_ARRAY_INDEX) return;
        if (!this.extendArray(current, part)) return;
        if (current[part] === null) current[part] = nextIsIndex ? [] : {};
        current = current[part];
      }
    }

    const last = pathParts.at(-1);
    if (typeof last === 'string') {
      if (
        current !== null &&
        typeof current === 'object' &&
        !Array.isArray(current)
      ) {
        (current as Record<string, unknown>)[last] = value;
      }
    } else if (
      last !== undefined &&
      Array.isArray(current) &&
      last <= MAX_ARRAY_INDEX
    ) {
      if (!this.extendArray(current, last)) return;
      current[last] = value;
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
      this.currentFcArrayElements = 0;
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
      if (typeof jsonPath !== 'string' || !jsonPath) {
        continue;
      }

      const pathParts = this.getArgumentPath(jsonPath);
      if (pathParts.length === 0) continue;
      const [value, hasValue] = this.getValueFromPartialArg(
        partialArg,
        pathParts,
      );

      if (hasValue) {
        this.setValueByPath(pathParts, value);
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
        // Audio interleaved with text keeps the text buffered, so the text is
        // delivered once in the final aggregate instead of being split around
        // each audio chunk.
        const startsWithInlineData = !!llmResponse.content.parts[0]?.inlineData;
        if (!startsWithInlineData && (this.thoughtText || this.text)) {
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
