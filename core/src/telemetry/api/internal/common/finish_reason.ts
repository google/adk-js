/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FinishReason} from '@google/genai';

/**
 * Whether the model reported why generation stopped.
 *
 * The unspecified value is the proto3 zero value, so a response that carries
 * it has not reported a reason.
 */
export function isReportedFinishReason(
  finishReason: FinishReason | undefined,
): finishReason is FinishReason {
  return (
    finishReason !== undefined &&
    finishReason !== FinishReason.FINISH_REASON_UNSPECIFIED
  );
}

/**
 * Maps a finish reason to the `finish_reason` of a GenAI output message, or
 * `''` when none was reported.
 */
export function toOutputMessageFinishReason(
  finishReason: FinishReason | undefined,
): string {
  if (!isReportedFinishReason(finishReason)) {
    return '';
  }
  switch (finishReason) {
    // The output message schema has no value for OTHER.
    case FinishReason.OTHER:
      return 'error';
    case FinishReason.STOP:
      return 'stop';
    case FinishReason.MAX_TOKENS:
      return 'length';
    default:
      return String(finishReason).toLowerCase();
  }
}
