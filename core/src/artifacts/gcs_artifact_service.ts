/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Bucket, Storage} from '@google-cloud/storage';
import {createPartFromBase64, createPartFromText, Part} from '@google/genai';

import {BaseArtifactService, DeleteArtifactRequest, ListArtifactKeysRequest, ListVersionsRequest, LoadArtifactRequest, SaveArtifactRequest} from './base_artifact_service.js';

export class GcsArtifactService implements BaseArtifactService {
  private readonly bucket: Bucket;

  constructor(bucket: string) {
    this.bucket = new Storage().bucket(bucket);
  }

  async saveArtifact(request: SaveArtifactRequest): Promise<number> {
    const versions = await this.listVersions(request);
    const version = versions.length > 0 ? Math.max(...versions) + 1 : 0;
    const file = this.bucket.file(getFileName({
      ...request,
      version,
    }));

    if (request.artifact.inlineData) {
      await file.save(JSON.stringify(request.artifact.inlineData.data), {
        contentType: request.artifact.inlineData.mimeType,
      });

      return version;
    }

    if (request.artifact.text) {
      await file.save(request.artifact.text, {
        contentType: 'text/plain',
      });

      return version;
    }

    throw new Error('Artifact must have either inlineData or text.')
  }

  async loadArtifact(request: LoadArtifactRequest): Promise<Part|undefined> {
    let version = request.version;
    if (version === undefined) {
      const versions = await this.listVersions(request);

      if (versions.length === 0) {
        return undefined;
      }

      version = Math.max(...versions);
    }

    const file = this.bucket.file(getFileName({
      ...request,
      version,
    }));
    const [[metadata], [rawDataBuffer]] =
        await Promise.all([file.getMetadata(), file.download()]);

    if (metadata.contentType === 'text/plain') {
      return createPartFromText(rawDataBuffer.toString('utf-8'));
    }

    return createPartFromBase64(
        rawDataBuffer.toString('base64'), metadata.contentType!);
  }

  async listArtifactKeys(request: ListArtifactKeysRequest): Promise<string[]> {
    const fileNames: string[] = [];
    const sessionPrefix =
        `${request.appName}/${request.userId}/${request.sessionId}/`;
    const usernamePrefix = `${request.appName}/${request.userId}/user/`;
    const [
        [sessionFiles],
        [userSessionFiles],
    ] =
        await Promise.all([
          this.bucket.getFiles({prefix: sessionPrefix}),
          this.bucket.getFiles({prefix: usernamePrefix}),
        ]);

    for (const file of sessionFiles) {
      fileNames.push(file.name.split('/').pop()!);
    }
    for (const file of userSessionFiles) {
      fileNames.push(file.name.split('/').pop()!);
    }

    return fileNames.sort((a, b) => a.localeCompare(b));
  }

  async deleteArtifact(request: DeleteArtifactRequest): Promise<void> {
    const versions = await this.listVersions(request);

    await Promise.all(versions.map(version => {
      const file = this.bucket.file(getFileName({
        ...request,
        version,
      }));

      return file.delete();
    }));

    return
  }

  async listVersions(request: ListVersionsRequest): Promise<number[]> {
    const prefix = getFileName(request);
    const [files] = await this.bucket.getFiles({prefix});
    const versions = [];
    for (const file of files) {
      const version = file.name.split('/').pop()!;
      versions.push(parseInt(version, 10));
    }

    return versions
  }
}

function getFileName({
  appName,
  userId,
  sessionId,
  filename,
  version,
}: LoadArtifactRequest): string {
  if (filename.startsWith('user:')) {
    return `${appName}/${userId}/user/${filename}/${version}`;
  }
  return `${appName}/${userId}/${sessionId}/${filename}/${version}`;
}
