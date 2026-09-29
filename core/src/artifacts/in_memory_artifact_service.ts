/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

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

export function isInMemoryConnectionString(uri: string): boolean {
  return uri === 'memory://';
}

/**
 * An in-memory implementation of the ArtifactService.
 */
export class InMemoryArtifactService implements BaseArtifactService {
  private readonly artifacts: Record<
    string,
    {part: Part; metadata: ArtifactVersion}[]
  > = {};

  saveArtifact({
    appName,
    userId,
    sessionId,
    filename,
    artifact,
    customMetadata,
  }: SaveArtifactRequest): Promise<number> {
    if (!artifact.inlineData && !artifact.text && !artifact.fileData) {
      return Promise.reject(
        new Error('Artifact must have either inlineData or text content.'),
      );
    }

    const path = artifactPath(appName, userId, sessionId, filename);

    if (!this.artifacts[path]) {
      this.artifacts[path] = [];
    }

    const version = this.artifacts[path].length;
    const metadata: ArtifactVersion = {
      version,
      canonicalUri: getCanonicalUri(
        appName,
        userId,
        sessionId,
        filename,
        version,
      ),
      customMetadata,
    };

    if (!artifact.inlineData && artifact.text === undefined) {
      const fileData = artifact.fileData!;

      metadata.mimeType = fileData.mimeType;
    }

    this.artifacts[path].push({part: artifact, metadata});

    return Promise.resolve(version);
  }

  loadArtifact({
    appName,
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<Part | undefined> {
    const path = artifactPath(appName, userId, sessionId, filename);
    const versions = this.artifacts[path];

    if (!versions) {
      return Promise.resolve(undefined);
    }

    if (version === undefined) {
      version = versions.length - 1;
    }

    if (!versions[version]) {
      logger.warn(
        `[InMemoryArtifactService] loadArtifact: Artifact ${filename} version ${version} not found`,
      );
      return Promise.resolve(undefined);
    }

    return Promise.resolve(versions[version].part);
  }

  listArtifactKeys({
    appName,
    userId,
    sessionId,
  }: ListArtifactKeysRequest): Promise<string[]> {
    const sessionPrefix = artifactPrefix('session', appName, userId, sessionId);
    const userPrefix = artifactPrefix('user', appName, userId);
    const filenames: string[] = [];

    for (const path in this.artifacts) {
      if (path.startsWith(sessionPrefix)) {
        filenames.push(decodeURIComponent(path.slice(sessionPrefix.length)));
      } else if (path.startsWith(userPrefix)) {
        filenames.push(decodeURIComponent(path.slice(userPrefix.length)));
      }
    }

    return Promise.resolve(filenames.sort());
  }

  deleteArtifact({
    appName,
    userId,
    sessionId,
    filename,
  }: DeleteArtifactRequest): Promise<void> {
    const path = artifactPath(appName, userId, sessionId, filename);
    if (!this.artifacts[path]) {
      return Promise.resolve();
    }
    delete this.artifacts[path];

    return Promise.resolve();
  }

  listVersions({
    appName,
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<number[]> {
    const path = artifactPath(appName, userId, sessionId, filename);
    const artifacts = this.artifacts[path];

    if (!artifacts) {
      return Promise.resolve([]);
    }

    const versions: number[] = [];
    for (let i = 0; i < artifacts.length; i++) {
      versions.push(i);
    }

    return Promise.resolve(versions);
  }

  listArtifactVersions({
    appName,
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<ArtifactVersion[]> {
    const path = artifactPath(appName, userId, sessionId, filename);
    const artifacts = this.artifacts[path];

    if (!artifacts) {
      return Promise.resolve([]);
    }

    return Promise.resolve(artifacts.map((a) => a.metadata));
  }

  getArtifactVersion({
    appName,
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<ArtifactVersion | undefined> {
    const path = artifactPath(appName, userId, sessionId, filename);
    const versions = this.artifacts[path];

    if (!versions) {
      return Promise.resolve(undefined);
    }

    if (version === undefined) {
      version = versions.length - 1;
    }

    if (versions[version]) {
      return Promise.resolve(versions[version].metadata);
    }

    return Promise.resolve(undefined);
  }
}

/**
 * Constructs the storage key for the artifact.
 *
 * @param appName The app name.
 * @param userId The user ID.
 * @param sessionId The session ID.
 * @param filename The filename.
 * @return The encoded storage key for the artifact.
 */
function artifactPath(
  appName: string,
  userId: string,
  sessionId: string,
  filename: string,
): string {
  if (fileHasUserNamespace(filename)) {
    return `${artifactPrefix('user', appName, userId)}${encodeURIComponent(filename)}`;
  }

  return `${artifactPrefix('session', appName, userId, sessionId)}${encodeURIComponent(filename)}`;
}

function artifactPrefix(scope: string, ...parts: string[]): string {
  return `${[scope, ...parts].map(encodeURIComponent).join('/')}/`;
}

/**
 * Builds the canonical URI for an artifact version.
 *
 * Segments are interpolated raw, which matches the `memory://` URIs the other
 * ADK language implementations produce. The URI is metadata only; the storage
 * key from `artifactPath()` stays URL-encoded and remains the lookup key.
 *
 * @param appName The app name.
 * @param userId The user ID.
 * @param sessionId The session ID.
 * @param filename The filename.
 * @param version The zero-based version number.
 * @return The canonical URI for the artifact version.
 */
function getCanonicalUri(
  appName: string,
  userId: string,
  sessionId: string,
  filename: string,
  version: number,
): string {
  if (fileHasUserNamespace(filename)) {
    return `memory://apps/${appName}/users/${userId}/artifacts/${filename}/versions/${version}`;
  }

  return `memory://apps/${appName}/users/${userId}/sessions/${sessionId}/artifacts/${filename}/versions/${version}`;
}

/**
 * Checks if the filename has a user namespace prefix.
 *
 * @param filename The filename to check.
 * @return true if the filename has a user namespace (starts with "user:") false
 *     otherwise.
 */
function fileHasUserNamespace(filename: string): boolean {
  return filename.startsWith('user:');
}
