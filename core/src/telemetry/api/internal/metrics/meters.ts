/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {metrics, type Meter} from '@opentelemetry/api';

import {version} from '../../../../version.js';
import {GEN_AI_SYSTEM_VALUE} from '../common/attributes.js';

/**
 * Returns the OpenTelemetry meter for ADK instrumentation scopes from the
 * active global meter provider.
 */
export function getTelemetryMeter(): Meter {
  return metrics.getMeter(GEN_AI_SYSTEM_VALUE, version);
}
