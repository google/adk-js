/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Serializes a value as JSON with every inline attachment payload elided.
 *
 * An `Event` carrying an image, an audio clip or a PDF holds the whole
 * attachment as a base64 string at `content.parts[].inlineData.data`. Passing
 * such an event to `JSON.stringify` writes those bytes into whatever collects
 * the log, which is a different trust boundary from whoever uploaded the file.
 * Each blob keeps its descriptive fields and reports how many characters were
 * elided in place of the payload.
 */
export function stringifyWithRedactedInlineData(value: unknown): string {
  return JSON.stringify(value, (key: string, val: unknown) =>
    key === 'inlineData' &&
    typeof val === 'object' &&
    val !== null &&
    'data' in val &&
    typeof val.data === 'string'
      ? {...val, data: `<redacted ${val.data.length} chars>`}
      : val,
  );
}
