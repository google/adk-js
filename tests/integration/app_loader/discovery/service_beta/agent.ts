/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'beta_agent',
  model: 'test-model',
});
