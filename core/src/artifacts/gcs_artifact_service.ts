/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Bucket, File, StorageOptions} from '@google-cloud/storage';
import {createPartFromBase64, createPartFromText, Part} from '@google/genai';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {
  ArtifactVersion,
  BaseArtifactService,
  DeleteArtifactRequest,
  ListArtifactKeysRequest,
  ListVersionsRequest,
  LoadArtifactRequest,
  SaveArtifactRequest,
} from './base_artifact_service.js';

const GCS_FILE_URI_METADATA_KEY = 'adkFileUri';
const GCS_FILE_MIME_TYPE_METADATA_KEY = 'adkFileMimeType';
const GCS_DISPLAY_NAME_METADATA_KEY = 'adkDisplayName';
const GCS_IS_TEXT_METADATA_KEY = 'adkIsText';

export class GcsArtifactService implements BaseArtifactService {
  private readonly bucketName: string;
  private readonly storageOptions?: StorageOptions;
  private bucketPromise?: Promise<Bucket>;

  constructor(bucket: string, options?: StorageOptions) {
    this.bucketName = bucket;
    this.storageOptions = options;
  }

  /**
   * Resolves the GCS bucket handle, loading the `@google-cloud/storage`
   * optional peer on first use.
   */
  private getBucket(): Promise<Bucket> {
    this.bucketPromise ??= loadOptionalPeer(
      {packageName: '@google-cloud/storage', feature: 'GcsArtifactService'},
      () => import('@google-cloud/storage'),
    ).then(({Storage}) =>
      new Storage(this.storageOptions).bucket(this.bucketName),
    );
    return this.bucketPromise;
  }

  async saveArtifact(request: SaveArtifactRequest): Promise<number> {
    if (
      !request.artifact.inlineData &&
      !request.artifact.text &&
      !request.artifact.fileData
    ) {
      throw new Error('Artifact must have either inlineData or text content.');
    }

    const versions = await this.listVersions(request);
    const version = versions.length > 0 ? Math.max(...versions) + 1 : 0;
    const bucket = await this.getBucket();
    const file = bucket.file(
      getFileName({
        ...request,
        version,
      }),
    );

    const customMetadata: Record<string, unknown> = {
      ...request.customMetadata,
    };

    if (request.artifact.inlineData) {
      if (request.artifact.inlineData.displayName) {
        customMetadata[GCS_DISPLAY_NAME_METADATA_KEY] =
          request.artifact.inlineData.displayName;
      }
      await file.save(
        Buffer.from(request.artifact.inlineData.data || '', 'base64'),
        {
          contentType: request.artifact.inlineData.mimeType,
          metadata: {metadata: customMetadata},
        },
      );

      return version;
    } else if (request.artifact.text !== undefined) {
      await file.save(request.artifact.text, {
        contentType: 'text/plain',
        metadata: {
          metadata: {...customMetadata, [GCS_IS_TEXT_METADATA_KEY]: 'true'},
        },
      });

      return version;
    } else {
      const fileData = request.artifact.fileData;
      const fileUri = fileData?.fileUri;
      if (!fileUri) {
        throw new Error('Artifact fileData must have a fileUri.');
      }
      // Store the URI and mime_type (if any) as blob metadata; no content to upload.
      customMetadata[GCS_FILE_URI_METADATA_KEY] = fileUri;
      if (fileData.mimeType) {
        customMetadata[GCS_FILE_MIME_TYPE_METADATA_KEY] = fileData.mimeType;
      }
      await file.save('', {
        contentType: fileData.mimeType || undefined,
        metadata: {metadata: customMetadata},
      });
      return version;
    }
  }

  async loadArtifact(request: LoadArtifactRequest): Promise<Part | undefined> {
    try {
      let version = request.version;
      if (version === undefined) {
        const versions = await this.listVersions(request);

        if (versions.length === 0) {
          return undefined;
        }

        version = Math.max(...versions);
      }

      const file = (await this.getBucket()).file(
        getFileName({
          ...request,
          version,
        }),
      );
      const [metadata] = await file.getMetadata();
      const customMeta = (metadata.metadata ?? {}) as Record<string, unknown>;
      const fileUri = customMeta[GCS_FILE_URI_METADATA_KEY] as
        | string
        | undefined;

      if (fileUri) {
        const mimeType =
          (customMeta[GCS_FILE_MIME_TYPE_METADATA_KEY] as string | undefined) ??
          metadata.contentType ??
          undefined;
        return {fileData: {fileUri, mimeType}};
      }

      const [rawDataBuffer] = await file.download();

      const displayName = customMeta[GCS_DISPLAY_NAME_METADATA_KEY] as
        | string
        | undefined;
      if (displayName) {
        return {
          inlineData: {
            data: rawDataBuffer.toString('base64'),
            mimeType: metadata.contentType,
            displayName,
          },
        };
      }

      if (
        customMeta[GCS_IS_TEXT_METADATA_KEY] === 'true' ||
        metadata.contentType === 'text/plain'
      ) {
        return createPartFromText(rawDataBuffer.toString('utf-8'));
      }

      return createPartFromBase64(
        rawDataBuffer.toString('base64'),
        metadata.contentType!,
      );
    } catch (e) {
      logger.warn(
        `[GcsArtifactService] loadArtifact: Failed to load artifact ${request.filename}`,
        e,
      );
      return undefined;
    }
  }

  async listArtifactKeys(request: ListArtifactKeysRequest): Promise<string[]> {
    const sessionPrefix = `${request.appName}/${request.userId}/${request.sessionId}/`;
    const usernamePrefix = `${request.appName}/${request.userId}/user/`;
    const bucket = await this.getBucket();
    const [[sessionFiles], [userSessionFiles]] = await Promise.all([
      bucket.getFiles({prefix: sessionPrefix}),
      bucket.getFiles({prefix: usernamePrefix}),
    ]);

    return [
      ...extractArtifactKeys(sessionFiles, sessionPrefix),
      ...extractArtifactKeys(userSessionFiles, usernamePrefix, 'user:'),
    ].sort((a, b) => a.localeCompare(b));
  }

  async deleteArtifact(request: DeleteArtifactRequest): Promise<void> {
    const versions = await this.listVersions(request);
    const bucket = await this.getBucket();

    await Promise.all(
      versions.map((version) => {
        const file = bucket.file(
          getFileName({
            ...request,
            version,
          }),
        );

        return file.delete();
      }),
    );

    return;
  }

  async listVersions(request: ListVersionsRequest): Promise<number[]> {
    const prefix = getFileName(request);
    // We need to add a trailing slash to prefix to ensure we only get children
    const searchPrefix = prefix + '/';
    const bucket = await this.getBucket();
    const [files] = await bucket.getFiles({prefix: searchPrefix});
    const versions = [];
    for (const file of files) {
      // GCS is a flat namespace: 'doc/' also matches 'doc/nested/3', a version
      // of the distinct artifact 'doc/nested'. Only '{prefix}{digits}' is ours.
      const suffix = file.name.slice(searchPrefix.length);
      if (/^\d+$/.test(suffix)) {
        versions.push(Number(suffix));
      }
    }

    return versions.sort((a, b) => a - b);
  }

  async listArtifactVersions(
    request: ListVersionsRequest,
  ): Promise<ArtifactVersion[]> {
    const versions = await this.listVersions(request);
    const artifactVersions: ArtifactVersion[] = [];

    for (const version of versions) {
      const artifactVersion = await this.getArtifactVersion({
        ...request,
        version,
      });

      if (artifactVersion) {
        artifactVersions.push(artifactVersion);
      }
    }

    return artifactVersions;
  }

  async getArtifactVersion(
    request: LoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined> {
    try {
      let version = request.version;
      if (version === undefined) {
        const versions = await this.listVersions(request);
        if (versions.length === 0) {
          return undefined;
        }
        version = Math.max(...versions);
      }

      const file = (await this.getBucket()).file(
        getFileName({
          ...request,
          version,
        }),
      );

      const [metadata] = await file.getMetadata();

      return {
        version,
        mimeType: metadata.contentType,
        customMetadata: metadata.metadata as Record<string, unknown>,
        canonicalUri: file.publicUrl(),
      };
    } catch (e) {
      logger.warn(
        `[GcsArtifactService] getArtifactVersion: Failed to get artifact version for userId: ${request.userId} sessionId: ${request.sessionId} filename: ${request.filename} version: ${request.version}`,
        e,
      );
      return undefined;
    }
  }
}

function getFileName({
  appName,
  userId,
  sessionId,
  filename,
  version,
}: LoadArtifactRequest): string {
  const isUser = filename.startsWith('user:');
  const cleanFilename = isUser ? filename.substring(5) : filename;

  const prefix = isUser
    ? `${appName}/${userId}/user/${cleanFilename}`
    : `${appName}/${userId}/${sessionId}/${cleanFilename}`;

  return version !== undefined ? `${prefix}/${version}` : prefix;
}

function extractArtifactKeys(
  files: File[],
  fileNamePrefix: string,
  keyPrefix: string = '',
): string[] {
  const keys = new Set<string>();
  for (const file of files) {
    if (!file.name.startsWith(fileNamePrefix)) {
      continue;
    }

    const relative = file.name.substring(fileNamePrefix.length);
    const name = getFileNameFromPath(relative);

    keys.add(`${keyPrefix}${name}`);
  }

  return [...keys];
}

function getFileNameFromPath(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length < 2) {
    return filePath;
  }

  return parts.slice(0, -1).join('/');
}
