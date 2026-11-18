/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {redactUriPassword} from '../utils/redact_uri.js';
import {BaseSessionService} from './base_session_service.js';
import {
  DatabaseSessionService,
  type DatabaseSessionServiceOptions,
  isDatabaseConnectionString,
} from './database_session_service.js';
import {
  InMemorySessionService,
  isInMemoryConnectionString,
} from './in_memory_session_service.js';
import {
  VertexAiSessionService,
  isVertexAiConnectionString,
} from './vertex_ai_session_service.js';

/**
 * Resolves a session service instance from a connection URI.
 *
 * @param uri Session service connection URI.
 * @param sessionDbOptions Optional configuration forwarded to
 *     {@link DatabaseSessionService} when `uri` is a database URI.
 * @returns An instance of {@link BaseSessionService}.
 */
export function getSessionServiceFromUri(
  uri: string,
  sessionDbOptions?: DatabaseSessionServiceOptions,
): BaseSessionService {
  if (isInMemoryConnectionString(uri)) {
    return new InMemorySessionService();
  }

  if (isDatabaseConnectionString(uri)) {
    return new DatabaseSessionService(uri, sessionDbOptions);
  }

  if (isVertexAiConnectionString(uri)) {
    // uri is something like vertexai://projects/abc/locations/us-central1
    return new VertexAiSessionService({
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION,
      agentEngineId: process.env.GOOGLE_CLOUD_AGENT_ENGINE_ID,
    });
  }

  throw new Error(`Unsupported session service URI: ${redactUriPassword(uri)}`);
}
