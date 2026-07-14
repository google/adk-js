/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {App, LlmAgent} from '@google/adk';

export const app = new App({
  name: 'standalone_app_name',
  rootAgent: new LlmAgent({
    name: 'standalone_app_agent',
    model: 'test-model',
  }),
});
