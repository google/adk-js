/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/core/empty_agent.
 *
 * Ported as literally as the two APIs allow: same agent name, no instruction,
 * no tools. The Python sample also omits `model`; the harness pins it on both
 * sides so the two runtimes' differing defaults are not what is measured.
 */
import {LlmAgent} from '@google/adk';

import {PARITY_MODEL} from '../model.ts';

export const rootAgent = new LlmAgent({
  name: 'empty_agent',
  model: PARITY_MODEL,
});
