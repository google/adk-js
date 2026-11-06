/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentResponseUsageMetadata} from '@google/genai';
import type {Attributes} from '@opentelemetry/api';

import {GenAiAttr} from './attributes.js';

function sumOrUndefined(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

/**
 * Builds the GenAI token usage attributes for one usage report.
 *
 * Input tokens sum the prompt and server-side tool results; output tokens sum
 * candidates and reasoning. A bucket the model did not report is omitted
 * rather than recorded as zero.
 */
export function buildTokenUsageAttributes(
  usage: GenerateContentResponseUsageMetadata,
): Attributes {
  const attributes: Attributes = {};
  const input = sumOrUndefined(
    usage.promptTokenCount,
    usage.toolUsePromptTokenCount,
  );
  const output = sumOrUndefined(
    usage.candidatesTokenCount,
    usage.thoughtsTokenCount,
  );
  if (input !== undefined) {
    attributes[GenAiAttr.USAGE_INPUT_TOKENS] = input;
  }
  if (output !== undefined) {
    attributes[GenAiAttr.USAGE_OUTPUT_TOKENS] = output;
  }
  if (usage.cachedContentTokenCount !== undefined) {
    attributes[GenAiAttr.USAGE_CACHE_READ_INPUT_TOKENS] =
      usage.cachedContentTokenCount;
  }
  if (usage.thoughtsTokenCount !== undefined) {
    attributes[GenAiAttr.USAGE_REASONING_OUTPUT_TOKENS] =
      usage.thoughtsTokenCount;
  }
  return attributes;
}
