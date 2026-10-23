/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type Bucket, Storage} from '@google-cloud/storage';

// Matches google-cloud-storage's multipart ceiling: larger payloads use a
// resumable upload.
const MAX_MULTIPART_BYTES = 8 * 1024 * 1024;

/**
 * Uploads large or binary content to GCS so rows can reference it instead of
 * inlining it.
 */
export class GcsOffloader {
  private readonly bucket: Bucket;

  constructor({
    projectId,
    bucketName,
    storage,
  }: {
    projectId: string;
    bucketName: string;
    storage?: Storage;
  }) {
    this.bucket = (storage ?? new Storage({projectId})).bucket(bucketName);
  }

  async uploadContent({
    data,
    contentType,
    path,
  }: {
    data: Buffer | string;
    contentType: string;
    path: string;
  }): Promise<string> {
    // Create-only: object names are unique by construction, so a collision
    // fails the upload instead of silently rebinding an existing row to another
    // event's bytes.
    await this.bucket.file(path).save(data, {
      contentType,
      resumable: Buffer.byteLength(data) > MAX_MULTIPART_BYTES,
      preconditionOpts: {ifGenerationMatch: 0},
    });
    return `gs://${this.bucket.name}/${path}`;
  }
}
