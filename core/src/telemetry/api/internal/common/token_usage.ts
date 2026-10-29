/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentResponseUsageMetadata} from '@google/genai';
import type {Attributes} from '@opentelemetry/api';

import {GenAiAttr} from './attributes.js';

// What each token count means. The TokenUsage class implements these
// definitions, and the token metric descriptions quote them, so the two cannot
// drift apart.

/** What an input token count covers. */
export const INPUT_TOKENS_MEANING =
  'Input (prompt) tokens, summing the prompt itself and the results of' +
  ' server-side tool calls. Prompt tokens served from a cache are part of the' +
  ' prompt count, so they are included here too.';

/** What an output token count covers. */
export const OUTPUT_TOKENS_MEANING =
  'Output (completion) tokens, summing candidate and reasoning tokens. The' +
  ' tokens a model spends emitting a tool call are candidate tokens, so they' +
  ' count here.';

/** What a total token count covers. */
export const TOTAL_TOKENS_MEANING =
  'Input plus output tokens, derived from those two rather than taken from' +
  ' the model-reported total.';

/** What a cache-read input token count covers. */
export const CACHE_READ_INPUT_TOKENS_MEANING =
  'Input tokens served from a provider-managed cache.';

/** What a reasoning output token count covers. */
export const REASONING_OUTPUT_TOKENS_MEANING =
  'Output tokens spent on reasoning (chain-of-thought / extended thinking).';

/** What a tool input token count covers. */
export const TOOL_INPUT_TOKENS_MEANING =
  'Input tokens from server-side tool results the model fed back to itself' +
  ' within one request, such as code execution or search grounding. Zero for' +
  ' client-side function tools, whose responses arrive as ordinary content on' +
  ' the next request and bill as plain prompt tokens.';

function sumOrUndefined(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

/**
 * GenAI token usage, either one model call's or a sum over several.
 *
 * A bucket is `undefined` when nothing reported it, which is not the same as a
 * reported zero. `cacheRead` and `toolInput` are subsets of `input`;
 * `reasoning` is a subset of `output`.
 */
export class TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  reasoning?: number;
  toolInput?: number;

  /**
   * Reads the token buckets of `usage` when provided.
   *
   * Input tokens sum the prompt and server-side tool results; output tokens
   * sum candidates and reasoning.
   */
  constructor(usage?: GenerateContentResponseUsageMetadata) {
    if (!usage) {
      return;
    }
    this.input = sumOrUndefined(
      usage.promptTokenCount,
      usage.toolUsePromptTokenCount,
    );
    this.output = sumOrUndefined(
      usage.candidatesTokenCount,
      usage.thoughtsTokenCount,
    );
    this.cacheRead = usage.cachedContentTokenCount;
    this.reasoning = usage.thoughtsTokenCount;
    this.toolInput = usage.toolUsePromptTokenCount;
  }

  /**
   * Adds `other` bucket by bucket. A bucket stays `undefined` only when
   * neither side reported it.
   */
  add(other: TokenUsage): void {
    this.input = sumOrUndefined(this.input, other.input);
    this.output = sumOrUndefined(this.output, other.output);
    this.cacheRead = sumOrUndefined(this.cacheRead, other.cacheRead);
    this.reasoning = sumOrUndefined(this.reasoning, other.reasoning);
    this.toolInput = sumOrUndefined(this.toolInput, other.toolInput);
  }

  /**
   * Returns input plus output tokens. The model's own reported total is not
   * used, so the total always agrees with the two directions it sums.
   */
  totalTokenUsage(): number {
    return (this.input ?? 0) + (this.output ?? 0);
  }

  /**
   * Builds the GenAI token usage attributes for this report.
   *
   * A bucket the model did not report is omitted rather than recorded as zero.
   */
  asAttributes(): Attributes {
    return {
      ...(this.input === undefined
        ? {}
        : {[GenAiAttr.USAGE_INPUT_TOKENS]: this.input}),
      ...(this.output === undefined
        ? {}
        : {[GenAiAttr.USAGE_OUTPUT_TOKENS]: this.output}),
      ...(this.cacheRead === undefined
        ? {}
        : {[GenAiAttr.USAGE_CACHE_READ_INPUT_TOKENS]: this.cacheRead}),
      ...(this.reasoning === undefined
        ? {}
        : {[GenAiAttr.USAGE_REASONING_OUTPUT_TOKENS]: this.reasoning}),
    };
  }
}
