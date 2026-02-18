/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

/**
 * The parameters for `saveArtifact`.
 */
export interface SaveArtifactRequest {
  /** The app name. */
  appName: string;
  /** The user ID. */
  userId: string;
  /** The session ID. */
  sessionId: string;
  /** The filename of the artifact. */
  filename: string;
  /** The artifact to save. */
  artifact: Part;
  /**
   * Optional custom metadata to save with the artifact.
   */
  customMetadata?: Record<string, unknown>;
}

/**
 * The parameters for `loadArtifact`.
 */
export interface LoadArtifactRequest {
  /** The app name. */
  appName: string;
  /** The user ID. */
  userId: string;
  /** The session ID. */
  sessionId: string;
  /** The filename of the artifact. */
  filename: string;
  /**
   * The version of the artifact to load. If not provided, the latest version
   * of the artifact is loaded.
   */
  version?: number;
}

/**
 * The parameters for `listArtifactKeys`.
 */
export interface ListArtifactKeysRequest {
  /** The app name. */
  appName: string;
  /** The user ID. */
  userId: string;
  /** The session ID. */
  sessionId: string;
}

/**
 * The parameters for `deleteArtifact`.
 */
export interface DeleteArtifactRequest {
  /** The app name. */
  appName: string;
  /** The user ID. */
  userId: string;
  /** The session ID. */
  sessionId: string;
  /** The filename of the artifact. */
  filename: string;
}

/**
 * The parameters for `listVersions`.
 */
export interface ListVersionsRequest {
  /** The app name. */
  appName: string;
  /** The user ID. */
  userId: string;
  /** The session ID. */
  sessionId: string;
  /** The filename of the artifact. */
  filename: string;
}

/**
 * Metadata for a file artifact version.
 */
export interface ArtifactVersion {
  /** The version number. */
  version: number;
  /** The canonical URI of the artifact. */
  canonicalUri?: string;
  /** Custom metadata associated with the artifact. */
  customMetadata?: Record<string, unknown>;
  /** The MIME type of the artifact. */
  mimeType?: string;
}

/**
 *  Interface for artifact services.
 */
export interface BaseArtifactService {
  /**
   * Saves an artifact to the artifact service storage.
   *
   * The artifact is a file identified by the app name, user ID, session ID, and
   * filename. After saving the artifact, a revision ID is returned to identify
   * the artifact version.
   *
   * @param request The request to save an artifact.
   * @return A promise that resolves to The revision ID. The first version of
   * the artifact has a revision ID of 0. This is incremented by 1 after each
   * successful save.
   */
  saveArtifact(request: SaveArtifactRequest): Promise<number>;

  /**
   * Gets an artifact from the artifact service storage.
   *
   * The artifact is a file identified by the app name, user ID, session ID, and
   * filename.
   *
   * @param request The request to load an artifact.
   * @return A promise that resolves to the artifact or undefined if not found.
   */
  loadArtifact(request: LoadArtifactRequest): Promise<Part | undefined>;

  /**
   * Lists all the artifact filenames within a session.
   *
   * @param request The request to list artifact keys.
   * @return A promise that resolves to a list of all artifact filenames within
   *     a session.
   */
  listArtifactKeys(request: ListArtifactKeysRequest): Promise<string[]>;

  /**
   * Deletes an artifact.
   *
   * @param request The request to delete an artifact.
   * @return A promise that resolves when the artifact is deleted.
   */
  deleteArtifact(request: DeleteArtifactRequest): Promise<void>;

  /**
   * Lists all versions of an artifact.
   *
   * @param request The request to list versions.
   * @return A promise that resolves to a list of all available versions of the
   *     artifact.
   */
  listVersions(request: ListVersionsRequest): Promise<number[]>;

  /**
   * Lists metadata for each artifact version.
   *
   * @param request The request to list artifact versions.
   * @return A promise that resolves to a list of artifact version metadata.
   */
  listArtifactVersions(
    request: ListVersionsRequest,
  ): Promise<ArtifactVersion[]>;

  /**
   * Gets metadata for a specific artifact version.
   *
   * @param request The request to get an artifact version.
   * @return A promise that resolves to the artifact version metadata or undefined.
   */
  getArtifactVersion(
    request: LoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined>;
}
