/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turning inbound files into model input.
 *
 * These limits are the model's, not any messenger's, which is why the policy
 * lives at the gateway rather than on a channel.
 */

import type {Part} from '@google/genai';

import type {InboundAttachment} from '../types.js';

/**
 * The largest raw payload worth inlining, in bytes.
 *
 * Gemini caps a whole request at 20 MB *after* base64 encoding, which inflates
 * bytes by 4/3. A 20 MB file is therefore ~27 MB on the wire and fails, and the
 * prompt and history have to fit alongside it. 14 MB of raw bytes is the
 * honest ceiling; anything larger needs the Files API or a storage URI.
 */
export const DEFAULT_MAX_INLINE_BYTES = 14 * 1024 * 1024;

/**
 * Gemini accepts at most one audio file per request. Two voice notes in one
 * message would fail the whole turn, so the extras degrade to a placeholder.
 */
export const MAX_AUDIO_PARTS = 1;

/**
 * Media types the model accepts, matched exactly.
 *
 * ADK's own `isInlineMimeTypeSupported` admits any `image/*`, `audio/*` or
 * `video/*`, which is right for artifacts but too loose here: a Telegram
 * animated sticker is `application/x-tgsticker`, a GIF is `image/gif`, and
 * both would be forwarded only for the model call to fail. An allowlist turns
 * that into a readable placeholder instead.
 */
const ACCEPTED_MIME_TYPES = new Set([
  // Images. Note GIF and BMP are absent: Gemini does not accept them.
  'image/png',
  'image/jpeg',
  'image/webp',
  // Audio.
  'audio/aac',
  'audio/flac',
  'audio/mp3',
  'audio/mpeg',
  'audio/mpga',
  'audio/m4a',
  'audio/mp4',
  'audio/opus',
  'audio/pcm',
  'audio/wav',
  'audio/webm',
  // Video.
  'video/mp4',
  'video/mpeg',
  'video/mov',
  'video/quicktime',
  'video/avi',
  'video/x-flv',
  'video/mpg',
  'video/webm',
  'video/wmv',
  'video/3gpp',
  // Documents.
  'application/pdf',
  'text/plain',
]);

/**
 * Media types worth rewriting before the allowlist sees them.
 *
 * Telegram reports voice notes as `audio/ogg`, which is the container; Gemini's
 * accepted list names the codec, `audio/opus`. Same bytes, different label.
 */
const MIME_ALIASES: Record<string, string> = {
  'audio/ogg': 'audio/opus',
  'audio/oga': 'audio/opus',
  'audio/x-m4a': 'audio/m4a',
  'audio/mp4a-latm': 'audio/mp4',
  'image/jpg': 'image/jpeg',
};

/** How media is admitted. */
export interface MediaPolicy {
  /** Largest raw payload to inline. Defaults to {@link DEFAULT_MAX_INLINE_BYTES}. */
  maxInlineBytes?: number;
  /** Kinds to ingest at all. Defaults to every kind. */
  accept?: ReadonlyArray<InboundAttachment['kind']>;
  /** Longest audio or video to ingest, in seconds. Defaults to 10 minutes. */
  maxDurationSec?: number;
}

/** Normalizes a reported media type, dropping any `; charset=` suffix. */
export function normalizeMimeType(
  mimeType: string | undefined,
): string | undefined {
  if (!mimeType) {
    return undefined;
  }
  const bare = mimeType.split(';')[0].trim().toLowerCase();
  return MIME_ALIASES[bare] ?? bare;
}

/** Whether the model can read this media type. */
export function isAcceptedMimeType(mimeType: string | undefined): boolean {
  const normalized = normalizeMimeType(mimeType);
  return normalized !== undefined && ACCEPTED_MIME_TYPES.has(normalized);
}

/**
 * Converts attachments into parts the model can read.
 *
 * Anything refused becomes a short text part rather than vanishing: the model
 * should know a file arrived that it cannot see, and so should the user reading
 * the reply.
 */
export async function attachmentsToParts(
  attachments: readonly InboundAttachment[],
  policy: MediaPolicy = {},
): Promise<Part[]> {
  const maxBytes = policy.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  const maxDuration = policy.maxDurationSec ?? 600;
  const parts: Part[] = [];
  let audioParts = 0;

  for (const attachment of attachments) {
    const refusal = refuse(attachment, {
      maxBytes,
      maxDuration,
      accept: policy.accept,
      audioParts,
    });
    if (refusal) {
      parts.push({text: refusal});
      continue;
    }

    const mimeType = normalizeMimeType(attachment.mimeType)!;
    try {
      const bytes = await attachment.download();
      if (bytes.byteLength > maxBytes) {
        // Size is often unknown until the bytes are in hand.
        parts.push({text: describe(attachment, 'too large to process')});
        continue;
      }
      parts.push({
        inlineData: {mimeType, data: base64(bytes)},
      });
      if (mimeType.startsWith('audio/')) {
        audioParts++;
      }
    } catch (error) {
      parts.push({
        text: describe(
          attachment,
          `could not be downloaded: ${error instanceof Error ? error.message : String(error)}`,
        ),
      });
    }
  }

  return parts;
}

/** Why an attachment should not be sent to the model, if it should not. */
function refuse(
  attachment: InboundAttachment,
  limits: {
    maxBytes: number;
    maxDuration: number;
    accept?: ReadonlyArray<InboundAttachment['kind']>;
    audioParts: number;
  },
): string | undefined {
  if (limits.accept && !limits.accept.includes(attachment.kind)) {
    return describe(attachment, 'not processed');
  }
  if (!isAcceptedMimeType(attachment.mimeType)) {
    return describe(attachment, 'unsupported format');
  }
  if (
    attachment.sizeBytes !== undefined &&
    attachment.sizeBytes > limits.maxBytes
  ) {
    return describe(attachment, 'too large to process');
  }
  if (
    attachment.durationSec !== undefined &&
    attachment.durationSec > limits.maxDuration
  ) {
    return describe(attachment, 'too long to process');
  }
  const mimeType = normalizeMimeType(attachment.mimeType)!;
  if (mimeType.startsWith('audio/') && limits.audioParts >= MAX_AUDIO_PARTS) {
    return describe(
      attachment,
      'skipped: only one audio file can be read per message',
    );
  }
  return undefined;
}

function describe(attachment: InboundAttachment, note: string): string {
  const name = attachment.fileName ? ` ${attachment.fileName}` : '';
  const duration =
    attachment.durationSec !== undefined
      ? ` ${formatDuration(attachment.durationSec)}`
      : '';
  return `[${attachment.kind}${name}${duration} — ${note}]`;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
