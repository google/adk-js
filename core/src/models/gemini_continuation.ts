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
   * Records one request's output and returns the next request to resume
   * generation. Returns undefined if generation finished, paused without a new
   * token, or already resumed {@link MAX_RESUMES} times.
   */
  advance(
    nextToken: string | undefined,
    newParts: Part[],
    newUsage: GenerateContentResponseUsageMetadata | undefined,
  ): ResumeRequest | undefined {
    this.usage = addUsage(this.usage, newUsage);
    if (nextToken === undefined && !this.resumed) {
      return undefined;
    }
    this.appendParts(newParts);
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
    logger.info('The model paused the generation; resuming it.');
    return this.nextRequest(nextToken);
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

  private nextRequest(nextToken: string): ResumeRequest {
    const contents = [...this.contents];
    if (this.parts.length > 0) {
      contents.push(this.content());
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

/** What one streamed request generated, recorded to resume the generation. */
export class StreamedOutput {
  readonly parts: Part[] = [];
  token?: string;
  usage?: GenerateContentResponseUsageMetadata;

  constructor(private readonly continuation: GeminiContinuation) {}

  /**
   * Records a chunk and returns what to aggregate: the chunk, with the finish
   * reason of a resumed pause cleared since that pause does not end the
   * generation, or undefined for a resumed pause without output.
   */
  record(chunk: GenerateContentResponse): GenerateContentResponse | undefined {
    if (chunk.usageMetadata) {
      this.usage = chunk.usageMetadata;
    }
    const candidates = chunk.candidates ?? [];
    if (candidates.length === 0) {
      return chunk;
    }
    const candidate = candidates[0];
    // A stream terminator carries nothing, and resending it would add an empty
    // text part.
    const chunkParts = (candidate.content?.parts ?? []).filter(
      (part) => !isStreamTerminator(part),
    );
    // Copied because the streaming aggregator mutates the parts it receives,
    // e.g. assigning client-side function call ids that must not be resent.
    this.parts.push(...structuredClone(chunkParts));
    const chunkToken = resumeToken(chunk);
    if (chunkToken === undefined) {
      return chunk;
    }
    this.token = chunkToken;
    if (!this.continuation.willResume(chunkToken)) {
      // A pause that is not resumed ends the generation, so it keeps its
      // finish reason.
      return chunk;
    }
    if (chunkParts.length === 0) {
      // Drop an empty pause chunk: as the first chunk, it would emit a
      // complete, empty response.
      return undefined;
    }
    const resumable = Object.assign(new GenerateContentResponse(), chunk);
    resumable.candidates = [
      {...candidate, finishReason: undefined},
      ...candidates.slice(1),
    ];
    return resumable;
  }
}

/** Returns whether the part is an empty text part and nothing else. */
function isStreamTerminator(part: Part): boolean {
  if (part.text !== '') {
    return false;
  }
  return Object.entries(part).every(
    ([key, value]) =>
      value === undefined ||
      key === 'text' ||
      (key === 'thought' && value === false),
  );
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
