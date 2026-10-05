/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  FinishReason,
  GenerateContentConfig,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  MediaModality,
  ModalityTokenCount,
  Part,
} from '@google/genai';

import {removeClientFunctionCallId} from '../agents/processors/content_processor_utils.js';
import {logger} from '../utils/logger.js';
import {LlmResponse} from './llm_response.js';

/** The most times one generation is resumed after the model pauses it. */
export const MAX_RESUMES = 256;

/** The contents and config of a request that resumes a paused generation. */
export interface ResumeRequest {
  contents: Content[];
  config: GenerateContentConfig;
}

/**
 * Returns the token that resumes `response`, or undefined if it did not pause
 * or has no token.
 */
export function resumeToken(
  response: GenerateContentResponse,
): string | undefined {
  const candidate = response.candidates?.[0];
  if (candidate?.finishReason !== FinishReason.CONTINUATION) {
    return undefined;
  }
  if (!candidate.continuationToken) {
    logger.warn(
      'The model paused the generation for continuation, but the response carries no continuation token, so the partial output is returned.',
    );
    return undefined;
  }
  return candidate.continuationToken;
}

/**
 * One generation, carried across the requests that resume it after the model
 * pauses it.
 */
export class GeminiContinuation {
  private readonly contents: Content[];
  private readonly parts: Part[] = [];
  private usage?: GenerateContentResponseUsageMetadata;
  private token?: string;
  private resumes = 0;

  constructor(
    contents: Content[],
    private readonly config?: GenerateContentConfig,
  ) {
    this.contents = [...contents];
  }

  /**
   * Adds one request's output to the generation: its parts to the content and
   * its usage to the total.
   */
  addOutput(
    newParts: Part[],
    newUsage: GenerateContentResponseUsageMetadata | undefined,
  ): void {
    this.usage = addUsage(this.usage, newUsage);
    this.appendParts(newParts);
  }

  /**
   * Returns the request that resumes the generation after a request that
   * ended with `nextToken`. Returns undefined if the request did not pause,
   * returned the previous token again, or the generation was already resumed
   * {@link MAX_RESUMES} times.
   */
  resumeRequest(nextToken: string | undefined): ResumeRequest | undefined {
    if (nextToken === undefined) {
      return undefined;
    }
    if (!this.willResume(nextToken)) {
      if (nextToken === this.token) {
        // A token that did not change means the model made no progress.
        logger.warn(
          'The model returned the same continuation token twice; returning the output generated so far.',
        );
      } else {
        logger.warn(
          `The model paused the generation ${MAX_RESUMES} times; returning the output generated so far.`,
        );
      }
      return undefined;
    }
    this.token = nextToken;
    this.resumes++;
    logger.debug('The model paused the generation; resuming it.');
    return this.buildResumeRequest(nextToken);
  }

  /** Returns `response` with the content and usage of all requests, if resumed. */
  complete(response: LlmResponse): LlmResponse {
    if (!this.resumed) {
      return response;
    }
    if (this.parts.length === 0) {
      return {...response, usageMetadata: this.usage};
    }
    // Mirrors createLlmResponse for a candidate with content, which reports
    // the finish reason but no error.
    return {
      content: this.content(),
      groundingMetadata: response.groundingMetadata,
      citationMetadata: response.citationMetadata,
      usageMetadata: this.usage,
      finishReason: response.finishReason,
    };
  }

  /**
   * Returns the final streamed `response`, with usage summed across all
   * requests if resumed.
   */
  withSummedUsage(response: LlmResponse): LlmResponse {
    return this.resumed ? {...response, usageMetadata: this.usage} : response;
  }

  /** Returns whether a request that ended with `nextToken` is resumed. */
  willResume(nextToken: string): boolean {
    return nextToken !== this.token && this.resumes < MAX_RESUMES;
  }

  /** Whether the generation took more than one request. */
  private get resumed(): boolean {
    return this.token !== undefined;
  }

  private content(): Content {
    return {role: 'model', parts: [...this.parts]};
  }

  private buildResumeRequest(nextToken: string): ResumeRequest {
    const contents = [...this.contents];
    if (this.parts.length > 0) {
      // Copied because the parts are shared with responses already yielded,
      // where the streaming aggregator assigned client-side function call ids
      // that must not be sent to the model.
      const content = structuredClone(this.content());
      removeClientFunctionCallId(content);
      contents.push(content);
    }
    return {
      contents,
      config: {...this.config, continuationToken: nextToken},
    };
  }

  /** Appends `newParts`, joining text as the streaming aggregator does. */
  private appendParts(newParts: Part[]): void {
    for (const part of newParts) {
      const last = this.parts.length - 1;
      const previous = last >= 0 ? this.parts[last] : undefined;
      if (previous && canJoin(previous, part)) {
        const joined: Part = {text: previous.text! + part.text!};
        if (previous.thought !== undefined) {
          joined.thought = previous.thought;
        }
        const signature = previous.thoughtSignature || part.thoughtSignature;
        if (signature !== undefined) {
          joined.thoughtSignature = signature;
        }
        this.parts[last] = joined;
      } else {
        this.parts.push(part);
      }
    }
  }
}

/** Returns whether two parts are non-empty text of the same kind. */
function canJoin(first: Part, second: Part): boolean {
  return (
    isText(first) &&
    isText(second) &&
    (first.thought ?? false) === (second.thought ?? false)
  );
}

/**
 * Returns whether the part is non-empty text with at most a thought flag and a
 * signature.
 */
function isText(part: Part): boolean {
  if (!part.text) {
    return false;
  }
  return Object.entries(part).every(
    ([key, value]) =>
      value === undefined ||
      key === 'text' ||
      key === 'thought' ||
      key === 'thoughtSignature',
  );
}

const COUNT_FIELDS = [
  'promptTokenCount',
  'candidatesTokenCount',
  'totalTokenCount',
  'cachedContentTokenCount',
  'thoughtsTokenCount',
  'toolUsePromptTokenCount',
] as const;

const MODALITY_FIELDS = [
  'promptTokensDetails',
  'candidatesTokensDetails',
  'cacheTokensDetails',
  'toolUsePromptTokensDetails',
] as const;

/** Returns the combined token usage of two requests. */
function addUsage(
  total: GenerateContentResponseUsageMetadata | undefined,
  next: GenerateContentResponseUsageMetadata | undefined,
): GenerateContentResponseUsageMetadata | undefined {
  if (!total || !next) {
    return total ?? next;
  }
  const combined: GenerateContentResponseUsageMetadata = {...next};
  for (const field of COUNT_FIELDS) {
    if (total[field] !== undefined || next[field] !== undefined) {
      combined[field] = (total[field] ?? 0) + (next[field] ?? 0);
    }
  }
  for (const field of MODALITY_FIELDS) {
    if (total[field] !== undefined || next[field] !== undefined) {
      combined[field] = addModalityCounts(total[field], next[field]);
    }
  }
  return combined;
}

/** Sums token counts that share a modality, keeping first-seen order. */
function addModalityCounts(
  first: ModalityTokenCount[] | undefined,
  second: ModalityTokenCount[] | undefined,
): ModalityTokenCount[] {
  const totals = new Map<MediaModality | undefined, number>();
  for (const count of [...(first ?? []), ...(second ?? [])]) {
    totals.set(
      count.modality,
      (totals.get(count.modality) ?? 0) + (count.tokenCount ?? 0),
    );
  }
  return [...totals].map(([modality, tokenCount]) =>
    modality === undefined ? {tokenCount} : {modality, tokenCount},
  );
}
