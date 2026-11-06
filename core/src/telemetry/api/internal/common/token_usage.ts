/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentResponseUsageMetadata} from '@google/genai';
import type {Attributes} from '@opentelemetry/api';

import {GenAiAttr} from './attributes.js';

/** Description of the `input_tokens` metric bucket. */
export const INPUT_TOKENS_MEANING =
  'Input (prompt) tokens, summing the prompt itself and the results of' +
  ' server-side tool calls. Prompt tokens served from a cache are part of the' +
  ' prompt count, so they are included here too.';

/** Description of the `output_tokens` metric bucket. */
export const OUTPUT_TOKENS_MEANING =
  'Output (completion) tokens, summing candidate and reasoning tokens. The' +
  ' tokens a model spends emitting a tool call are candidate tokens, so they' +
  ' count here.';

/** Description of the `total_tokens` metric bucket. */
export const TOTAL_TOKENS_MEANING =
  'Input plus output tokens, derived from those two rather than taken from' +
  ' the model-reported total.';

/** Description of the `cache_read.input_tokens` metric bucket. */
export const CACHE_READ_INPUT_TOKENS_MEANING =
  'Input tokens served from a provider-managed cache.';

/** Description of the `reasoning.output_tokens` metric bucket. */
export const REASONING_OUTPUT_TOKENS_MEANING =
  'Output tokens spent on reasoning (chain-of-thought / extended thinking).';

/** Description of the `tool.input_tokens` metric bucket. */
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
 * Input tokens sum the prompt and server-side tool results; output tokens sum
 * candidates and reasoning. A bucket that nothing reported is `undefined`
 * rather than zero: {@link asAttributes} omits it and {@link add} keeps it
 * `undefined` until some call reports it.
 */
export class TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  reasoning?: number;
  toolInput?: number;

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

  /** Folds another call's usage into these totals, bucket by bucket. */
  add(other: TokenUsage): void {
    this.input = sumOrUndefined(this.input, other.input);
    this.output = sumOrUndefined(this.output, other.output);
    this.cacheRead = sumOrUndefined(this.cacheRead, other.cacheRead);
    this.reasoning = sumOrUndefined(this.reasoning, other.reasoning);
    this.toolInput = sumOrUndefined(this.toolInput, other.toolInput);
  }

  /**
   * Input plus output tokens, derived from those two rather than taken from
   * the model-reported total.
   */
  totalTokenUsage(): number {
    return (this.input ?? 0) + (this.output ?? 0);
  }

  /**
   * Returns the GenAI token usage attributes for the reported buckets,
   * omitting `undefined` buckets and preserving `0`.
   */
  asAttributes(): Attributes {
    const attributes: Attributes = {};
    if (this.input !== undefined) {
      attributes[GenAiAttr.USAGE_INPUT_TOKENS] = this.input;
    }
    if (this.output !== undefined) {
      attributes[GenAiAttr.USAGE_OUTPUT_TOKENS] = this.output;
    }
    if (this.cacheRead !== undefined) {
      attributes[GenAiAttr.USAGE_CACHE_READ_INPUT_TOKENS] = this.cacheRead;
    }
    if (this.reasoning !== undefined) {
      attributes[GenAiAttr.USAGE_REASONING_OUTPUT_TOKENS] = this.reasoning;
    }
    return attributes;
  }
}
