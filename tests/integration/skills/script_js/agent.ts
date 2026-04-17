/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LlmAgent,
  loadSkillFromDir,
  SkillToolset,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  GeminiWithMockResponses,
  type RawGenerateContentResponse,
} from '../../test_case_utils.js';
import modelResponses from './model_responses.json' with {type: 'json'};

const skill = await loadSkillFromDir(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../skills/algorithmic-art',
  ),
);

export const rootAgent = new LlmAgent({
  name: 'test_algorithmic_art_skill_agent',
  description: 'An agent to test skills.',
  model: new GeminiWithMockResponses(
    modelResponses as RawGenerateContentResponse[],
  ),
  tools: [
    new SkillToolset([skill], {
      codeExecutor: new UnsafeLocalCodeExecutor(),
    }),
  ],
});
