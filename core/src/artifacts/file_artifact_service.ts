/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import * as fs from 'fs/promises';
import * as path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';

import {
  BaseArtifactService,
  DeleteArtifactRequest,
  ListArtifactKeysRequest,
  ListVersionsRequest,
  LoadArtifactRequest,
  SaveArtifactRequest,
} from './base_artifact_service.js';

const USER_NAMESPACE_PREFIX = 'user:';

/**
 * Metadata for a file artifact version.
 */
interface FileArtifactVersion {
  fileName?: string;
  mimeType?: string;
  version: number;
  canonicalUri?: string;
  customMetadata?: Record<string, unknown>;
}

/**
 * Service for managing artifacts stored on the local filesystem.
 */
export class FileArtifactService implements BaseArtifactService {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /**
   * Initializes the service by ensuring the root directory exists.
   */
  async init(): Promise<void> {
    await fs.mkdir(this.rootDir, {recursive: true});
  }

  async saveArtifact({
    userId,
    sessionId,
    filename,
    artifact,
  }: SaveArtifactRequest): Promise<number> {
    const artifactDir = await this.getArtifactDir(userId, sessionId, filename);
    await fs.mkdir(artifactDir, {recursive: true});

    const versions = await this.listVersionsOnDisk(artifactDir);
    const nextVersion =
      versions.length > 0 ? versions[versions.length - 1] + 1 : 0;

    const versionsDir = this.getVersionsDir(artifactDir);
    const versionDir = path.join(versionsDir, nextVersion.toString());
    await fs.mkdir(versionDir, {recursive: true});

    const storedFilename = path.basename(artifactDir); // using the directory name which is the sanitized filename
    const contentPath = path.join(versionDir, storedFilename);

    let mimeType: string | undefined;
    if (artifact.inlineData) {
      const data = artifact.inlineData.data || '';
      await fs.writeFile(contentPath, Buffer.from(data, 'base64'));
      mimeType = artifact.inlineData.mimeType || 'application/octet-stream';
    } else if (artifact.text !== undefined) {
      await fs.writeFile(contentPath, artifact.text, 'utf-8');
    } else {
      throw new Error('Artifact must have either inlineData or text content.');
    }

    const canonicalUri = await this.getCanonicalUri(
      userId,
      sessionId,
      filename,
      nextVersion,
    );
    const metadata: FileArtifactVersion = {
      fileName: filename,
      mimeType,
      version: nextVersion,
      canonicalUri,
    };

    await this.writeMetadata(path.join(versionDir, 'metadata.json'), metadata);

    return nextVersion;
  }

  async loadArtifact({
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<Part | undefined> {
    try {
      const artifactDir = await this.getArtifactDir(
        userId,
        sessionId,
        filename,
      );

      try {
        await fs.access(artifactDir);
      } catch {
        return undefined;
      }

      const versions = await this.listVersionsOnDisk(artifactDir);
      if (versions.length === 0) {
        return undefined;
      }

      let versionToLoad: number;
      if (version === undefined) {
        versionToLoad = versions[versions.length - 1];
      } else {
        if (!versions.includes(version)) {
          return undefined;
        }
        versionToLoad = version;
      }

      const versionDir = path.join(
        this.getVersionsDir(artifactDir),
        versionToLoad.toString(),
      );
      const metadataPath = path.join(versionDir, 'metadata.json');
      const metadata = await this.readMetadata(metadataPath);

      const storedFilename = path.basename(artifactDir);
      let contentPath = path.join(versionDir, storedFilename);

      if (metadata.canonicalUri) {
        const uriPath = this.fileUriToPath(metadata.canonicalUri);
        if (uriPath) {
          try {
            await fs.access(uriPath);
            contentPath = uriPath;
          } catch {
            // ignore, check local path
          }
        }
      }

      if (metadata.mimeType) {
        try {
          const data = await fs.readFile(contentPath);
          return {
            inlineData: {
              mimeType: metadata.mimeType,
              data: data.toString('base64'),
            },
          };
        } catch {
          console.warn(`Binary artifact ${filename} missing at ${contentPath}`);
          return undefined;
        }
      }

      try {
        const text = await fs.readFile(contentPath, 'utf-8');
        return {text};
      } catch {
        console.warn(`Text artifact ${filename} missing at ${contentPath}`);
        return undefined;
      }
    } catch (e) {
      console.error('Error loading artifact', e);
      return undefined;
    }
  }

  async listArtifactKeys({
    userId,
    sessionId,
  }: ListArtifactKeysRequest): Promise<string[]> {
    const filenames: Set<string> = new Set();
    const baseRoot = this.getBaseRoot(userId);

    // Session artifacts
    const sessionRoot = this.getSessionArtifactsDir(baseRoot, sessionId);
    const sessionArtifactDirs = await this.iterArtifactDirs(sessionRoot);

    for (const artifactDir of sessionArtifactDirs) {
      const metadata = await this.getLatestMetadata(artifactDir);
      if (metadata?.fileName) {
        filenames.add(metadata.fileName);
      } else {
        const rel = path.relative(sessionRoot, artifactDir);
        filenames.add(rel.split(path.sep).join('/'));
      }
    }

    // User artifacts
    const userRoot = this.getUserArtifactsDir(baseRoot);
    const userArtifactDirs = await this.iterArtifactDirs(userRoot);

    for (const artifactDir of userArtifactDirs) {
      const metadata = await this.getLatestMetadata(artifactDir);
      if (metadata?.fileName) {
        filenames.add(metadata.fileName);
      } else {
        const rel = path.relative(userRoot, artifactDir);
        filenames.add(
          `${USER_NAMESPACE_PREFIX}${rel.split(path.sep).join('/')}`,
        );
      }
    }

    return Array.from(filenames).sort();
  }

  async deleteArtifact({
    userId,
    sessionId,
    filename,
  }: DeleteArtifactRequest): Promise<void> {
    try {
      const artifactDir = await this.getArtifactDir(
        userId,
        sessionId,
        filename,
      );
      await fs.rm(artifactDir, {recursive: true, force: true});
    } catch (e) {
      // ignore if not found or other errors
      console.debug(`Failed to delete artifact ${filename}`, e);
    }
  }

  async listVersions({
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<number[]> {
    try {
      const artifactDir = await this.getArtifactDir(
        userId,
        sessionId,
        filename,
      );
      return await this.listVersionsOnDisk(artifactDir);
    } catch {
      return [];
    }
  }

  // --- Private Helpers ---

  private getBaseRoot(userId: string): string {
    return path.join(this.rootDir, 'users', userId);
  }

  private isUserScoped(
    sessionId: string | undefined,
    filename: string,
  ): boolean {
    return !sessionId || filename.startsWith(USER_NAMESPACE_PREFIX);
  }

  private getUserArtifactsDir(baseRoot: string): string {
    return path.join(baseRoot, 'artifacts');
  }

  private getSessionArtifactsDir(baseRoot: string, sessionId: string): string {
    return path.join(baseRoot, 'sessions', sessionId, 'artifacts');
  }

  private getVersionsDir(artifactDir: string): string {
    return path.join(artifactDir, 'versions');
  }

  private async getArtifactDir(
    userId: string,
    sessionId: string,
    filename: string,
  ): Promise<string> {
    const baseRoot = this.getBaseRoot(userId);
    let scopeRoot: string;

    if (this.isUserScoped(sessionId, filename)) {
      scopeRoot = this.getUserArtifactsDir(baseRoot);
    } else {
      if (!sessionId) {
        throw new Error(
          'Session ID must be provided for session-scoped artifacts.',
        );
      }
      scopeRoot = this.getSessionArtifactsDir(baseRoot, sessionId);
    }

    // Resolve scopeRoot to absolute path to ensure safety
    // Assuming rootDir is absolute (handled in constructor)
    // baseRoot is absolute. scopeRoot is absolute.

    // Strip user namespace if present
    let cleanFilename = filename;
    if (cleanFilename.startsWith(USER_NAMESPACE_PREFIX)) {
      cleanFilename = cleanFilename.substring(USER_NAMESPACE_PREFIX.length);
    }
    cleanFilename = cleanFilename.trim();

    // Use pure posix path-like processing to avoid Windows issues if needed,
    // but Node's path module handles sanitization mostly.

    if (path.isAbsolute(cleanFilename)) {
      throw new Error(
        `Absolute artifact filename ${filename} is not permitted.`,
      );
    }

    // We treat the filename as a relative path to scopeRoot
    const artifactDir = path.resolve(scopeRoot, cleanFilename);

    // Security check: Ensure artifactDir is inside scopeRoot
    const relative = path.relative(scopeRoot, artifactDir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `Artifact filename ${filename} escapes storage directory.`,
      );
    }

    // Python logic: if relative == ".", return "artifact"
    if (relative === '' || relative === '.') {
      return path.join(scopeRoot, 'artifact');
    }

    return artifactDir;
  }

  private async listVersionsOnDisk(artifactDir: string): Promise<number[]> {
    const versionsDir = this.getVersionsDir(artifactDir);
    try {
      const files = await fs.readdir(versionsDir, {withFileTypes: true});
      const versions = files
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => parseInt(dirent.name, 10))
        .filter((v) => !isNaN(v));
      return versions.sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  private async getCanonicalUri(
    userId: string,
    sessionId: string,
    filename: string,
    version: number,
  ): Promise<string> {
    const artifactDir = await this.getArtifactDir(userId, sessionId, filename);
    const storedFilename = path.basename(artifactDir);
    const versionsDir = this.getVersionsDir(artifactDir);
    const payloadPath = path.join(
      versionsDir,
      version.toString(),
      storedFilename,
    );
    return pathToFileURL(payloadPath).toString();
  }

  private async writeMetadata(
    metadataPath: string,
    metadata: FileArtifactVersion,
  ): Promise<void> {
    await fs.writeFile(
      metadataPath,
      JSON.stringify(metadata, null, 2),
      'utf-8',
    );
  }

  private async readMetadata(
    metadataPath: string,
  ): Promise<FileArtifactVersion> {
    const content = await fs.readFile(metadataPath, 'utf-8');
    return JSON.parse(content) as FileArtifactVersion;
  }

  private async getLatestMetadata(
    artifactDir: string,
  ): Promise<FileArtifactVersion | null> {
    const versions = await this.listVersionsOnDisk(artifactDir);
    if (versions.length === 0) {
      return null;
    }
    const latestVersion = versions[versions.length - 1];
    const metadataPath = path.join(
      this.getVersionsDir(artifactDir),
      latestVersion.toString(),
      'metadata.json',
    );
    try {
      return await this.readMetadata(metadataPath);
    } catch {
      return null;
    }
  }

  private async iterArtifactDirs(root: string): Promise<string[]> {
    const artifactDirs: string[] = [];
    try {
      await this.walkAndFindVersions(root, artifactDirs);
    } catch {
      // root might not exist
    }
    return artifactDirs;
  }

  private async walkAndFindVersions(
    currentDir: string,
    results: string[],
  ): Promise<void> {
    try {
      const entries = await fs.readdir(currentDir, {withFileTypes: true});

      // check if 'versions' exists here
      const hasVersions = entries.some(
        (e) => e.isDirectory() && e.name === 'versions',
      );
      if (hasVersions) {
        results.push(currentDir);
        // In Python's _iter_artifact_dirs: if (current / "versions").exists(): artifact_dirs.append(current); dirnames.clear()
        // This means we stop recursing if we found an artifact container.
        return;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          await this.walkAndFindVersions(
            path.join(currentDir, entry.name),
            results,
          );
        }
      }
    } catch {
      // ignore access errors
    }
  }

  private fileUriToPath(uri: string): string | null {
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  }
}
