/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Bucket, File, Storage} from '@google-cloud/storage';
import {createPartFromBase64, createPartFromText, Part} from '@google/genai';
import {logger} from '../utils/logger.js';

import {
  ArtifactVersion,
  BaseArtifactService,
  DeleteArtifactRequest,
  ListArtifactKeysRequest,
  ListVersionsRequest,
  LoadArtifactRequest,
  SaveArtifactRequest,
} from './base_artifact_service.js';

export class GcsArtifactService implements BaseArtifactService {
  private readonly bucket: Bucket;

  constructor(bucket: string) {
    this.bucket = new Storage().bucket(bucket);
  }

  async saveArtifact(request: SaveArtifactRequest): Promise<number> {
    if (!request.artifact.inlineData && !request.artifact.text) {
      throw new Error('Artifact must have either inlineData or text content.');
    }

    const versions = await this.listVersions(request);
    const version = versions.length > 0 ? Math.max(...versions) + 1 : 0;
    const file = this.bucket.file(
      getFileName({
        ...request,
        version,
      }),
    );

    const metadata = request.customMetadata || {};

    if (request.artifact.inlineData) {
      await file.save(
        Buffer.from(request.artifact.inlineData.data || '', 'base64'),
        {
          contentType: request.artifact.inlineData.mimeType,
          metadata,
        },
      );

      return version;
    }

    await file.save(request.artifact.text!, {
      contentType: 'text/plain',
      metadata,
    });

    return version;
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

      const file = this.bucket.file(
        getFileName({
          ...request,
          version,
        }),
      );
      const [[metadata], [rawDataBuffer]] = await Promise.all([
        file.getMetadata(),
        file.download(),
      ]);

      if (metadata.contentType === 'text/plain') {
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
    const [[sessionFiles], [userSessionFiles]] = await Promise.all([
      this.bucket.getFiles({prefix: sessionPrefix}),
      this.bucket.getFiles({prefix: usernamePrefix}),
    ]);

    return [
      ...extractArtifactKeys(sessionFiles, sessionPrefix),
      ...extractArtifactKeys(userSessionFiles, usernamePrefix, 'user:'),
    ].sort((a, b) => a.localeCompare(b));
  }

  async deleteArtifact(request: DeleteArtifactRequest): Promise<void> {
    const versions = await this.listVersions(request);

    await Promise.all(
      versions.map((version) => {
        const file = this.bucket.file(
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
    const [files] = await this.bucket.getFiles({prefix: searchPrefix});
    const versions = [];
    for (const file of files) {
      const version = file.name.split('/').pop()!;
      const v = parseInt(version, 10);
      if (!isNaN(v)) {
        versions.push(v);
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

      const file = this.bucket.file(
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
