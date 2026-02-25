/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import * as fs from 'fs/promises';
import * as path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';

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

const USER_NAMESPACE_PREFIX = 'user:';

/**
 * Metadata for a file artifact version.
 */
interface FileArtifactVersion extends ArtifactVersion {
  fileName?: string;
}

/**
 * Service for managing artifacts stored on the local filesystem.
 *
 * Stores filesystem-backed artifacts beneath a configurable root directory.
 *
 * Storage layout matches the cloud and in-memory services:
 * root/
 * └── users/
 *     └── {userId}/
 *         ├── sessions/
 *         │   └── {sessionId}/
 *         │       └── artifacts/
 *         │           └── {artifactPath}/  // derived from filename
 *         │               └── versions/
 *         │                   └── {version}/
 *         │                       ├── {originalFilename}
 *         │                       └── metadata.json
 *         └── artifacts/
 *             └── {artifactPath}/...
 *
 * Artifact paths are derived from the provided filenames: separators create
 * nested directories, and path traversal is rejected to keep the layout
 * portable across filesystems. `{artifactPath}` therefore mirrors the
 * sanitized, scope-relative path derived from each filename.
 */
export class FileArtifactService implements BaseArtifactService {
  private readonly rootDir: string;

  constructor(rootDirOrUri: string) {
    try {
      const rootDir = rootDirOrUri.startsWith('file://')
        ? fileURLToPath(rootDirOrUri)
        : rootDirOrUri;
      this.rootDir = path.resolve(rootDir);
    } catch (e) {
      throw new Error(`Invalid root directory: ${rootDirOrUri}`, {cause: e});
    }
  }

  async saveArtifact({
    userId,
    sessionId,
    filename,
    artifact,
    customMetadata,
  }: SaveArtifactRequest): Promise<number> {
    if (!artifact.inlineData && !artifact.text) {
      throw new Error('Artifact must have either inlineData or text content.');
    }

    const artifactDir = getArtifactDir(
      this.rootDir,
      userId,
      sessionId,
      filename,
    );
    await fs.mkdir(artifactDir, {recursive: true});

    const versions = await getArtifactVersionsFromDir(artifactDir);
    const nextVersion =
      versions.length > 0 ? versions[versions.length - 1] + 1 : 0;

    const versionsDir = getVersionsDir(artifactDir);
    const versionDir = path.join(versionsDir, nextVersion.toString());
    await fs.mkdir(versionDir, {recursive: true});

    const storedFilename = path.basename(artifactDir); // using the directory name which is the sanitized filename
    const contentPath = path.join(versionDir, storedFilename);

    let mimeType: string | undefined;
    if (artifact.inlineData) {
      const data = artifact.inlineData.data || '';
      // GenAI SDK Part data is in Base64 format. See https://googleapis.github.io/js-genai/release_docs/interfaces/types.Part.html
      await fs.writeFile(contentPath, Buffer.from(data, 'base64'));
      mimeType = artifact.inlineData.mimeType || 'application/octet-stream';
    } else if (artifact.text !== undefined) {
      await fs.writeFile(contentPath, artifact.text, 'utf-8');
    }

    const canonicalUri = await getCanonicalUri(
      this.rootDir,
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
      customMetadata,
    };

    await writeMetadata(path.join(versionDir, 'metadata.json'), metadata);

    return nextVersion;
  }

  async loadArtifact({
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<Part | undefined> {
    try {
      const artifactDir = getArtifactDir(
        this.rootDir,
        userId,
        sessionId,
        filename,
      );

      try {
        await fs.access(artifactDir);
      } catch (e: unknown) {
        logger.warn(
          `[FileArtifactService] loadArtifact: Artifact ${filename} not found`,
          e,
        );
        return undefined;
      }

      const versions = await getArtifactVersionsFromDir(artifactDir);
      if (versions.length === 0) {
        return undefined;
      }

      let versionToLoad: number;
      if (version === undefined) {
        versionToLoad = versions[versions.length - 1];
      } else {
        if (!versions.includes(version)) {
          logger.warn(
            `[FileArtifactService] loadArtifact: Artifact ${filename} version ${version} not found`,
          );
          return undefined;
        }
        versionToLoad = version;
      }

      const versionDir = path.join(
        getVersionsDir(artifactDir),
        versionToLoad.toString(),
      );
      const metadataPath = path.join(versionDir, 'metadata.json');
      const metadata = await readMetadata(metadataPath);

      const storedFilename = path.basename(artifactDir);
      let contentPath = path.join(versionDir, storedFilename);

      if (metadata.canonicalUri) {
        const uriPath = fileUriToPath(metadata.canonicalUri);
        if (uriPath) {
          try {
            await fs.access(uriPath);
            contentPath = uriPath;
          } catch {
            logger.warn(
              `[FileArtifactService] loadArtifact: Artifact ${filename} missing at ${uriPath}, falling back to content path ${contentPath}`,
            );
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
          logger.warn(
            `[FileArtifactService] loadArtifact: Artifact ${filename} missing at ${contentPath}`,
          );
          return undefined;
        }
      }

      try {
        const text = await fs.readFile(contentPath, 'utf-8');
        return {text};
      } catch {
        logger.warn(
          `[FileArtifactService] loadArtifact: Text artifact ${filename} missing at ${contentPath}`,
        );
        return undefined;
      }
    } catch (e) {
      logger.error(
        `[FileArtifactService] loadArtifact: Error loading artifact ${filename}`,
        e,
      );
      return undefined;
    }
  }

  async listArtifactKeys({
    userId,
    sessionId,
  }: ListArtifactKeysRequest): Promise<string[]> {
    const filenames: Set<string> = new Set();
    const userRoot = getUserRoot(this.rootDir, userId);

    // Session artifacts
    const sessionRoot = getSessionArtifactsDir(userRoot, sessionId);
    for await (const artifactDir of iterateArtifactDirs(sessionRoot)) {
      const metadata = await getLatestMetadata(artifactDir);
      if (metadata?.fileName) {
        filenames.add(metadata.fileName);
      } else {
        const rel = path.relative(sessionRoot, artifactDir);
        filenames.add(asPosixPath(rel));
      }
    }

    // User artifacts
    const artifactsRoot = getUserArtifactsDir(userRoot);
    for await (const artifactDir of iterateArtifactDirs(artifactsRoot)) {
      const metadata = await getLatestMetadata(artifactDir);
      if (metadata?.fileName) {
        filenames.add(metadata.fileName);
      } else {
        const rel = path.relative(artifactsRoot, artifactDir);
        filenames.add(`${USER_NAMESPACE_PREFIX}${asPosixPath(rel)}`);
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
      const artifactDir = getArtifactDir(
        this.rootDir,
        userId,
        sessionId,
        filename,
      );
      await fs.rm(artifactDir, {recursive: true, force: true});
    } catch (e) {
      logger.warn(
        `[FileArtifactService] deleteArtifact: Failed to delete artifact ${filename}`,
        e,
      );
    }
  }

  async listVersions({
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<number[]> {
    try {
      const artifactDir = getArtifactDir(
        this.rootDir,
        userId,
        sessionId,
        filename,
      );
      return await getArtifactVersionsFromDir(artifactDir);
    } catch (e) {
      logger.warn(
        `[FileArtifactService] listVersions: Failed to list versions for artifact ${filename}`,
        e,
      );
      return [];
    }
  }

  async listArtifactVersions({
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<ArtifactVersion[]> {
    try {
      const artifactDir = getArtifactDir(
        this.rootDir,
        userId,
        sessionId,
        filename,
      );
      const versions = await getArtifactVersionsFromDir(artifactDir);
      const artifactVersions: ArtifactVersion[] = [];

      for (const version of versions) {
        const metadataPath = path.join(
          getVersionsDir(artifactDir),
          version.toString(),
          'metadata.json',
        );
        try {
          const metadata = await readMetadata(metadataPath);
          artifactVersions.push(metadata);
        } catch (e) {
          logger.warn(
            `[FileArtifactService] listArtifactVersions: Failed to read artifact version ${version} at ${artifactDir}`,
            e,
          );
        }
      }
      return artifactVersions;
    } catch (e) {
      logger.warn(
        `[FileArtifactService] listArtifactVersions: Failed to list artifact versions for userId: ${userId} sessionId: ${sessionId} filename: ${filename}`,
        e,
      );
      return [];
    }
  }

  async getArtifactVersion({
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<ArtifactVersion | undefined> {
    try {
      const artifactDir = getArtifactDir(
        this.rootDir,
        userId,
        sessionId,
        filename,
      );

      const versions = await getArtifactVersionsFromDir(artifactDir);
      if (versions.length === 0) {
        return undefined;
      }

      let versionToRead: number;
      if (version === undefined) {
        versionToRead = versions[versions.length - 1];
      } else {
        if (!versions.includes(version)) {
          return undefined;
        }
        versionToRead = version;
      }

      const metadataPath = path.join(
        getVersionsDir(artifactDir),
        versionToRead.toString(),
        'metadata.json',
      );
      return await readMetadata(metadataPath);
    } catch (e) {
      logger.warn(
        `[FileArtifactService] getArtifactVersion: Failed to get artifact version for userId: ${userId} sessionId: ${sessionId} filename: ${filename} version: ${version}`,
        e,
      );
      return undefined;
    }
  }
}

function getUserRoot(rootDir: string, userId: string): string {
  return path.join(rootDir, 'users', userId);
}

function isUserScoped(
  sessionId: string | undefined,
  filename: string,
): boolean {
  return !sessionId || filename.startsWith(USER_NAMESPACE_PREFIX);
}

function getUserArtifactsDir(userRoot: string): string {
  return path.join(userRoot, 'artifacts');
}

function getSessionArtifactsDir(baseRoot: string, sessionId: string): string {
  return path.join(baseRoot, 'sessions', sessionId, 'artifacts');
}

function getVersionsDir(artifactDir: string): string {
  return path.join(artifactDir, 'versions');
}

/**
 * Gets the artifact directory full path for a given artifact keys.
 *
 * @param rootDir The root directory.
 * @param userId The user ID.
 * @param sessionId The session ID.
 * @param filename The filename.
 * @returns The artifact directory path.
 */
function getArtifactDir(
  rootDir: string,
  userId: string,
  sessionId: string,
  filename: string,
): string {
  const userRoot = getUserRoot(rootDir, userId);
  let scopeRoot: string;

  if (isUserScoped(sessionId, filename)) {
    scopeRoot = getUserArtifactsDir(userRoot);
  } else {
    if (!sessionId) {
      throw new Error(
        'Session ID must be provided for session-scoped artifacts.',
      );
    }
    scopeRoot = getSessionArtifactsDir(userRoot, sessionId);
  }

  let cleanFilename = filename;
  if (cleanFilename.startsWith(USER_NAMESPACE_PREFIX)) {
    cleanFilename = cleanFilename.substring(USER_NAMESPACE_PREFIX.length);
  }
  cleanFilename = cleanFilename.trim();

  if (path.isAbsolute(cleanFilename)) {
    throw new Error(`Absolute artifact filename ${filename} is not permitted.`);
  }

  const artifactDir = path.resolve(scopeRoot, cleanFilename);
  const relative = path.relative(scopeRoot, artifactDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Artifact filename ${filename} escapes storage directory.`);
  }
  if (relative === '' || relative === '.') {
    return path.join(scopeRoot, 'artifact');
  }

  return artifactDir;
}

/**
 * Gets the artifact versions from the artifact directory.
 *
 * @param artifactDir The artifact directory.
 * @returns A promise that resolves to an array of artifact versions.
 */
async function getArtifactVersionsFromDir(
  artifactDir: string,
): Promise<number[]> {
  const versionsDir = getVersionsDir(artifactDir);
  try {
    const files = await fs.readdir(versionsDir, {withFileTypes: true});
    const versions = files
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => parseInt(dirent.name, 10))
      .filter((v) => !isNaN(v));
    return versions.sort((a, b) => a - b);
  } catch (e) {
    logger.warn(
      `[FileArtifactService] getArtifactVersionsFromDir: Failed to list artifact versions from ${artifactDir}`,
      e,
    );
    return [];
  }
}

/**
 * Gets the canonical URI for an artifact version.
 *
 * @param rootDir The root directory.
 * @param userId The user ID.
 * @param sessionId The session ID.
 * @param filename The filename.
 * @param version The version.
 * @returns A promise that resolves to the canonical URI.
 */
async function getCanonicalUri(
  rootDir: string,
  userId: string,
  sessionId: string,
  filename: string,
  version: number,
): Promise<string> {
  const artifactDir = await getArtifactDir(
    rootDir,
    userId,
    sessionId,
    filename,
  );
  const storedFilename = path.basename(artifactDir);
  const versionsDir = getVersionsDir(artifactDir);
  const payloadPath = path.join(
    versionsDir,
    version.toString(),
    storedFilename,
  );
  return pathToFileURL(payloadPath).toString();
}

/**
 * Writes the metadata to the metadata file.
 *
 * @param metadataPath The path to the metadata file.
 * @param metadata The metadata to write.
 */
async function writeMetadata(
  metadataPath: string,
  metadata: FileArtifactVersion,
): Promise<void> {
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
}

/**
 * Reads the metadata from the metadata file.
 *
 * @param metadataPath The path to the metadata file.
 * @returns A promise that resolves to the metadata.
 */
async function readMetadata(
  metadataPath: string,
): Promise<FileArtifactVersion> {
  const content = await fs.readFile(metadataPath, 'utf-8');
  return JSON.parse(content) as FileArtifactVersion;
}

/**
 * Gets the latest metadata for an artifact.
 *
 * @param artifactDir The artifact directory.
 * @returns A promise that resolves to the latest metadata.
 */
async function getLatestMetadata(
  artifactDir: string,
): Promise<FileArtifactVersion | undefined> {
  const versions = await getArtifactVersionsFromDir(artifactDir);
  if (versions.length === 0) {
    return undefined;
  }
  const latestVersion = versions[versions.length - 1];
  const metadataPath = path.join(
    getVersionsDir(artifactDir),
    latestVersion.toString(),
    'metadata.json',
  );
  try {
    return await readMetadata(metadataPath);
  } catch (e) {
    logger.warn(
      `[FileArtifactService] getLatestMetadata: Failed to read metadata from ${metadataPath}`,
      e,
    );
    return undefined;
  }
}

/**
 * Iterates over artifact directories.
 *
 * @param dir The directory to iterate over.
 * @returns An async generator that yields artifact directories.
 */
async function* iterateArtifactDirs(dir: string): AsyncGenerator<string> {
  try {
    const entries = await fs.readdir(dir, {withFileTypes: true});
    const hasVersions = entries.some(
      (e) => e.isDirectory() && e.name === 'versions',
    );

    if (hasVersions) {
      yield dir;
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subdir = path.join(dir, entry.name);
        for await (const foundDir of iterateArtifactDirs(subdir)) {
          yield foundDir;
        }
      }
    }
  } catch (_e: unknown) {
    // ignore access errors
  }
}

/**
 * Converts a file URI to a path.
 *
 * @param uri The file URI.
 * @returns The path.
 */
function fileUriToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch (e) {
    logger.warn(
      `[FileArtifactService] fileUriToPath: Failed to convert file URI to path: ${uri}`,
      e,
    );

    return undefined;
  }
}

/**
 * Converts a path to a POSIX path.
 *
 * Used for ensuring paths use forward slashes (/), regardless of the operating system.
 *
 * @param p The path.
 * @returns The POSIX path.
 */
function asPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}
