/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {ArtifactVersion, BaseArtifactService} from './base_artifact_service.js';

export interface SessionSaveArtifactRequest {
  filename: string;
  artifact: Part;
  customMetadata?: Record<string, unknown>;
}

export interface SessionLoadArtifactRequest {
  filename: string;
  version?: number;
}

export interface SessionArtifactService {
  saveArtifact(request: SessionSaveArtifactRequest): Promise<number>;
  loadArtifact(request: SessionLoadArtifactRequest): Promise<Part | undefined>;
  listArtifactKeys(): Promise<string[]>;
  deleteArtifact(filename: string): Promise<void>;
  listVersions(filename: string): Promise<number[]>;
  listArtifactVersions(filename: string): Promise<ArtifactVersion[]>;
  getArtifactVersion(
    request: SessionLoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined>;
}

/**
 * A unique symbol to identify session-scoped artifact services.
 *
 * Implementations of {@link SessionArtifactService} brand themselves with this
 * symbol so they can be told apart from a `BaseArtifactService` at runtime.
 * The symbol is intentionally not exported: implementations living in other
 * modules declare their own module-private constant with the same key, which
 * the global symbol registry (`Symbol.for`) guarantees to be the same symbol.
 */
const SESSION_ARTIFACT_SERVICE_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.sessionArtifactService',
);

/**
 * Type guard to check if an object implements SessionArtifactService.
 *
 * @param service The artifact service to check.
 * @returns True if the service is a session-scoped artifact service.
 */
export function isSessionArtifactService(
  service: BaseArtifactService | SessionArtifactService,
): service is SessionArtifactService {
  return (
    typeof service === 'object' &&
    service !== null &&
    SESSION_ARTIFACT_SERVICE_SIGNATURE_SYMBOL in service &&
    service[SESSION_ARTIFACT_SERVICE_SIGNATURE_SYMBOL] === true
  );
}
