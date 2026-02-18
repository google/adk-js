/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GcsArtifactService} from '@google/adk';
import {describe, vi} from 'vitest';
import {runArtifactServiceTests} from './artifact_service_test_utils.js';

const {StorageMock, storageMock} = vi.hoisted(() => {
  class FakeGcsFile {
    constructor(
      public name: string,
      private bucket: FakeGcsBucket,
    ) {}

    async save(
      data: string | Buffer,
      options?: {contentType?: string; metadata?: Record<string, unknown>},
    ): Promise<void> {
      this.bucket.files.set(this.name, {
        data: Buffer.isBuffer(data) ? data : Buffer.from(data),
        metadata: options?.metadata || {},
        contentType: options?.contentType,
      });
    }

    async download(): Promise<[Buffer]> {
      const file = this.bucket.files.get(this.name);
      if (!file) {
        throw new Error(`File not found: ${this.name}`);
      }
      return [file.data];
    }

    async getMetadata(): Promise<
      [{contentType?: string; metadata?: Record<string, unknown>}]
    > {
      const file = this.bucket.files.get(this.name);
      if (!file) {
        throw new Error(`File not found: ${this.name}`);
      }
      return [{contentType: file.contentType, metadata: file.metadata}];
    }

    async delete(): Promise<void> {
      this.bucket.files.delete(this.name);
    }

    publicUrl(): string {
      return `https://storage.googleapis.com/${this.bucket.name}/${this.name}`;
    }
  }

  class FakeGcsBucket {
    files = new Map<
      string,
      {
        data: Buffer;
        metadata: Record<string, unknown>;
        contentType?: string;
      }
    >();

    constructor(public name: string) {}

    file(name: string): FakeGcsFile {
      return new FakeGcsFile(name, this);
    }

    async getFiles(options?: {prefix?: string}): Promise<[FakeGcsFile[]]> {
      let files = Array.from(this.files.keys()).map((name) => this.file(name));
      if (options?.prefix) {
        files = files.filter((f) => f.name.startsWith(options.prefix!));
      }
      return [files];
    }
  }

  class FakeStorage {
    buckets = new Map<string, FakeGcsBucket>();

    bucket(name: string): FakeGcsBucket {
      if (!this.buckets.has(name)) {
        this.buckets.set(name, new FakeGcsBucket(name));
      }
      return this.buckets.get(name)!;
    }
  }

  const storageMock = new FakeStorage();
  const StorageMock = vi.fn(() => storageMock);
  return {StorageMock, storageMock};
});

vi.mock('@google-cloud/storage', () => {
  return {
    Storage: StorageMock,
  };
});

describe('GcsArtifactService', () => {
  const bucketName = 'test-bucket';

  runArtifactServiceTests(
    async () => {
      storageMock.buckets.clear();
      return new GcsArtifactService(bucketName);
    },
    async () => {
      storageMock.buckets.clear();
    },
  );
});
