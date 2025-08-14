/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {BaseArtifactService} from './base_artifact_service.js';

/**
 * An in-memory implementation of the ArtifactService.
 */
export class InMemoryArtifactService implements BaseArtifactService {
  private readonly artifacts: Record<string, Part[]> = {};

  saveArtifact(
      appName: string,
      userId: string,
      sessionId: string,
      filename: string,
      artifact: Part,
      ): Promise<number> {
    const path = artifactPath(appName, userId, sessionId, filename);

    if (!this.artifacts[path]) {
      this.artifacts[path] = [];
    }

    const version = this.artifacts[path].length;
    this.artifacts[path].push(artifact);

    return Promise.resolve(version);
  }

  loadArtifact(
      appName: string,
      userId: string,
      sessionId: string,
      filename: string,
      version: number = -1,
      ): Promise<Part|undefined> {
    const path = artifactPath(appName, userId, sessionId, filename);
    const versions = this.artifacts[path];

    if (!versions) {
      return Promise.resolve(undefined);
    }

    return Promise.resolve(versions[version]);
  }

  listArtifactKeys(
      appName: string,
      userId: string,
      sessionId: string,
      ): Promise<string[]> {
    const sessionPrefix = `${appName}/${userId}/${sessionId}/`;
    const usernamespacePrefix = `${appName}/${userId}/user/`;
    const filenames: string[] = [];

    for (const path in this.artifacts) {
      if (path.startsWith(sessionPrefix)) {
        const filename = path.replace(sessionPrefix, '');
        filenames.push(filename);
      } else if (path.startsWith(usernamespacePrefix)) {
        const filename = path.replace(usernamespacePrefix, '');
        filenames.push(filename);
      }
    }

    return Promise.resolve(filenames.sort());
  }

  deleteArtifact(
      appName: string,
      userId: string,
      sessionId: string,
      filename: string,
      ): Promise<void> {
    const path = artifactPath(appName, userId, sessionId, filename);
    if (!this.artifacts[path]) {
      return Promise.resolve();
    }
    delete this.artifacts[path];

    return Promise.resolve();
  }

  listVersions(
      appName: string,
      userId: string,
      sessionId: string,
      filename: string,
      ): Promise<number[]> {
    const path = artifactPath(appName, userId, sessionId, filename);
    const artifacts = this.artifacts[path];

    if (!artifacts) {
      return Promise.resolve([]);
    }

    let versions: number[] = [];
    for (let i = 0; i < artifacts.length; i++) {
      versions.push(i);
    }

    return Promise.resolve(versions);
  }
}

/**
 * Constructs the path to the artifact.
 *
 * @param appName The app name.
 * @param userId The user ID.
 * @param sessionId The session ID.
 * @param filename The filename.
 * @return The path to the artifact.
 */
function artifactPath(
    appName: string,
    userId: string,
    sessionId: string,
    filename: string,
    ): string {
  if (fileHasUserNamespace(filename)) {
    return `${appName}/${userId}/user/${filename}`;
  }

  return `${appName}/${userId}/${sessionId}/${filename}`;
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
