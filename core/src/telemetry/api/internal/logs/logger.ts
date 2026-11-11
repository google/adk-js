/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logs, type Logger} from '@opentelemetry/api-logs';

import {version} from '../../../../version.js';
import {GEN_AI_SYSTEM_VALUE, SCHEMA_URL} from '../common/attributes.js';

/**
 * Returns the ADK logger from the global `LoggerProvider`.
 *
 * Resolved on every call rather than once at import, so records reach a
 * provider the application registers after importing ADK.
 */
export function getTelemetryLogger(): Logger {
  return logs.getLogger(GEN_AI_SYSTEM_VALUE, version, {schemaUrl: SCHEMA_URL});
}
