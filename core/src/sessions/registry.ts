/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseSessionService} from './base_session_service.js';
import {
  InMemorySessionService,
  isInMemoryConnectionString,
} from './in_memory_session_service.js';

export function getSessionServiceFromUri(uri: string): BaseSessionService {
  if (isInMemoryConnectionString(uri)) {
    return new InMemorySessionService();
  }

  throw new Error(`Unsupported session service URI: ${uri}`);
}
