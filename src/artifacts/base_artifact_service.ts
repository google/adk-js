/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

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
   * @param appName The app name.
   * @param userId The user ID.
   * @param sessionId The session ID.
   * @param filename The filename of the artifact.
   * @param artifact The artifact to save.
   * @return A promise that resolves to The revision ID. The first version of
   * the artifact has a revision ID of 0. This is incremented by 1 after each
   * successful save.
   */
  saveArtifact(
      appName: string,
      userId: string,
      sessionId: string,
      filename: string,
      artifact: Part,
      ): Promise<number>;

  /**
   * Gets an artifact from the artifact service storage.
   *
   * The artifact is a file identified by the app name, user ID, session ID, and
   * filename.
   *
   * @param appName The app name.
   * @param userId The user ID.
   * @param sessionId The session ID.
   * @param filename The filename of the artifact.
   * @param version The version of the artifact to load. If not provided, the
   *     latest version of the artifact is loaded.
   * @return A promise that resolves to the artifact or undefined if not found.
   */
  loadArtifact(
      appName: string,
      userId: string,
      sessionId: string,
      filename: string,
      version?: number,
      ): Promise<Part|undefined>;

  /**
   * Lists all the artifact filenames within a session.
   *
   * @param appName The app name.
   * @param userId The user ID.
   * @param sessionId The session ID.
   * @return A promise that resolves to a list of all artifact filenames within
   *     a session.
   */
  listArtifactKeys(
      appName: string,
      userId: string,
      sessionId: string,
      ): Promise<string[]>;

  /**
   * Deletes an artifact.
   *
   * @param appName The app name.
   * @param userId The user ID.
   * @param sessionId The session ID.
   * @param filename The filename of the artifact.
   * @return A promise that resolves when the artifact is deleted.
   */
  deleteArtifact(
      appName: string,
      userId: string,
      sessionId: string,
      filename: string,
      ): Promise<void>;

  /**
   * Lists all versions of an artifact.
   *
   * @param appName The app name.
   * @param userId The user ID.
   * @param sessionId The session ID.
   * @param filename The filename of the artifact.
   * @return A promise that resolves to a list of all available versions of the
   *     artifact.
   */
  listVersions(
      appName: string,
      userId: string,
      sessionId: string,
      filename: string,
      ): Promise<number[]>;
}
