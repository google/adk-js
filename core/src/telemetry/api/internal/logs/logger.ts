/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logs, type Logger} from '@opentelemetry/api-logs';

import {version} from '../../../../version.js';
import {GEN_AI_SYSTEM_VALUE} from '../common/attributes.js';

/**
 * Returns the OpenTelemetry logger for ADK instrumentation scopes from the
 * active global logger provider.
 */
export function getTelemetryLogger(): Logger {
  return logs.getLogger(GEN_AI_SYSTEM_VALUE, version);
}
