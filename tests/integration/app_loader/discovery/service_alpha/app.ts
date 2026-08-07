/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {App, LlmAgent} from '@google/adk';

export const app = new App({
  name: 'alpha_app',
  rootAgent: new LlmAgent({
    name: 'alpha_agent',
    model: 'test-model',
  }),
});
