/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mapping Telegram's ten-odd media fields onto canonical attachments.
 *
 * Two things make this more than field-copying:
 *
 * - **Mime types are unreliable.** `video_note` and `sticker` carry none at
 *   all, `photo` carries none, and `getFile` explicitly does not preserve what
 *   was reported. Everything must be settled here, from the `Message`.
 * - **A sticker is not really an image.** See {@link StickerMode}.
 */

import type {InboundAttachment} from '../types.js';
import type {TelegramClient} from './client.js';
import type {TgMessage, TgPhotoSize, TgSticker} from './types.js';

/**
 * What to do with a sticker.
 *
 * A sticker's meaning lives in its `emoji` field, not its pixels: someone who
 * sends the 👍 sticker means *yes*. The artwork is decoration, and two of the
 * three sticker formats are unreadable by the model anyway — animated stickers
 * are gzipped Lottie JSON, and video stickers would cost video tokens for a
 * three-second loop.
 *
 * - `emoji` — text only, e.g. `[sticker: 👍]`. Free, works for every format.
 * - `emoji+thumbnail` — the above plus the WEBP/JPG thumbnail. The default.
 * - `image` — the full sticker for static ones, thumbnail otherwise.
 * - `ignore` — drop it.
 */
export type StickerMode = 'emoji' | 'emoji+thumbnail' | 'image' | 'ignore';

/**
 * What to do with a video or video note.
 *
 * Video is expensive. Applying Gemini's documented tokenization to a
 * 60-second, 384×384 video note gives roughly 15,500 frame tokens plus 1,900
 * for the audio track — about 18k tokens. The same minute as audio alone is
 * 1,920. `thumbnail` keeps the bot responsive without that bill.
 */
export type VideoMode = 'full' | 'thumbnail' | 'ignore';

/** Channel-level media behavior, distinct from the model-facing policy. */
export interface TelegramMediaOptions {
  /** Defaults to `'emoji+thumbnail'`. */
  sticker?: StickerMode;
  /** Defaults to `'full'` — a shared video is usually the point of the message. */
  video?: VideoMode;
  /** Defaults to `'thumbnail'`, since a video note is normally someone talking. */
  videoNote?: VideoMode;
}

/** What {@link extractAttachments} needs beyond the message. */
export interface ExtractOptions {
  client: TelegramClient;
  media?: TelegramMediaOptions;
  signal?: AbortSignal;
}

/**
 * Text the message contributes on top of its caption — currently the sticker
 * gloss, which has to reach the model as words.
 */
export interface ExtractedMedia {
  attachments: InboundAttachment[];
  /** Extra text describing media that cannot be sent as bytes. */
  notes: string[];
}

/** Pulls every attachment out of a Telegram message. */
export function extractAttachments(
  message: TgMessage,
  options: ExtractOptions,
): ExtractedMedia {
  const {client, signal} = options;
  const stickerMode = options.media?.sticker ?? 'emoji+thumbnail';
  const videoMode = options.media?.video ?? 'full';
  const videoNoteMode = options.media?.videoNote ?? 'thumbnail';

  const attachments: InboundAttachment[] = [];
  const notes: string[] = [];

  const file = (
    fileId: string,
    rest: Omit<InboundAttachment, 'download'>,
  ): InboundAttachment => ({
    ...rest,
    download: () => client.download(fileId, signal),
  });

  if (message.photo?.length) {
    const best = largestPhoto(message.photo);
    attachments.push(
      file(best.file_id, {
        kind: 'image',
        // Telegram reports no mime type for photos; they are always JPEG.
        mimeType: 'image/jpeg',
        sizeBytes: best.file_size,
      }),
    );
  }

  if (message.voice) {
    attachments.push(
      file(message.voice.file_id, {
        kind: 'audio',
        // Reported as the container, `audio/ogg`; the model's accepted list
        // names the codec. `normalizeMimeType` maps it to `audio/opus`.
        mimeType: message.voice.mime_type ?? 'audio/ogg',
        sizeBytes: message.voice.file_size,
        durationSec: message.voice.duration,
      }),
    );
  }

  if (message.audio) {
    attachments.push(
      file(message.audio.file_id, {
        kind: 'audio',
        mimeType: message.audio.mime_type ?? 'audio/mpeg',
        fileName: message.audio.file_name,
        sizeBytes: message.audio.file_size,
        durationSec: message.audio.duration,
      }),
    );
  }

  if (message.video) {
    const {video} = message;
    if (videoMode === 'full') {
      attachments.push(
        file(video.file_id, {
          kind: 'video',
          mimeType: video.mime_type ?? 'video/mp4',
          fileName: video.file_name,
          sizeBytes: video.file_size,
          durationSec: video.duration,
        }),
      );
    } else if (videoMode === 'thumbnail') {
      // The note goes in whether or not a still exists: a video the model
      // cannot see must still be something it knows arrived.
      if (video.thumbnail) {
        attachments.push(thumbnail(video.thumbnail, file));
      }
      notes.push(`[video, ${formatDuration(video.duration)}]`);
    }
  }

  if (message.video_note) {
    const note = message.video_note;
    if (videoNoteMode === 'full') {
      attachments.push(
        file(note.file_id, {
          kind: 'video',
          // No mime_type field exists on VideoNote; these are always MPEG-4.
          mimeType: 'video/mp4',
          sizeBytes: note.file_size,
          durationSec: note.duration,
        }),
      );
    } else if (videoNoteMode === 'thumbnail') {
      if (note.thumbnail) {
        attachments.push(thumbnail(note.thumbnail, file));
      }
      notes.push(`[video message, ${formatDuration(note.duration)}]`);
    }
  }

  if (message.animation) {
    const {animation} = message;
    // Telegram converts GIFs to silent MP4, which the model can read; a true
    // `image/gif` cannot be sent, so let the mime allowlist reject it.
    attachments.push(
      file(animation.file_id, {
        kind: 'video',
        mimeType: animation.mime_type ?? 'video/mp4',
        fileName: animation.file_name,
        sizeBytes: animation.file_size,
        durationSec: animation.duration,
      }),
    );
  }

  if (message.document) {
    const {document} = message;
    attachments.push(
      file(document.file_id, {
        kind: 'document',
        mimeType: document.mime_type,
        fileName: document.file_name,
        sizeBytes: document.file_size,
      }),
    );
  }

  if (message.sticker && stickerMode !== 'ignore') {
    const {sticker} = message;
    notes.push(describeSticker(sticker));

    const wantsImage =
      stickerMode === 'emoji+thumbnail' || stickerMode === 'image';
    if (wantsImage) {
      const source = stickerSource(sticker, stickerMode);
      if (source) {
        attachments.push(
          file(source.fileId, {
            kind: 'sticker',
            mimeType: source.mimeType,
            sizeBytes: source.sizeBytes,
          }),
        );
      }
    }
  }

  return {attachments, notes};
}

/**
 * Picks the largest photo size.
 *
 * Telegram sends an ascending array of sizes; taking `[0]` — the obvious
 * reading — gets a postage stamp the model cannot read.
 */
export function largestPhoto(sizes: readonly TgPhotoSize[]): TgPhotoSize {
  return sizes.reduce((best, size) =>
    (size.file_size ?? size.width * size.height) >
    (best.file_size ?? best.width * best.height)
      ? size
      : best,
  );
}

/** Which bytes to send for a sticker, if any. */
function stickerSource(
  sticker: TgSticker,
  mode: StickerMode,
): {fileId: string; mimeType: string; sizeBytes?: number} | undefined {
  const isStatic = !sticker.is_animated && !sticker.is_video;

  if (mode === 'image' && isStatic) {
    return {
      fileId: sticker.file_id,
      mimeType: 'image/webp',
      sizeBytes: sticker.file_size,
    };
  }

  // Animated (.tgs) and video (.webm) stickers have no readable still, so fall
  // back to the thumbnail, which Telegram guarantees is WEBP or JPG.
  if (sticker.thumbnail) {
    return {
      fileId: sticker.thumbnail.file_id,
      mimeType: 'image/webp',
      sizeBytes: sticker.thumbnail.file_size,
    };
  }

  return isStatic
    ? {
        fileId: sticker.file_id,
        mimeType: 'image/webp',
        sizeBytes: sticker.file_size,
      }
    : undefined;
}

/** The words a sticker stands for. */
export function describeSticker(sticker: TgSticker): string {
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : '';
  const set = sticker.set_name ? ` from "${sticker.set_name}"` : '';
  return `[sticker${emoji}${set}]`;
}

function thumbnail(
  size: TgPhotoSize,
  file: (
    id: string,
    rest: Omit<InboundAttachment, 'download'>,
  ) => InboundAttachment,
): InboundAttachment {
  return file(size.file_id, {
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: size.file_size,
  });
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
