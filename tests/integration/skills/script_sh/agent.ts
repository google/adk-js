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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillsDir = path.resolve(__dirname, '../skills/gh-issues');
const skill = await loadSkillFromDir(skillsDir);

export const rootAgent = new LlmAgent({
  name: 'test_sh_skill_agent',
  description: 'An agent to test skills.',
  model: 'gemini-3.1-pro-preview',
  tools: [
    new SkillToolset([skill], {
      codeExecutor: new UnsafeLocalCodeExecutor(),
    }),
  ],
});
