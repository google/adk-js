/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The property name a `@google/genai` `Blob` is nested under, at every depth of
 * a `Content` graph.
 */
const INLINE_DATA_KEY = 'inlineData';

/** Narrows a replacer value to a blob that carries a string payload. */
function isBlobWithData(
  value: unknown,
): value is Record<string, unknown> & {data: string} {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as {data?: unknown}).data === 'string'
  );
}

/**
 * Serializes a value as JSON with every inline attachment payload elided.
 *
 * An `Event` carrying an image, an audio clip or a PDF holds the whole
 * attachment as a base64 string at `content.parts[].inlineData.data`. Passing
 * such an event to `JSON.stringify` writes those bytes into whatever collects
 * the log: log files, orchestrator captures, and anything pasted into a bug
 * report, which is a different trust boundary from whoever uploaded the file.
 * The payload also costs a full string copy on every call, even when the log
 * level discards the result.
 *
 * Every property named `inlineData` whose value carries a string `data` is
 * emitted with that payload replaced by a fixed-size marker recording how many
 * characters were elided. The descriptive fields of the blob (`mimeType`,
 * `displayName`) survive, matching what `google/adk-python` keeps in
 * `DebugLoggingPlugin`. Every other field is serialized as before, so the
 * result is still valid JSON.
 *
 * A value that is not shaped like a blob passes through untouched, and a
 * circular graph still throws exactly as `JSON.stringify` does.
 */
export function stringifyWithRedactedInlineData(value: unknown): string {
  return JSON.stringify(value, (key: string, val: unknown) =>
    key === INLINE_DATA_KEY && isBlobWithData(val)
      ? {...val, data: `<redacted ${val.data.length} chars>`}
      : val,
  );
}
